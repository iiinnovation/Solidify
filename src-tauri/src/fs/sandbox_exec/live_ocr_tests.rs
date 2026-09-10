//! Development-only tests against explicitly pinned Homebrew paths. These do
//! not register a capability or replace production signed component manifests.
use super::{
    components::{ComponentFile, ComponentManifest, VerifiedComponents},
    ocr, pdf,
    staging::StagingRoot,
    types::ExecutionLimits,
};
use image::ImageEncoder;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

#[path = "live_ocr_tests/quality_corpus.rs"]
mod quality_corpus;

fn relocate_runtime(binaries: &[&Path], destination: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut pending: Vec<PathBuf> = binaries.iter().map(|path| path.to_path_buf()).collect();
    let mut seen = BTreeSet::new();
    let mut edges = BTreeMap::<PathBuf, Vec<(String, PathBuf)>>::new();
    while let Some(path) = pending.pop() {
        let path = std::fs::canonicalize(path).unwrap();
        if !seen.insert(path.clone()) {
            continue;
        }
        assert!(seen.len() <= 200, "unexpected dependency expansion");
        let output = std::process::Command::new("/usr/bin/otool")
            .arg("-L")
            .arg(&path)
            .output()
            .unwrap();
        assert!(output.status.success());
        for line in String::from_utf8(output.stdout).unwrap().lines().skip(1) {
            let dependency = line.trim().split(" (compatibility").next().unwrap();
            if dependency.starts_with("/usr/lib/") || dependency.starts_with("/System/Library/") {
                continue;
            }
            if let Some(name) = dependency.strip_prefix("@rpath/") {
                // Resolve exact files from the pinned binary's LC_RPATH, not
                // PATH or a directory-wide sandbox grant. Poppler's executables
                // declare @loader_path/../lib rather than a sibling library.
                assert!(
                    !name.contains('/'),
                    "unsupported nested rpath: {dependency}"
                );
                let commands = std::process::Command::new("/usr/bin/otool")
                    .arg("-l")
                    .arg(&path)
                    .output()
                    .unwrap();
                assert!(commands.status.success());
                let commands = String::from_utf8(commands.stdout).unwrap();
                let mut candidates = BTreeSet::new();
                let sibling = path.parent().unwrap().join(name);
                if sibling.is_file() {
                    candidates.insert(std::fs::canonicalize(&sibling).unwrap());
                }
                for block in commands.split("Load command") {
                    if !block.lines().any(|line| line.trim() == "cmd LC_RPATH") {
                        continue;
                    }
                    let directory = block
                        .lines()
                        .find_map(|line| line.trim().strip_prefix("path "))
                        .unwrap()
                        .split(" (offset")
                        .next()
                        .unwrap();
                    let directory = if let Some(relative) = directory.strip_prefix("@loader_path/")
                    {
                        path.parent().unwrap().join(relative)
                    } else {
                        assert!(
                            directory.starts_with("/usr/local/"),
                            "unsupported rpath: {directory}"
                        );
                        PathBuf::from(directory)
                    };
                    let candidate = directory.join(name);
                    if candidate.is_file() {
                        candidates.insert(std::fs::canonicalize(candidate).unwrap());
                    }
                }
                assert!(
                    candidates.len() == 1,
                    "unresolved or ambiguous rpath in {}: {dependency}",
                    path.display()
                );
                let sibling = candidates.into_iter().next().unwrap();
                assert!(sibling.starts_with("/usr/local/Cellar"));
                edges
                    .entry(path.clone())
                    .or_default()
                    .push((dependency.into(), std::fs::canonicalize(&sibling).unwrap()));
                pending.push(sibling);
                continue;
            }
            assert!(
                dependency.starts_with("/usr/local/"),
                "unresolved dependency: {dependency}"
            );
            let canonical = std::fs::canonicalize(dependency).unwrap();
            edges
                .entry(path.clone())
                .or_default()
                .push((dependency.into(), canonical.clone()));
            pending.push(canonical);
        }
    }
    let mut copies = BTreeMap::new();
    let mut names = BTreeSet::new();
    for original in seen {
        let copy = destination.join(original.file_name().unwrap());
        assert!(names.insert(copy.clone()), "duplicate runtime filename");
        std::fs::copy(&original, &copy).unwrap();
        copies.insert(original, copy);
    }
    for (original, copy) in &copies {
        let mut command = std::process::Command::new("/usr/bin/install_name_tool");
        let mut changed = false;
        if copy.extension().and_then(|value| value.to_str()) == Some("dylib") {
            command.arg("-id").arg(copy);
            changed = true;
        }
        for (name, target) in edges.get(original).into_iter().flatten() {
            command.arg("-change").arg(name).arg(&copies[target]);
            changed = true;
        }
        if changed {
            let result = command.arg(copy).output().unwrap();
            assert!(
                result.status.success(),
                "relocation failed: {}",
                String::from_utf8_lossy(&result.stderr)
            );
            let signature = std::process::Command::new("/usr/bin/codesign")
                .args(["--force", "--sign", "-"])
                .arg(copy)
                .output()
                .unwrap();
            assert!(
                signature.status.success(),
                "test component signing failed: {}",
                String::from_utf8_lossy(&signature.stderr)
            );
        }
    }
    (
        binaries
            .iter()
            .map(|binary| copies[&std::fs::canonicalize(binary).unwrap()].clone())
            .collect(),
        copies.into_values().collect(),
    )
}

