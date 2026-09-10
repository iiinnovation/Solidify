//! Test-only preprocessing experiment. Known fixture coordinates are an oracle,
//! not a document-layout detector. No production pipeline imports this module.
use super::*;
use crate::fs::sandbox_exec::{policy::ProcessJob, supervisor};
use image::{Rgb, RgbImage};

const CROP: [u32; 4] = [85, 200, 1430, 100]; // x/y from the top left, width/height.
const VARIANTS: [(&str, &str); 5] = [
    ("original", "3"),
    ("rgb-reencode", "3"),
    ("remove-lines", "3"),
    ("oracle-row-crop", "3"),
    ("oracle-row-crop-psm7", "7"),
];

fn dark(pixel: &Rgb<u8>) -> bool {
    pixel.0.iter().all(|channel| *channel < 128)
}

// Detect maximal uninterrupted dark runs using pixels alone. Coalesce adjacent
// scanlines; reject thick bands (e.g. filled cells) instead of erasing them.
// Thresholds suit this controlled 1600x700 corpus, not arbitrary scans.
fn remove_rules(source: &RgbImage) -> (RgbImage, usize) {
    let (width, height) = source.dimensions();
    let mut mask = vec![false; (width * height) as usize];
    for horizontal in [true, false] {
        let (major, minor, minimum) = if horizontal {
            (width, height, 600)
        } else {
            (height, width, 100)
        };
        let mut runs = BTreeMap::<u32, Vec<(u32, u32)>>::new();
        for b in 0..minor {
            let mut start = None;
            for a in 0..=major {
                let is_dark = a < major
                    && dark(if horizontal {
                        source.get_pixel(a, b)
                    } else {
                        source.get_pixel(b, a)
                    });
                if is_dark {
                    start.get_or_insert(a);
                } else if let Some(first) = start.take() {
                    if a - first >= minimum {
                        runs.entry(b).or_default().push((first, a));
                    }
                }
            }
        }
        for (&b, segments) in &runs {
            let mut low = b;
            let mut high = b;
            while low > 0 && runs.contains_key(&(low - 1)) {
                low -= 1;
            }
            while high + 1 < minor && runs.contains_key(&(high + 1)) {
                high += 1;
            }
            if high - low + 1 > 6 {
                continue;
            }
            for &(start, end) in segments {
                // Three-pixel fringe covers this corpus's blur/antialiasing without whitening an
                // entire page row/column or unrelated text beyond the run.
                for y in b.saturating_sub(3)..=(b + 3).min(minor - 1) {
                    for x in start.saturating_sub(3)..=(end + 2).min(major - 1) {
                        let (x, y) = if horizontal { (x, y) } else { (y, x) };
                        mask[(y * width + x) as usize] = true;
                    }
                }
            }
        }
    }
    let mut result = source.clone();
    let mut changed = 0;
    for (index, pixel) in result.pixels_mut().enumerate() {
        if mask[index] && pixel.0 != [255; 3] {
            *pixel = Rgb([255; 3]);
            changed += 1;
        }
    }
    (result, changed)
}

fn crop_row(source: &RgbImage) -> RgbImage {
    assert_eq!(source.dimensions(), (1600, 700));
    let [x, y, width, height] = CROP;
    let crop = image::imageops::crop_imm(source, x, y, width, height).to_image();
    // Fail if the known ROI clips visible ink or accidentally becomes blank.
    for (x, y, pixel) in crop.enumerate_pixels() {
        if x < 8 || y < 8 || x >= width - 8 || y >= height - 8 {
            assert!(!dark(pixel), "oracle ROI cuts foreground at {x},{y}");
        }
    }
    assert!(crop.pixels().filter(|pixel| dark(pixel)).count() > 1000);
    crop
}

fn png(image: &RgbImage) -> Vec<u8> {
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ColorType::Rgb8,
        )
        .unwrap();
    bytes
}

