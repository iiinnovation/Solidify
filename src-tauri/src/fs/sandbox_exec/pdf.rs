//! Fixed, sequential PDF → PNG → OCR. All subprocesses share one deadline and
//! stdout/stderr budget; every page is inspected before any rasterization.
use super::{
    components::VerifiedComponents, ocr, policy::ProcessJob, results::PageCollector,
    staging::StagedInput, supervisor, types::*, worker::ProcessOutput,
};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn malformed() -> SandboxError {
    SandboxError::new(FailureCode::RenderFailed, "PDF 页数或尺寸探测结果无效")
}

fn inspect(bytes: &[u8], limits: &ExecutionLimits) -> Result<u32, SandboxError> {
    let text = std::str::from_utf8(bytes).map_err(|_| malformed())?;
    let mut count = None;
    let mut encryption = None;
    let mut sizes = BTreeMap::new();
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("Pages:") {
            if count.is_some() {
                return Err(malformed());
            }
            count = Some(value.trim().parse::<u32>().map_err(|_| malformed())?);
        } else if let Some(value) = line.strip_prefix("Encrypted:") {
            if encryption.is_some() {
                return Err(malformed());
            }
            encryption = Some(match value.trim().split_whitespace().next() {
                Some("yes") => true,
                Some("no") if value.trim() == "no" => false,
                _ => return Err(malformed()),
            });
        } else if let Some(value) = line.strip_prefix("Page ") {
            let parts: Vec<_> = value.split_whitespace().collect();
            if parts.get(1) != Some(&"size:") {
                continue;
            }
            if parts.len() < 6 || parts[3] != "x" || parts[5] != "pts" {
                return Err(malformed());
            }
            let page = parts[0].parse::<u32>().map_err(|_| malformed())?;
            let width = parts[2].parse::<f64>().map_err(|_| malformed())?;
            let height = parts[4].parse::<f64>().map_err(|_| malformed())?;
            if !width.is_finite()
                || !height.is_finite()
                || width <= 0.0
                || height <= 0.0
                || sizes.insert(page, (width, height)).is_some()
            {
                return Err(malformed());
            }
        }
    }
    if encryption.ok_or_else(malformed)? {
        return Err(SandboxError::new(
            FailureCode::Encrypted,
            "首版不处理加密 PDF",
        ));
    }
    let count = count.ok_or_else(malformed)?;
    if count == 0 || count > limits.max_pages {
        return Err(SandboxError::new(
            FailureCode::PageLimit,
            "PDF 页数超过计划预算或没有页面",
        ));
    }
    if sizes.len() != count as usize {
        return Err(malformed());
    }
    for page in 1..=count {
        let (width, height) = sizes.get(&page).ok_or_else(malformed)?;
        // pdfinfo prints crop dimensions in points. pdftoppm uses the same box
        // and a fixed 150 DPI. A conservative margin covers printed precision.
        let pixels = (width * 150.0 / 72.0 + 1.0).ceil() * (height * 150.0 / 72.0 + 1.0).ceil();
        if pixels > limits.max_page_pixels as f64 {
            return Err(SandboxError::new(
                FailureCode::PixelLimit,
                "PDF 页面渲染像素超过预算",
            ));
        }
    }
    Ok(count)
}

fn path_string(path: &Path) -> Result<String, SandboxError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| SandboxError::new(FailureCode::InvalidInput, "转换路径编码无效"))
}

fn read_render(path: &Path, limit: u64) -> Result<Vec<u8>, SandboxError> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| malformed())?;
    let metadata = file.metadata().map_err(|_| malformed())?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(malformed());
    }
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| malformed())?;
    if bytes.len() as u64 > limit {
        return Err(SandboxError::new(
            FailureCode::WorkspaceLimit,
            "PDF 渲染文件超限",
        ));
    }
    Ok(bytes)
}

pub fn extract_pdf(
    worker: &Path,
    components: &VerifiedComponents,
    staged: &StagedInput,
    execution_id: &str,
    relative_path: &str,
    limits: ExecutionLimits,
    check: impl Fn() -> Result<(), SandboxError>,
    on_stop_delay: impl Fn(),
) -> Result<ExtractedDocument, SandboxError> {
    extract_pdf_with_progress(
        worker,
        components,
        staged,
        execution_id,
        relative_path,
        limits,
        check,
        on_stop_delay,
        |_, _| Ok(()),
        None,
    )
}