fn english_image() -> Vec<u8> {
    // Deterministic test glyphs spelling SOLIDIFY; no fonts, downloads or user
    // documents are needed to prove that the actual OCR engine recognizes text.
    let glyphs = [
        [14, 17, 16, 14, 1, 17, 14],
        [14, 17, 17, 17, 17, 17, 14],
        [16, 16, 16, 16, 16, 16, 31],
        [31, 4, 4, 4, 4, 4, 31],
        [30, 17, 17, 17, 17, 17, 30],
        [31, 4, 4, 4, 4, 4, 31],
        [31, 16, 16, 30, 16, 16, 16],
        [17, 17, 10, 4, 4, 4, 4],
    ];
    let mut pixels = image::RgbImage::from_pixel(700, 160, image::Rgb([255, 255, 255]));
    for (index, glyph) in glyphs.iter().enumerate() {
        for (row, bits) in glyph.iter().enumerate() {
            for col in 0..5 {
                if bits & (1 << (4 - col)) == 0 {
                    continue;
                }
                for y in 0..12 {
                    for x in 0..12 {
                        pixels.put_pixel(
                            40 + index as u32 * 76 + col * 12 + x,
                            35 + row as u32 * 12 + y,
                            image::Rgb([0, 0, 0]),
                        );
                    }
                }
            }
        }
    }
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(pixels.as_raw(), 700, 160, image::ColorType::Rgb8)
        .unwrap();
    bytes
}

fn development_components(destination: &Path, with_pdf: bool) -> VerifiedComponents {
    development_components_with_models(destination, with_pdf, None)
}