fn amount_currency_width_equivalent(text: &str, expected: &str) -> bool {
    // A secondary diagnostic only. Never strip separators, units, or digits.
    amount_exact(&text.replace('￥', "¥"), &expected.replace('￥', "¥"))
}

fn generate_corpus(destination: &Path) -> (Corpus, Vec<u8>, String) {
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("tools/generate-ocr-quality-corpus.swift");
    let script_hash = format!("{:x}", Sha256::digest(std::fs::read(&script).unwrap()));
    let generated = std::process::Command::new("/usr/bin/swift")
        .arg("-module-cache-path")
        .arg(destination.join("swift-cache"))
        .arg(script)
        .arg(destination)
        .output()
        .unwrap();
    assert!(
        generated.status.success(),
        "fixture generation: {}",
        String::from_utf8_lossy(&generated.stderr)
    );
    let manifest = std::fs::read(destination.join("corpus.json")).unwrap();
    let corpus: Corpus = serde_json::from_slice(&manifest).unwrap();
    assert_eq!(
        (
            corpus.schema_version,
            corpus.width,
            corpus.height,
            corpus.cases.len()
        ),
        (1, 1600, 700, 33)
    );
    (corpus, manifest, script_hash)
}

fn transformed(bytes: &[u8], layout: &str) -> (Vec<u8>, Vec<u8>, usize) {
    let source = image::load_from_memory(bytes).unwrap().to_rgb8();
    assert_eq!(source.dimensions(), (1600, 700));
    let (clean, changed) = remove_rules(&source);
    if layout == "lines" {
        assert_eq!(changed, 0, "line detector erased non-table text");
    } else {
        assert_eq!(layout, "table");
        assert!(
            changed > 5000 && changed < 80_000,
            "unexpected line mask size: {changed}"
        );
    }
    let crop = crop_row(&clean);
    // A separate rgb-reencode control below isolates pixel erasure from PNG
    // encoding, alpha removal and resolution/color metadata changes.
    (png(&clean), png(&crop), changed)
}

fn write_new(path: &Path, bytes: &[u8]) {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .unwrap();
    file.write_all(bytes).unwrap();
}

#[test]
fn rule_removal_preserves_short_marks_and_thick_regions() {
    let mut source = RgbImage::from_pixel(1600, 700, Rgb([255; 3]));
    // Thin rules, including a vertical/horizontal intersection.
    for x in 75..1525 {
        for y in 184..186 {
            source.put_pixel(x, y, Rgb([0; 3]));
        }
    }
    for x in 399..401 {
        for y in 185..310 {
            source.put_pixel(x, y, Rgb([0; 3]));
        }
    }
    // Negative sign / glyph strokes must survive; no full-row whitening.
    for x in 450..480 {
        for y in 250..253 {
            source.put_pixel(x, y, Rgb([0; 3]));
        }
    }
    for x in 1540..1560 {
        source.put_pixel(x, 185, Rgb([0; 3]));
    }
    // A wide, thick filled area is not a rule.
    for x in 100..900 {
        for y in 500..520 {
            source.put_pixel(x, y, Rgb([0; 3]));
        }
    }
    let (result, count) = remove_rules(&source);
    assert!(count > 3000);
    assert_eq!(result.get_pixel(100, 185), &Rgb([255; 3]));
    assert_eq!(result.get_pixel(400, 250), &Rgb([255; 3]));
    assert_eq!(result.get_pixel(455, 250), source.get_pixel(455, 250));
    assert_eq!(result.get_pixel(1545, 185), source.get_pixel(1545, 185));
    assert_eq!(result.get_pixel(500, 510), source.get_pixel(500, 510));
    assert_eq!(remove_rules(&result).1, 0);
    assert_eq!(
        remove_rules(&RgbImage::from_pixel(1600, 700, Rgb([255; 3]))).1,
        0
    );
}

