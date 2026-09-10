//! Fixed image OCR pipeline. No command, executable or environment comes from
//! model arguments. The caller retains its execution guard and staged input.
use super::components::VerifiedComponents;
use super::policy::ProcessJob;
use super::results::PageCollector;
use super::staging::StagedInput;
use super::types::{ExecutionLimits, ExtractMethod, ExtractedDocument, FailureCode, SandboxError};
use super::{supervisor, worker::ProcessOutput};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read};
use std::path::Path;
use std::time::Instant;

fn input_error(message: &str) -> SandboxError {
    SandboxError::new(FailureCode::InvalidInput, message)
}

/// Header inspection only; never decode the full pixel buffer in the desktop.
pub(super) fn image_dimensions(
    bytes: &[u8],
    extension: &str,
    max_pixels: u64,
) -> Result<(u32, u32), SandboxError> {
    let reader = image::io::Reader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| input_error("无法识别图片类型"))?;
    let compatible = matches!(
        (reader.format(), extension),
        (Some(image::ImageFormat::Png), "png") | (Some(image::ImageFormat::Jpeg), "jpg" | "jpeg")
    );
    if !compatible {
        return Err(input_error("图片实际类型与已确认扩展名不符"));
    }
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| input_error("图片头损坏或无法读取尺寸"))?;
    if width == 0 || height == 0 {
        return Err(input_error("图片尺寸无效"));
    }
    if u64::from(width) * u64::from(height) > max_pixels {
        return Err(SandboxError::new(
            FailureCode::PixelLimit,
            "图片像素超过解析预算",
        ));
    }
    Ok((width, height))
}

fn verified_image(staged: &StagedInput, limits: &ExecutionLimits) -> Result<(), SandboxError> {
    let bytes = snapshot_bytes(staged, limits)?;
    let extension = staged
        .input
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    image_dimensions(&bytes, extension, limits.max_page_pixels)?;
    Ok(())
}

pub(super) fn snapshot_bytes(
    staged: &StagedInput,
    limits: &ExecutionLimits,
) -> Result<Vec<u8>, SandboxError> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    }
    let file = options
        .open(&staged.input)
        .map_err(|_| input_error("暂存图片不可读取"))?;
    let metadata = file
        .metadata()
        .map_err(|_| input_error("无法检查暂存图片"))?;
    if !metadata.is_file() || metadata.len() > limits.max_input_bytes {
        return Err(input_error("暂存图片类型或大小无效"));
    }
    let mut bytes = Vec::new();
    file.take(limits.max_input_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| input_error("暂存图片读取失败"))?;
    if bytes.len() as u64 > limits.max_input_bytes
        || format!("{:x}", Sha256::digest(&bytes)) != staged.source_hash
    {
        return Err(SandboxError::new(
            FailureCode::SnapshotChanged,
            "暂存图片与授权快照不一致",
        ));
    }
    Ok(bytes)
}