fn development_components_with_models(
    destination: &Path,
    with_pdf: bool,
    best_models: Option<&Path>,
) -> VerifiedComponents {
    let binary = Path::new("/usr/local/Cellar/tesseract/5.5.3/bin/tesseract");
    let mut binaries = vec![binary];
    if with_pdf {
        binaries.extend([
            Path::new("/usr/local/Cellar/poppler/26.09.0/bin/pdfinfo"),
            Path::new("/usr/local/Cellar/poppler/26.09.0/bin/pdftoppm"),
        ]);
    }
    let (binaries, mut runtime_read) = relocate_runtime(&binaries, destination);
    let tessdata = destination.join("tessdata");
    std::fs::create_dir(&tessdata).unwrap();
    let mut language_versions = BTreeMap::new();
    let languages: &[&str] = if best_models.is_some() {
        &["chi_sim", "eng", "chi_sim_vert"]
    } else {
        &["chi_sim", "eng"]
    };
    for &language in languages {
        let original = std::fs::canonicalize(
            best_models
                .unwrap_or(Path::new("/usr/local/share/tessdata"))
                .join(format!("{language}.traineddata")),
        )
        .unwrap();
        assert!(std::fs::metadata(&original).unwrap().len() <= 32 * 1024 * 1024);
        let copy = tessdata.join(format!("{language}.traineddata"));
        std::fs::copy(original, &copy).unwrap();
        let digest = format!("{:x}", Sha256::digest(std::fs::read(&copy).unwrap()));
        if best_models.is_some() {
            // tesseract-ocr/tessdata_best commit e12c65a915945e4c28e237a9b52bc4a8f39a0cec.
            let expected = match language {
                "chi_sim" => "4fef2d1306c8e87616d4d3e4c6c67faf5d44be3342290cf8f2f0f6e3aa7e735b",
                "eng" => "8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba",
                "chi_sim_vert" => {
                    "ea672a78157199c333aa12ec4e74550077689b545df5fc770903716850c8b2e5"
                }
                _ => unreachable!(),
            };
            assert_eq!(
                digest, expected,
                "development model must match the pinned upstream commit"
            );
        }
        language_versions.insert(language.into(), format!("sha256:{digest}"));
        runtime_read.push(copy);
    }
    let files = runtime_read
        .into_iter()
        .map(|path| {
            let bytes = std::fs::read(&path).unwrap();
            ComponentFile {
                path: path
                    .strip_prefix(destination)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .into(),
                bytes: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&bytes)),
            }
        })
        .collect();
    VerifiedComponents::verify(
        destination,
        ComponentManifest {
            schema_version: 1,
            platform: "macos".into(),
            architecture: std::env::consts::ARCH.into(),
            package_version: "development-relocated-5.5.3".into(),
            tesseract: binaries[0].file_name().unwrap().to_str().unwrap().into(),
            tesseract_version: "5.5.3".into(),
            pdfinfo: with_pdf.then(|| "pdfinfo".into()),
            pdftoppm: with_pdf.then(|| "pdftoppm".into()),
            poppler_version: with_pdf.then(|| "26.09.0".into()),
            tessdata_dir: "tessdata".into(),
            language_versions,
            files,
        },
    )
    .unwrap()
}

#[test]
#[ignore = "Requires pinned Homebrew OCR dependencies and real Seatbelt"]
fn live_tesseract_reads_image_with_chinese_and_english_languages_loaded() {
    let owner = StagingRoot::create().unwrap();
    let bytes = english_image();
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let input = owner.stage(&bytes, &hash, "png", 1024 * 1024).unwrap();
    let data = owner.stage(&bytes, &hash, "png", 1024 * 1024).unwrap();
    let components = development_components(&data.work, false);
    let worker = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("solidify");
    assert!(worker.is_file(), "build the app binary first");
    let document = ocr::extract_image(
        &worker,
        &components,
        &input,
        "test-execution",
        "fixture.png",
        ExecutionLimits::default(),
        || Ok(()),
        || panic!("unexpected stop delay"),
    )
    .unwrap();
    assert!(document.complete);
    assert_eq!(document.source_hash, hash);
    assert_eq!(document.language_versions.len(), 2);
    let text = &document.pages[0].text;
    assert!(
        text.to_uppercase().contains("SOLIDIFY"),
        "unexpected OCR text: {text:?}"
    );
}

#[test]
#[ignore = "Requires macOS Swift, pinned OCR/PDF components, built app and real Seatbelt"]
fn live_chinese_png_jpeg_and_two_page_scanned_pdf() {
    let owner = StagingRoot::create().unwrap();
    let hash = format!("{:x}", Sha256::digest(b"fixture"));
    let fixture = owner.stage(b"fixture", &hash, "png", 1024).unwrap();
    let data = owner.stage(b"fixture", &hash, "png", 1024).unwrap();
    generate_chinese_fixture(&fixture.work);
    let components = development_components(&data.work, true);
    verify_chinese_pipeline(&owner, &fixture.work, &components);
}