#[test]
fn currency_diagnostic_does_not_relax_strict_score_or_fix_numbers() {
    assert!(amount_currency_width_equivalent(
        "合同金额 ¥98,765.40",
        "￥98,765.40"
    ));
    assert!(!amount_exact("合同金额 ¥98,765.40", "￥98,765.40"));
    for text in ["¥8,765.40", "¥198,765.40", "¥98.765.40", "Y98,765.40"] {
        assert!(!amount_currency_width_equivalent(text, "￥98,765.40"));
    }
}

#[test]
#[ignore = "Generate and inspect controlled preprocessing images; requires explicit empty artifact directory"]
fn inspect_chinese_ocr_preprocessing_fixtures() {
    let destination = PathBuf::from(
        std::env::var_os("SOLIDIFY_TEST_OCR_ARTIFACTS")
            .expect("set private empty artifact directory"),
    );
    assert!(destination.is_absolute() && destination.is_dir());
    assert!(std::fs::read_dir(&destination).unwrap().next().is_none());
    let (corpus, _, _) = generate_corpus(&destination);
    let mut count = 0;
    for case in corpus
        .cases
        .iter()
        .filter(|case| case.file.ends_with(".png"))
    {
        let bytes = std::fs::read(destination.join(&case.file)).unwrap();
        let (clean, crop, changed) = transformed(&bytes, &case.pages[0].layout);
        write_new(&destination.join(format!("clean-{}", case.file)), &clean);
        write_new(&destination.join(format!("crop-{}", case.file)), &crop);
        eprintln!("fixture {}: {changed} changed pixels", case.file);
        count += 1;
    }
    assert_eq!(count, 32);
}

