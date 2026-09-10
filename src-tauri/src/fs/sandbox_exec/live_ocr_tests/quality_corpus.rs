//! Controlled quality comparisons only; never changes production OCR policy.
use super::super::types::{ExtractMethod, FailureCode, SandboxError};
use super::*;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::time::Instant;

#[path = "preprocessing.rs"]
mod preprocessing;

#[path = "vision.rs"]
mod vision;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Corpus {
    schema_version: u32,
    width: u32,
    height: u32,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    file: String,
    pages: Vec<Page>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Page {
    id: String,
    font: String,
    font_size: u32,
    layout: String,
    amount_style: String,
    amount: String,
    degradation: String,
    control_lines: Vec<String>,
}

fn compact(text: &str) -> String {
    text.chars().filter(|ch| !ch.is_whitespace()).collect()
}

fn amount_exact(text: &str, expected: &str) -> bool {
    let expected = compact(expected);
    let labeled = format!("合同金额{expected}");
    // A full value line (table cell) or full labeled line must match. Substring
    // matching could accept 11,234.50 as 1,234.50 or discard a currency/unit.
    text.lines()
        .map(compact)
        .filter(|line| line == &expected || line == &labeled)
        .count()
        == 1
}

#[test]
fn amount_score_keeps_digits_units_and_currency_significant() {
    assert!(amount_exact("合同金额 一 百 万 元\n", "一百万元"));
    assert!(amount_exact("合同金额\n￥98,765.40\n", "￥98,765.40"));
    for text in [
        "合同金额一自万元",
        "合同金额一百万元整",
        "合同金额十一百万元",
        "一百万元\n一百万元",
    ] {
        assert!(!amount_exact(text, "一百万元"), "{text}");
    }
    for text in ["11,234.50元", "1,234.50", "1.234.50元", "1,234.50元0"] {
        assert!(!amount_exact(text, "1,234.50元"), "{text}");
    }
    assert!(!amount_exact("98,765.40", "￥98,765.40"));
    assert!(!amount_exact("¥98,765.40", "￥98,765.40"));
}

#[test]
#[ignore = "Development-only independent synthetic OCR corpus; real Seatbelt and pinned components required"]
fn live_chinese_ocr_quality_corpus() {
    let started = Instant::now();
    let check = || {
        if started.elapsed().as_secs() < 600 {
            Ok(())
        } else {
            Err(SandboxError::new(
                FailureCode::TimedOut,
                "quality corpus budget reached",
            ))
        }
    };
    // Optional report is created exclusively before expensive work. Never
    // overwrite prior evidence, including when the strict quality gate fails.
    let mut report = std::env::var_os("SOLIDIFY_TEST_OCR_REPORT").map(|path| {
        let path = PathBuf::from(path);
        assert!(path.is_absolute());
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap()
    });
    let owner = StagingRoot::create().unwrap();
    let hash = format!("{:x}", Sha256::digest(b"quality-corpus"));
    let fixture = owner.stage(b"quality-corpus", &hash, "png", 1024).unwrap();
    let data = owner.stage(b"quality-corpus", &hash, "png", 1024).unwrap();
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("tools/generate-ocr-quality-corpus.swift");
    let generated = std::process::Command::new("/usr/bin/swift")
        .arg("-module-cache-path")
        .arg(fixture.work.join("swift-cache"))
        .arg(&script)
        .arg(&fixture.work)
        .output()
        .unwrap();
    assert!(
        generated.status.success(),
        "corpus generation failed: {}",
        String::from_utf8_lossy(&generated.stderr)
    );
    let manifest = std::fs::read(fixture.work.join("corpus.json")).unwrap();
    let corpus: Corpus = serde_json::from_slice(&manifest).unwrap();
    assert_eq!(corpus.schema_version, 1);
    assert_eq!((corpus.width, corpus.height), (1600, 700));
    assert_eq!(corpus.cases.len(), 33); // 24 sharp + 8 paired blur + 1 three-page PDF.
    assert_eq!(
        corpus
            .cases
            .iter()
            .map(|case| case.pages.len())
            .sum::<usize>(),
        35
    );
    let models = std::env::var_os("SOLIDIFY_TEST_BEST_TESSDATA").map(PathBuf::from);
    if let Some(directory) = &models {
        assert!(directory.is_absolute());
    }
    let components = development_components_with_models(&data.work, true, models.as_deref());
    let worker = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("solidify");
    assert!(worker.is_file(), "build the app binary first");
    let mut rows = Vec::new();
    let mut failures = Vec::new();
    let mut seen = BTreeSet::new();
    for case in corpus.cases {
        check().unwrap();
        let path = Path::new(&case.file);
        assert_eq!(path.components().count(), 1);
        assert!(seen.insert(case.file.clone()));
        let extension = path.extension().unwrap().to_str().unwrap();
        assert!(matches!(extension, "png" | "pdf"));
        let bytes = std::fs::read(fixture.work.join(path)).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let input = owner
            .stage(&bytes, &hash, extension, 25 * 1024 * 1024)
            .unwrap();
        let document = if extension == "pdf" {
            pdf::extract_pdf(
                &worker,
                &components,
                &input,
                "quality-corpus",
                &case.file,
                ExecutionLimits::default(),
                &check,
                || panic!("unexpected stop delay"),
            )
        } else {
            assert_eq!(
                ocr::image_dimensions(&bytes, "png", 20_000_000).unwrap(),
                (1600, 700)
            );
            ocr::extract_image(
                &worker,
                &components,
                &input,
                "quality-corpus",
                &case.file,
                ExecutionLimits::default(),
                &check,
                || panic!("unexpected stop delay"),
            )
        }
        .unwrap_or_else(|error| panic!("{} conversion failed: {error}", case.file));
        assert!(document.complete);
        assert_eq!(document.source_hash, hash);
        assert_eq!(document.relative_path, case.file);
        assert_eq!(document.execution_id, "quality-corpus");
        assert_eq!(
            document.method,
            if extension == "pdf" {
                ExtractMethod::PdfOcr
            } else {
                ExtractMethod::ImageOcr
            }
        );
        assert_eq!(document.pages.len(), case.pages.len());
        assert_eq!(document.language_versions, components.language_versions());
        assert!(!document.warnings.is_empty());
        assert!(
            std::fs::read_dir(&input.work).unwrap().next().is_none(),
            "intermediate files must be cleaned"
        );
        for (index, (actual, expected)) in document.pages.iter().zip(case.pages).enumerate() {
            assert_eq!(actual.page as usize, index + 1);
            let missing: Vec<_> = expected
                .control_lines
                .iter()
                .filter(|line| !compact(&actual.text).contains(&compact(line)))
                .cloned()
                .collect();
            let amount_matched = amount_exact(&actual.text, &expected.amount);
            if !amount_matched || !missing.is_empty() {
                failures.push(format!("{} page {}", case.file, actual.page));
            }
            let row = serde_json::json!({
                "file": case.file, "page": actual.page, "expected": expected,
                "sourceSha256": hash, "amountExact": amount_matched,
                "missingControlLines": missing, "text": actual.text,
                "parserVersion": document.parser_version, "languageVersions": document.language_versions,
                "warnings": document.warnings, "documentDurationMs": document.duration_ms
            });
            eprintln!("CORPUS_PAGE {row}");
            rows.push(row);
        }
    }
    let result = serde_json::json!({
        "schemaVersion": 1, "modelSet": if models.is_some() { "pinned-best-complete-dependencies" } else { "host" },
        "generatorSha256": format!("{:x}", Sha256::digest(std::fs::read(script).unwrap())),
        "manifestSha256": format!("{:x}", Sha256::digest(manifest)),
        "platform": std::env::consts::OS, "architecture": std::env::consts::ARCH,
        "pageCount": rows.len(), "failedPages": failures.len(),
        "amountExactCount": rows.iter().filter(|row| row["amountExact"] == true).count(),
        "durationMs": started.elapsed().as_millis(), "pages": rows
    });
    if let Some(file) = &mut report {
        serde_json::to_writer_pretty(&mut *file, &result).unwrap();
        file.write_all(b"\n").unwrap();
        file.sync_all().unwrap();
    }
    eprintln!(
        "CORPUS_SUMMARY pages={} amountExact={} failedPages={} durationMs={}",
        result["pageCount"],
        result["amountExactCount"],
        result["failedPages"],
        result["durationMs"]
    );
    assert!(
        failures.is_empty(),
        "OCR corpus quality gate failed (all pipeline checks passed): {failures:?}"
    );
}