#[test]
#[ignore = "Requires explicit pinned tessdata_best directory and real Seatbelt; no production activation"]
fn live_chinese_pipeline_with_pinned_best_models() {
    let directory = PathBuf::from(std::env::var_os("SOLIDIFY_TEST_BEST_TESSDATA").expect(
        "set SOLIDIFY_TEST_BEST_TESSDATA to the explicitly downloaded pinned model directory",
    ));
    assert!(directory.is_absolute());
    let owner = StagingRoot::create().unwrap();
    let hash = format!("{:x}", Sha256::digest(b"fixture"));
    let fixture = owner.stage(b"fixture", &hash, "png", 1024).unwrap();
    let data = owner.stage(b"fixture", &hash, "png", 1024).unwrap();
    generate_chinese_fixture(&fixture.work);
    let components = development_components_with_models(&data.work, true, Some(&directory));
    verify_chinese_pipeline(&owner, &fixture.work, &components);
}

fn generate_chinese_fixture(destination: &Path) {
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("tools/generate-ocr-fixture.swift");
    let output = std::process::Command::new("/usr/bin/swift")
        .arg("-module-cache-path")
        .arg(destination.join("swift-cache"))
        .arg(script)
        .arg(destination)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "fixture generation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn verify_chinese_pipeline(
    owner: &std::sync::Arc<StagingRoot>,
    fixture: &Path,
    components: &VerifiedComponents,
) {
    let worker = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("solidify");
    assert!(worker.is_file(), "build the app binary first");
    let mut quality_failures = Vec::new();
    for (name, extension, pages) in [
        ("chinese.png", "png", 1),
        ("chinese.jpg", "jpg", 1),
        ("chinese-scan.pdf", "pdf", 2),
    ] {
        let bytes = std::fs::read(fixture.join(name)).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let input = owner
            .stage(&bytes, &hash, extension, 25 * 1024 * 1024)
            .unwrap();
        let document = if extension == "pdf" {
            pdf::extract_pdf(
                &worker,
                &components,
                &input,
                "live-chinese",
                name,
                ExecutionLimits::default(),
                || Ok(()),
                || panic!("unexpected stop delay"),
            )
        } else {
            ocr::extract_image(
                &worker,
                &components,
                &input,
                "live-chinese",
                name,
                ExecutionLimits::default(),
                || Ok(()),
                || panic!("unexpected stop delay"),
            )
        }
        .unwrap_or_else(|error| panic!("{name} conversion failed: {error}"));
        assert!(document.complete);
        assert_eq!(document.source_hash, hash);
        assert_eq!(document.pages.len(), pages);
        assert_eq!(document.language_versions, components.language_versions());
        for (index, page) in document.pages.iter().enumerate() {
            assert_eq!(page.page as usize, index + 1);
            let compact: String = page.text.chars().filter(|ch| !ch.is_whitespace()).collect();
            // Collect every page before failing the strict quality baseline.
            // Do not replace expected phrases with observed OCR errors merely
            // to make the live test green. Pipeline integrity is checked below
            // independently, even when recognition accuracy fails.
            let missing: Vec<_> = [
                "项目验收报告",
                "中文识别测试",
                "合同金额一百万元",
                "SOLIDIFYOCRVALIDATION",
            ]
            .into_iter()
            .filter(|expected| !compact.contains(expected))
            .collect();
            eprintln!(
                "quality {name} page {}: missing={missing:?}; text={:?}",
                page.page, page.text
            );
            if !missing.is_empty() {
                quality_failures.push(format!("{name} page {}: {missing:?}", page.page));
            }
            assert!(
                !document.warnings.is_empty(),
                "OCR accuracy warnings must survive successful conversion"
            );
        }
        if extension == "pdf" {
            assert!(
                std::fs::read_dir(&input.work).unwrap().next().is_none(),
                "rendered pages must be cleaned"
            );
        }
        eprintln!(
            "pipeline verified {name}: {} pages, {} ms, {}",
            document.pages.len(),
            document.duration_ms,
            document.parser_version
        );
    }
    assert!(quality_failures.is_empty(), "OCR quality baseline failed (pipeline success does not imply text accuracy): {quality_failures:?}");
}