#[test]
#[ignore = "Fixed-model preprocessing comparison in real Seatbelt; no production activation"]
fn live_chinese_ocr_complete_model_preprocessing_matrix() {
    let started = Instant::now();
    let check = || {
        if started.elapsed().as_secs() < 600 {
            Ok(())
        } else {
            Err(SandboxError::new(
                FailureCode::TimedOut,
                "preprocessing experiment budget reached",
            ))
        }
    };
    let report_path = PathBuf::from(
        std::env::var_os("SOLIDIFY_TEST_OCR_REPORT").expect("set a new absolute report path"),
    );
    assert!(report_path.is_absolute());
    let mut report = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(report_path)
        .unwrap();
    let models = PathBuf::from(
        std::env::var_os("SOLIDIFY_TEST_BEST_TESSDATA").expect("set pinned best model directory"),
    );
    assert!(models.is_absolute());
    let owner = StagingRoot::create().unwrap();
    let seed = b"preprocessing-fixture";
    let seed_hash = format!("{:x}", Sha256::digest(seed));
    let fixture = owner.stage(seed, &seed_hash, "png", 1024).unwrap();
    let data = owner.stage(seed, &seed_hash, "png", 1024).unwrap();
    let (corpus, manifest, generator_hash) = generate_corpus(&fixture.work);
    let archived: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../docs/ocr-quality/2026-09-10-pinned-best.json"
    )))
    .unwrap();
    let previous_experiment_bytes = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../docs/ocr-quality/2026-09-10-preprocessing-pinned-best.json"
    ));
    let previous_experiment: serde_json::Value =
        serde_json::from_slice(previous_experiment_bytes).unwrap();
    assert_eq!(
        archived["generatorSha256"], generator_hash,
        "comparison requires the unchanged corpus generator"
    );
    let components = development_components_with_models(&data.work, false, Some(&models));
    let worker = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("solidify");
    assert!(worker.is_file());
    let mut rows = Vec::new();
    let mut source_count = 0;
    for case in corpus
        .cases
        .into_iter()
        .filter(|case| case.file.ends_with(".png"))
    {
        assert_eq!(case.pages.len(), 1);
        let expected = &case.pages[0];
        let original = std::fs::read(fixture.work.join(&case.file)).unwrap();
        let source_hash = format!("{:x}", Sha256::digest(&original));
        let previous = archived["pages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|page| page["file"] == case.file)
            .unwrap();
        assert_eq!(
            previous["sourceSha256"], source_hash,
            "sample pixels/encoding changed"
        );
        let (clean, crop, changed) = transformed(&original, &expected.layout);
        let reencoded = png(&image::load_from_memory(&original).unwrap().to_rgb8());
        if expected.layout == "lines" {
            assert_eq!(clean, reencoded);
        }
        let mut baseline = None;
        for (variant, psm) in VARIANTS {
            check().unwrap();
            let bytes = match variant {
                "original" => &original,
                "rgb-reencode" => &reencoded,
                "remove-lines" => &clean,
                _ => &crop,
            };
            let input_hash = format!("{:x}", Sha256::digest(bytes));
            let input = owner
                .stage(bytes, &input_hash, "png", 25 * 1024 * 1024)
                .unwrap();
            components.revalidate().unwrap();
            let mut args = ocr::fixed_args(&input.input, &components.tessdata()).unwrap();
            assert_eq!(args[8], "--psm");
            args[9] = psm.into();
            let output = supervisor::run(
                &worker,
                &ProcessJob {
                    binary: components.tesseract(),
                    args,
                    input: input.input.clone(),
                    work: input.work.clone(),
                    runtime_read: components.runtime_files(),
                    wall_ms: 60_000,
                    cpu_seconds: 30,
                    max_file_bytes: 64 * 1024 * 1024,
                    max_work_bytes: 128 * 1024 * 1024,
                    max_output_bytes: 64 * 1024,
                },
                &check,
                &|| panic!("unexpected stop delay"),
            )
            .unwrap();
            assert_eq!(
                output.exit_code,
                Some(0),
                "{} {variant} process failed",
                case.file
            );
            assert!(std::fs::read_dir(&input.work).unwrap().next().is_none());
            assert_eq!(
                format!("{:x}", Sha256::digest(std::fs::read(&input.input).unwrap())),
                input_hash
            );
            let text = String::from_utf8(output.stdout).unwrap();
            let previous_variant = previous_experiment["rows"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["file"] == case.file && row["variant"] == variant)
                .unwrap();
            assert_eq!(previous_variant["inputSha256"], input_hash);
            assert_eq!(previous_variant["psm"], psm);
            let exact = amount_exact(&text, &expected.amount);
            let equivalent = amount_currency_width_equivalent(&text, &expected.amount);
            if variant == "original" {
                baseline = Some((exact, equivalent));
            }
            let (base_exact, base_equivalent) = baseline.unwrap();
            let cropped = variant.starts_with("oracle-");
            let missing = if cropped {
                None
            } else {
                Some(
                    expected
                        .control_lines
                        .iter()
                        .filter(|line| !compact(&text).contains(&compact(line)))
                        .cloned()
                        .collect::<Vec<_>>(),
                )
            };
            let row = serde_json::json!({
                "file": case.file, "expected": expected, "variant": variant, "psm": psm,
                "sourceSha256": source_hash, "inputSha256": input_hash,
                "removedPixels": if matches!(variant, "original" | "rgb-reencode") { 0 } else { changed },
                "oracleCrop": if cropped { Some(CROP) } else { None },
                "amountExact": exact, "currencyWidthEquivalent": equivalent,
                "strictImprovement": !base_exact && exact, "strictRegression": base_exact && !exact,
                "equivalentImprovement": !base_equivalent && equivalent,
                "equivalentRegression": base_equivalent && !equivalent,
                "baselineReproduced": if variant == "original" { Some(compact(&text) == compact(previous["text"].as_str().unwrap())) } else { None },
                "previousTextReproduced": compact(&text) == compact(previous_variant["text"].as_str().unwrap()),
                "dependencyStrictImprovement": previous_variant["amountExact"] == false && exact,
                "dependencyStrictRegression": previous_variant["amountExact"] == true && !exact,
                "dependencyEquivalentImprovement": previous_variant["currencyWidthEquivalent"] == false && equivalent,
                "dependencyEquivalentRegression": previous_variant["currencyWidthEquivalent"] == true && !equivalent,
                "missingControlLines": missing, "text": text,
                "stderr": String::from_utf8_lossy(&output.stderr), "durationMs": output.duration_ms
            });
            eprintln!("PREPROCESS_ROW {row}");
            rows.push(row);
        }
        source_count += 1;
    }
    assert_eq!(source_count, 32);
    assert_eq!(rows.len(), 160);
    let summaries: Vec<_> = VARIANTS.iter().map(|(variant, _)| {
        let group: Vec<_> = rows.iter().filter(|row| row["variant"] == *variant).collect();
        let count = |key: &str| group.iter().filter(|row| row[key] == true).count();
        serde_json::json!({ "variant": variant, "count": group.len(), "amountExact": count("amountExact"),
            "currencyWidthEquivalent": count("currencyWidthEquivalent"),
            "strictImprovements": count("strictImprovement"), "strictRegressions": count("strictRegression"),
            "equivalentImprovements": count("equivalentImprovement"), "equivalentRegressions": count("equivalentRegression"),
            "previousTextsReproduced": count("previousTextReproduced"),
            "dependencyStrictImprovements": count("dependencyStrictImprovement"),
            "dependencyStrictRegressions": count("dependencyStrictRegression"),
            "dependencyEquivalentImprovements": count("dependencyEquivalentImprovement"),
            "dependencyEquivalentRegressions": count("dependencyEquivalentRegression") })
    }).collect();
    let baseline_reproduced = rows
        .iter()
        .filter(|row| row["variant"] == "original")
        .all(|row| row["baselineReproduced"] == true);
    let candidate_passes = summaries
        .iter()
        .skip(2)
        .any(|summary| summary["amountExact"] == 32);
    let result = serde_json::json!({
        "schemaVersion": 2, "modelSet": "pinned-best-complete-dependencies", "generatorSha256": generator_hash,
        "modelRepository": "https://github.com/tesseract-ocr/tessdata_best",
        "modelCommit": "e12c65a915945e4c28e237a9b52bc4a8f39a0cec",
        "previousExperimentSha256": format!("{:x}", Sha256::digest(previous_experiment_bytes)),
        "componentBuilderSha256": format!("{:x}", Sha256::digest(include_bytes!("../live_ocr_tests.rs"))),
        "experimentSha256": format!("{:x}", Sha256::digest(include_bytes!("preprocessing.rs"))),
        "manifestSha256": format!("{:x}", Sha256::digest(manifest)),
        "platform": std::env::consts::OS, "architecture": std::env::consts::ARCH,
        "languageVersions": components.language_versions(), "parserVersion": components.parser_version(),
        "sourceCount": source_count, "runCount": rows.len(), "baselineReproduced": baseline_reproduced,
        "anyCandidatePassesStrictAmountGate": candidate_passes, "summaries": summaries,
        "durationMs": started.elapsed().as_millis(), "rows": rows
    });
    serde_json::to_writer_pretty(&mut report, &result).unwrap();
    report.write_all(b"\n").unwrap();
    report.sync_all().unwrap();
    eprintln!("PREPROCESS_SUMMARY {}", result["summaries"]);
    assert!(
        result["rows"].as_array().unwrap().iter().all(|row| {
            let stderr = row["stderr"].as_str().unwrap();
            !stderr.contains("Failed loading language")
                && !stderr.contains("Error opening data file")
        }),
        "model loading diagnostics remain; report retained"
    );
    assert!(
        candidate_passes,
        "no single preprocessing policy passes the strict amount gate; report retained"
    );
}