pub fn extract_pdf_with_progress(
    worker: &Path,
    components: &VerifiedComponents,
    staged: &StagedInput,
    execution_id: &str,
    relative_path: &str,
    limits: ExecutionLimits,
    check: impl Fn() -> Result<(), SandboxError>,
    on_stop_delay: impl Fn(),
    progress: impl FnMut(u32, u32) -> Result<(), SandboxError>,
    task_lock: Option<&std::fs::File>,
) -> Result<ExtractedDocument, SandboxError> {
    extract_with(
        components,
        staged,
        execution_id,
        relative_path,
        limits,
        &check,
        progress,
        |job| supervisor::run_with_task_lock(worker, job, &check, &on_stop_delay, task_lock),
    )
}

fn extract_with(
    components: &VerifiedComponents,
    staged: &StagedInput,
    execution_id: &str,
    relative_path: &str,
    limits: ExecutionLimits,
    check: impl Fn() -> Result<(), SandboxError>,
    mut progress: impl FnMut(u32, u32) -> Result<(), SandboxError>,
    mut run: impl FnMut(&ProcessJob) -> Result<ProcessOutput, SandboxError>,
) -> Result<ExtractedDocument, SandboxError> {
    let started = Instant::now();
    check()?;
    let (info, renderer, version) = components.pdf_tools()?;
    components.revalidate()?;
    let source = ocr::snapshot_bytes(staged, &limits)?;
    if !source.starts_with(b"%PDF-")
        || staged.input.extension().and_then(|v| v.to_str()) != Some("pdf")
    {
        return Err(SandboxError::new(
            FailureCode::InvalidInput,
            "文件不是已确认的 PDF 类型",
        ));
    }
    drop(source);
    let mut total_bytes = 0usize;
    let mut diagnostics = false;
    let mut step =
        |binary: PathBuf, args: Vec<String>, code: FailureCode| -> Result<Vec<u8>, SandboxError> {
            check()?;
            let remaining = limits
                .wall
                .checked_sub(started.elapsed())
                .filter(|value| value.as_millis() > 0)
                .ok_or_else(|| SandboxError::new(FailureCode::TimedOut, "PDF 转换超过整次预算"))?;
            let output_budget = limits.max_output_bytes.saturating_sub(total_bytes);
            if output_budget == 0 {
                return Err(SandboxError::new(
                    FailureCode::OutputLimit,
                    "PDF 合计输出超过预算",
                ));
            }
            let job = ProcessJob {
                binary,
                args,
                input: staged.input.clone(),
                work: staged.work.clone(),
                runtime_read: components.runtime_files(),
                wall_ms: remaining.as_millis().min(120_000) as u64,
                cpu_seconds: limits.cpu_seconds,
                max_file_bytes: limits.max_file_bytes,
                max_work_bytes: limits.max_work_bytes,
                max_output_bytes: output_budget,
            };
            job.validate()?;
            let output = run(&job)?;
            check()?;
            if started.elapsed() >= limits.wall {
                return Err(SandboxError::new(
                    FailureCode::TimedOut,
                    "PDF 转换超过整次预算",
                ));
            }
            total_bytes = total_bytes
                .saturating_add(output.stdout.len())
                .saturating_add(output.stderr.len());
            if total_bytes > limits.max_output_bytes {
                return Err(SandboxError::new(
                    FailureCode::OutputLimit,
                    "PDF 合计输出超过预算",
                ));
            }
            if output.exit_code != Some(0) {
                // Poppler's password-open failure is exit 1; exit 3 denotes PDF
                // permission failure. Match the fixed diagnostic, not every error.
                let password = output
                    .stderr
                    .windows(b"Incorrect password".len())
                    .any(|w| w == b"Incorrect password");
                let code = if code == FailureCode::RenderFailed
                    && (output.exit_code == Some(3) || password)
                {
                    FailureCode::Encrypted
                } else {
                    code
                };
                return Err(SandboxError::new(
                    code,
                    "PDF 转换子步骤失败，未接受不完整文本",
                ));
            }
            diagnostics |= !output.stderr.is_empty();
            Ok(output.stdout)
        };
    let input = path_string(&staged.input)?;
    let metadata = step(
        info,
        vec![
            "-f".into(),
            "1".into(),
            "-l".into(),
            limits.max_pages.to_string(),
            input.clone(),
        ],
        FailureCode::RenderFailed,
    )?;
    let pages = inspect(&metadata, &limits)?;
    progress(0, pages)?;
    let mut collector = PageCollector::new(pages, limits.clone())?;
    for page in 1..=pages {
        let prefix = staged.work.join(format!("page-{page}"));
        let image = prefix.with_extension("png");
        if std::fs::symlink_metadata(&image).is_ok() {
            return Err(malformed());
        }
        step(
            renderer.clone(),
            vec![
                "-f".into(),
                page.to_string(),
                "-l".into(),
                page.to_string(),
                "-r".into(),
                "150".into(),
                "-cropbox".into(),
                "-singlefile".into(),
                "-png".into(),
                input.clone(),
                path_string(&prefix)?,
            ],
            FailureCode::RenderFailed,
        )?;
        let bytes = read_render(&image, limits.max_file_bytes)?;
        ocr::image_dimensions(&bytes, "png", limits.max_page_pixels)?;
        drop(bytes);
        let text = step(
            components.tesseract(),
            ocr::fixed_args(&image, &components.tessdata())?,
            FailureCode::OcrFailed,
        )?;
        collector.push(page, text)?;
        // Exact generated filename only; this step runs after converter reap.
        std::fs::remove_file(&image)
            .map_err(|_| SandboxError::new(FailureCode::Io, "无法清理 PDF 中间页面"))?;
        progress(page, pages)?;
    }
    let mut warnings = vec![];
    if diagnostics {
        warnings.push("PDF 转换器返回诊断信息，请审阅结果".into());
    }
    let document = collector.finish(ExtractedDocument {
        execution_id: execution_id.into(),
        relative_path: relative_path.into(),
        source_hash: staged.source_hash.clone(),
        method: ExtractMethod::PdfOcr,
        parser_version: format!(
            "poppler:{version};tesseract:{}",
            components.parser_version()
        ),
        language_versions: components.language_versions(),
        pages: vec![],
        complete: false,
        warnings,
        duration_ms: started.elapsed().as_millis() as u64,
    })?;
    check()?;
    if started.elapsed() >= limits.wall {
        return Err(SandboxError::new(
            FailureCode::TimedOut,
            "PDF 转换超过整次预算",
        ));
    }
    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageEncoder;
    use sha2::{Digest, Sha256};

    #[test]
    fn pipeline_is_sequential_cleans_pages_and_shares_output_budget() {
        use super::super::{components::tests::fixture, staging::StagingRoot};
        let owner = StagingRoot::create().unwrap();
        let bytes = b"%PDF-fixture";
        let hash = format!("{:x}", Sha256::digest(bytes));
        let staged = owner.stage(bytes, &hash, "pdf", 1024).unwrap();
        let package = owner.stage(bytes, &hash, "pdf", 1024).unwrap();
        let mut manifest = fixture(&package.work);
        manifest.pdfinfo = Some(manifest.tesseract.clone());
        manifest.pdftoppm = Some(manifest.tesseract.clone());
        manifest.poppler_version = Some("fixture".into());
        let components = VerifiedComponents::verify(&package.work, manifest).unwrap();
        let mut observed = Vec::new();
        let mut calls = 0;
        let mut last_budget = usize::MAX;
        let mut last_wall = u64::MAX;
        let result = extract_with(
            &components,
            &staged,
            "execution",
            "scan.pdf",
            ExecutionLimits::default(),
            || Ok(()),
            |completed, total| {
                if completed > 0 {
                    assert!(!staged.work.join(format!("page-{completed}.png")).exists());
                }
                observed.push((completed, total));
                Ok(())
            },
            |job| {
                calls += 1;
                assert!(job.max_output_bytes <= last_budget);
                assert!(job.wall_ms <= last_wall);
                last_budget = job.max_output_bytes;
                last_wall = job.wall_ms;
                let stdout = match calls {
                    1 => {
                        b"Pages: 2\nEncrypted: no\nPage 1 size: 2 x 2 pts\nPage 2 size: 2 x 2 pts\n"
                            .to_vec()
                    }
                    2 | 4 => {
                        if calls == 4 {
                            assert!(!staged.work.join("page-1.png").exists());
                        }
                        assert!(job.args.contains(&"-cropbox".into()));
                        assert!(job.args.contains(&"150".into()));
                        let output = PathBuf::from(job.args.last().unwrap()).with_extension("png");
                        let mut png = Vec::new();
                        image::codecs::png::PngEncoder::new(&mut png)
                            .write_image(&[255; 12], 2, 2, image::ColorType::Rgb8)
                            .unwrap();
                        std::fs::write(output, png).unwrap();
                        vec![]
                    }
                    3 | 5 => "中文 text".as_bytes().to_vec(),
                    _ => panic!("unexpected step"),
                };
                Ok(ProcessOutput {
                    stdout,
                    stderr: vec![],
                    exit_code: Some(0),
                    duration_ms: 1,
                })
            },
        )
        .unwrap();
        assert_eq!(calls, 5);
        assert_eq!(observed, vec![(0, 2), (1, 2), (2, 2)]);
        assert_eq!(result.pages.len(), 2);
        assert!(result.complete);
        assert_eq!(result.source_hash, hash);
        assert!(!staged.work.join("page-2.png").exists());
        let ran = std::cell::Cell::new(false);
        let cancelled = extract_with(
            &components,
            &staged,
            "execution",
            "scan.pdf",
            ExecutionLimits::default(),
            || {
                if ran.get() {
                    Err(SandboxError::new(FailureCode::Cancelled, "cancelled"))
                } else {
                    Ok(())
                }
            },
            |_, _| panic!("cancelled metadata cannot publish progress"),
            |_| {
                ran.set(true);
                Ok(ProcessOutput {
                    stdout: vec![],
                    stderr: vec![],
                    exit_code: Some(0),
                    duration_ms: 1,
                })
            },
        );
        assert_eq!(cancelled.unwrap_err().code, FailureCode::Cancelled);
        let failed = extract_with(
            &components,
            &staged,
            "execution",
            "scan.pdf",
            ExecutionLimits::default(),
            || Ok(()),
            |_, _| panic!("failed metadata cannot publish progress"),
            |_| {
                Ok(ProcessOutput {
                    stdout: b"must not accept".to_vec(),
                    stderr: b"Incorrect password".to_vec(),
                    exit_code: Some(1),
                    duration_ms: 1,
                })
            },
        );
        assert_eq!(failed.unwrap_err().code, FailureCode::Encrypted);
        let mut calls_before_stop = 0;
        let stopped_at_progress = extract_with(
            &components,
            &staged,
            "execution",
            "scan.pdf",
            ExecutionLimits::default(),
            || Ok(()),
            |completed, total| {
                assert_eq!((completed, total), (0, 2));
                Err(SandboxError::new(
                    FailureCode::Cancelled,
                    "stopped before rendering",
                ))
            },
            |_| {
                calls_before_stop += 1;
                Ok(ProcessOutput {
                    stdout:
                        b"Pages: 2\nEncrypted: no\nPage 1 size: 2 x 2 pts\nPage 2 size: 2 x 2 pts\n"
                            .to_vec(),
                    stderr: vec![],
                    exit_code: Some(0),
                    duration_ms: 1,
                })
            },
        );
        assert_eq!(
            stopped_at_progress.unwrap_err().code,
            FailureCode::Cancelled
        );
        assert_eq!(
            calls_before_stop, 1,
            "cancelled progress must not start the renderer"
        );
    }

    #[test]
    fn requires_complete_unique_bounded_metadata() {
        let good = b"Pages: 2\nEncrypted: no\nPage 1 size: 612 x 792 pts (letter)\nPage 2 size: 500 x 500 pts\n";
        assert_eq!(inspect(good, &ExecutionLimits::default()).unwrap(), 2);
        for bad in [
            "Pages: 1\nEncrypted: no\n",
            "Pages: 1\nPages: 1\nEncrypted: no\nPage 1 size: 2 x 2 pts\n",
            "Pages: 1\nEncrypted: no\nPage 1 size: NaN x 2 pts\n",
            "Pages: 2\nEncrypted: no\nPage 1 size: 2 x 2 pts\nPage 1 size: 2 x 2 pts\n",
        ] {
            assert!(inspect(bad.as_bytes(), &ExecutionLimits::default()).is_err());
        }
        assert_eq!(
            inspect(b"Pages: 21\nEncrypted: no\n", &ExecutionLimits::default())
                .unwrap_err()
                .code,
            FailureCode::PageLimit
        );
        assert_eq!(
            inspect(
                b"Pages: 1\nEncrypted: yes (print:no)\n",
                &ExecutionLimits::default()
            )
            .unwrap_err()
            .code,
            FailureCode::Encrypted
        );
        assert_eq!(
            inspect(
                b"Pages: 1\nEncrypted: no\nPage 1 size: 100000 x 100000 pts\n",
                &ExecutionLimits::default()
            )
            .unwrap_err()
            .code,
            FailureCode::PixelLimit
        );
    }
}