#[test]
#[ignore = "Development-only OCR parameter experiment; never changes runtime policy"]
fn live_chinese_ocr_parameter_matrix() {
    use super::{
        policy::ProcessJob,
        supervisor,
        types::{FailureCode, SandboxError},
    };
    let owner = StagingRoot::create().unwrap();
    let seed_hash = format!("{:x}", Sha256::digest(b"fixture"));
    let fixture = owner.stage(b"fixture", &seed_hash, "png", 1024).unwrap();
    let data = owner.stage(b"fixture", &seed_hash, "png", 1024).unwrap();
    generate_chinese_fixture(&fixture.work);
    let components = development_components(&data.work, true);
    let worker = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("solidify");
    let started = std::time::Instant::now();
    let check = || {
        if started.elapsed().as_secs() < 300 {
            Ok(())
        } else {
            Err(SandboxError::new(
                FailureCode::TimedOut,
                "experiment budget reached",
            ))
        }
    };
    let job = |binary: PathBuf, args: Vec<String>, input: PathBuf, work: PathBuf| ProcessJob {
        binary,
        args,
        input,
        work,
        runtime_read: components.runtime_files(),
        wall_ms: 60_000,
        cpu_seconds: 30,
        max_file_bytes: 64 * 1024 * 1024,
        max_work_bytes: 128 * 1024 * 1024,
        max_output_bytes: 64 * 1024,
    };
    let mut images = vec![
        (
            "png".to_string(),
            std::fs::read(fixture.work.join("chinese.png")).unwrap(),
        ),
        (
            "jpg".to_string(),
            std::fs::read(fixture.work.join("chinese.jpg")).unwrap(),
        ),
    ];
    let pdf_bytes = std::fs::read(fixture.work.join("chinese-scan.pdf")).unwrap();
    let pdf_input = owner
        .stage(
            &pdf_bytes,
            &format!("{:x}", Sha256::digest(&pdf_bytes)),
            "pdf",
            25 * 1024 * 1024,
        )
        .unwrap();
    for dpi in [150, 300] {
        let prefix = pdf_input.work.join(format!("render-{dpi}"));
        let args = vec![
            "-f".into(),
            "1".into(),
            "-l".into(),
            "1".into(),
            "-r".into(),
            dpi.to_string(),
            "-cropbox".into(),
            "-singlefile".into(),
            "-png".into(),
            pdf_input.input.to_str().unwrap().into(),
            prefix.to_str().unwrap().into(),
        ];
        let output = supervisor::run(
            &worker,
            &job(
                components.pdf_tools().unwrap().1,
                args,
                pdf_input.input.clone(),
                pdf_input.work.clone(),
            ),
            &check,
            &|| {},
        )
        .unwrap();
        assert_eq!(output.exit_code, Some(0), "render failed");
        let bytes = std::fs::read(prefix.with_extension("png")).unwrap();
        ocr::image_dimensions(&bytes, "png", 20_000_000).unwrap();
        images.push((format!("pdf-{dpi}"), bytes));
    }
    for (format, bytes) in images {
        let input = owner
            .stage(
                &bytes,
                &format!("{:x}", Sha256::digest(&bytes)),
                if format == "jpg" { "jpg" } else { "png" },
                25 * 1024 * 1024,
            )
            .unwrap();
        for language in ["chi_sim+eng", "chi_sim"] {
            for mode in ["3", "6"] {
                let mut args = ocr::fixed_args(&input.input, &components.tessdata()).unwrap();
                args[5] = language.into();
                args[9] = mode.into();
                let output = supervisor::run(
                    &worker,
                    &job(
                        components.tesseract(),
                        args,
                        input.input.clone(),
                        input.work.clone(),
                    ),
                    &check,
                    &|| {},
                )
                .unwrap();
                assert_eq!(output.exit_code, Some(0), "OCR comparison failed");
                let text = String::from_utf8(output.stdout).unwrap();
                let compact: String = text.chars().filter(|ch| !ch.is_whitespace()).collect();
                let missing: Vec<_> = [
                    "项目验收报告",
                    "中文识别测试",
                    "合同金额一百万元",
                    "SOLIDIFYOCRVALIDATION",
                ]
                .into_iter()
                .filter(|expected| !compact.contains(expected))
                .collect();
                eprintln!(
                    "MATRIX {}",
                    serde_json::json!({ "input": format, "language": language, "psm": mode, "matched": 4 - missing.len(), "missing": missing, "text": text, "durationMs": output.duration_ms })
                );
            }
        }
    }
}