pub(super) fn fixed_args(input: &Path, tessdata: &Path) -> Result<Vec<String>, SandboxError> {
    let input = input
        .to_str()
        .ok_or_else(|| input_error("图片路径编码无效"))?;
    let data = tessdata
        .to_str()
        .ok_or_else(|| input_error("语言包路径编码无效"))?;
    Ok([
        input,
        "stdout",
        "--tessdata-dir",
        data,
        "-l",
        "chi_sim+eng",
        "--oem",
        "1",
        "--psm",
        "3",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect())
}

pub fn extract_image(
    worker: &Path,
    components: &VerifiedComponents,
    staged: &StagedInput,
    execution_id: &str,
    relative_path: &str,
    limits: ExecutionLimits,
    check: impl Fn() -> Result<(), SandboxError>,
    on_stop_delay: impl Fn(),
) -> Result<ExtractedDocument, SandboxError> {
    extract_image_with_task_lock(
        worker,
        components,
        staged,
        execution_id,
        relative_path,
        limits,
        check,
        on_stop_delay,
        None,
    )
}

pub fn extract_image_with_task_lock(
    worker: &Path,
    components: &VerifiedComponents,
    staged: &StagedInput,
    execution_id: &str,
    relative_path: &str,
    limits: ExecutionLimits,
    check: impl Fn() -> Result<(), SandboxError>,
    on_stop_delay: impl Fn(),
    task_lock: Option<&std::fs::File>,
) -> Result<ExtractedDocument, SandboxError> {
    extract_image_with(
        components,
        staged,
        execution_id,
        relative_path,
        limits,
        &check,
        |job| supervisor::run_with_task_lock(worker, job, &check, &on_stop_delay, task_lock),
    )
}

fn extract_image_with(
    components: &VerifiedComponents,
    staged: &StagedInput,
    execution_id: &str,
    relative_path: &str,
    limits: ExecutionLimits,
    check: impl Fn() -> Result<(), SandboxError>,
    run: impl FnOnce(&ProcessJob) -> Result<ProcessOutput, SandboxError>,
) -> Result<ExtractedDocument, SandboxError> {
    let started = Instant::now();
    check()?;
    components.revalidate()?;
    verified_image(staged, &limits)?;
    check()?;
    let remaining = limits
        .wall
        .checked_sub(started.elapsed())
        .filter(|time| time.as_millis() > 0)
        .ok_or_else(|| SandboxError::new(FailureCode::TimedOut, "图片准备已超过转换预算"))?;
    let job = ProcessJob {
        binary: components.tesseract(),
        args: fixed_args(&staged.input, &components.tessdata())?,
        input: staged.input.clone(),
        work: staged.work.clone(),
        runtime_read: components.runtime_files(),
        wall_ms: remaining.as_millis().min(120_000) as u64,
        cpu_seconds: limits.cpu_seconds,
        max_file_bytes: limits.max_file_bytes,
        max_work_bytes: limits.max_work_bytes,
        max_output_bytes: limits.max_output_bytes,
    };
    job.validate()?;
    let result = run(&job)?;
    check()?;
    if started.elapsed() >= limits.wall {
        return Err(SandboxError::new(
            FailureCode::TimedOut,
            "图片转换超过总预算",
        ));
    }
    if result.stdout.len().saturating_add(result.stderr.len()) > limits.max_output_bytes {
        return Err(SandboxError::new(
            FailureCode::OutputLimit,
            "OCR 输出超过合计预算",
        ));
    }
    if result.exit_code != Some(0) {
        return Err(SandboxError::new(
            FailureCode::OcrFailed,
            "图片转换失败，未接受文本结果",
        ));
    }
    let mut collector = PageCollector::new(1, limits)?;
    collector.push(1, result.stdout)?;
    let mut warnings = vec![];
    if !result.stderr.is_empty() {
        warnings.push("OCR 转换器返回诊断信息，请审阅识别结果".into());
    }
    let document = collector.finish(ExtractedDocument {
        execution_id: execution_id.into(),
        relative_path: relative_path.into(),
        source_hash: staged.source_hash.clone(),
        method: ExtractMethod::ImageOcr,
        parser_version: components.parser_version().into(),
        language_versions: components.language_versions(),
        pages: vec![],
        complete: false,
        warnings,
        duration_ms: started.elapsed().as_millis() as u64,
    })?;
    check()?;
    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageEncoder;

    fn png() -> Vec<u8> {
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(&[255; 12], 2, 2, image::ColorType::Rgb8)
            .unwrap();
        bytes
    }

    #[test]
    fn checks_real_format_dimensions_and_pixel_limit() {
        let bytes = png();
        assert_eq!(image_dimensions(&bytes, "png", 4).unwrap(), (2, 2));
        assert_eq!(
            image_dimensions(&bytes, "png", 3).unwrap_err().code,
            FailureCode::PixelLimit
        );
        assert!(image_dimensions(&bytes, "jpg", 4).is_err());
        assert!(image_dimensions(b"not an image", "png", 4).is_err());
        assert!(image_dimensions(&bytes[..16], "png", 4).is_err());
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut jpeg)
            .encode(&[255; 12], 2, 2, image::ColorType::Rgb8)
            .unwrap();
        assert_eq!(image_dimensions(&jpeg, "jpeg", 4).unwrap(), (2, 2));
    }

    #[test]
    fn argv_keeps_paths_as_data_and_fixes_language_and_mode() {
        let args = fixed_args(
            Path::new("/private/tmp/a;echo x.png"),
            Path::new("/private/tmp/data"),
        )
        .unwrap();
        assert_eq!(args[0], "/private/tmp/a;echo x.png");
        assert_eq!(
            &args[1..],
            [
                "stdout",
                "--tessdata-dir",
                "/private/tmp/data",
                "-l",
                "chi_sim+eng",
                "--oem",
                "1",
                "--psm",
                "3"
            ]
        );
    }

    #[test]
    fn snapshot_tampering_is_rejected_before_decoding() {
        let owner = super::super::staging::StagingRoot::create().unwrap();
        let bytes = png();
        let mut staged = owner
            .stage(
                &bytes,
                &format!("{:x}", Sha256::digest(&bytes)),
                "png",
                4096,
            )
            .unwrap();
        verified_image(&staged, &ExecutionLimits::default()).unwrap();
        staged.source_hash = "wrong".into();
        assert_eq!(
            verified_image(&staged, &ExecutionLimits::default())
                .unwrap_err()
                .code,
            FailureCode::SnapshotChanged
        );
    }

    #[test]
    fn pipeline_preserves_provenance_and_rejects_late_cancellation_and_bad_exit() {
        use super::super::{components::tests::fixture, staging::StagingRoot};
        let owner = StagingRoot::create().unwrap();
        let bytes = png();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let staged = owner.stage(&bytes, &hash, "png", 4096).unwrap();
        let package = owner.stage(&bytes, &hash, "png", 4096).unwrap();
        let components = VerifiedComponents::verify(&package.work, fixture(&package.work)).unwrap();
        let output = || ProcessOutput {
            stdout: "中文 English".as_bytes().to_vec(),
            stderr: vec![],
            exit_code: Some(0),
            duration_ms: 1,
        };
        let result = extract_image_with(
            &components,
            &staged,
            "execution",
            "photo.png",
            ExecutionLimits::default(),
            || Ok(()),
            |job| {
                assert_eq!(job.binary, components.tesseract());
                assert_eq!(job.input, staged.input);
                assert!(job.wall_ms <= 120_000);
                Ok(output())
            },
        )
        .unwrap();
        assert_eq!(result.source_hash, hash);
        assert_eq!(result.pages[0].text, "中文 English");
        assert!(result.complete);
        assert_eq!(result.language_versions.len(), 2);
        let ran = std::cell::Cell::new(false);
        let cancelled = extract_image_with(
            &components,
            &staged,
            "execution",
            "photo.png",
            ExecutionLimits::default(),
            || {
                if ran.get() {
                    Err(SandboxError::new(FailureCode::Cancelled, "cancelled"))
                } else {
                    Ok(())
                }
            },
            |_| {
                ran.set(true);
                Ok(output())
            },
        );
        assert_eq!(cancelled.unwrap_err().code, FailureCode::Cancelled);
        let failed = extract_image_with(
            &components,
            &staged,
            "execution",
            "photo.png",
            ExecutionLimits::default(),
            || Ok(()),
            |_| {
                let mut value = output();
                value.exit_code = Some(1);
                Ok(value)
            },
        );
        assert_eq!(failed.unwrap_err().code, FailureCode::OcrFailed);
    }
}
