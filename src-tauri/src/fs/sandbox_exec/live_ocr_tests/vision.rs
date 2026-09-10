//! Candidate feasibility only. No production capability or policy changes.
use super::super::super::{policy::ProcessJob, supervisor};
use super::*;

#[test]
#[ignore = "Apple Vision candidate in existing Seatbelt; requires Swift and built app"]
fn live_vision_ocr_candidate() {
    compare(false, false);
}

#[test]
#[ignore = "Apple Vision raw pixels in existing Seatbelt; requires Swift and built app"]
fn live_vision_raw_pixel_candidate() {
    compare(true, false);
}

#[test]
#[ignore = "HOST-ONLY Vision quality diagnostic, never isolation evidence"]
fn live_vision_host_quality_diagnostic() {
    compare(false, true);
}

fn compare(raw_pixels: bool, host_diagnostic: bool) {
    let started = Instant::now();
    let report_path =
        PathBuf::from(std::env::var_os("SOLIDIFY_TEST_OCR_REPORT").expect("set new report path"));
    assert!(report_path.is_absolute());
    let mut report = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(report_path)
        .unwrap();
    let owner = StagingRoot::create().unwrap();
    let seed = b"vision-candidate";
    let hash = format!("{:x}", Sha256::digest(seed));
    let fixture = owner.stage(seed, &hash, "png", 1024).unwrap();
    let data = owner.stage(seed, &hash, "png", 1024).unwrap();
    let tools = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("tools");
    let generator = tools.join("generate-ocr-quality-corpus.swift");
    let script = tools.join("ocr-vision-probe.swift");
    let binary = data.work.join("vision-probe");
    let compile = std::process::Command::new("/usr/bin/swiftc")
        .args(["-O", "-module-cache-path"])
        .arg(data.work.join("swift-cache"))
        .arg(&script)
        .arg("-o")
        .arg(&binary)
        .output()
        .unwrap();
    assert!(
        compile.status.success(),
        "{}",
        String::from_utf8_lossy(&compile.stderr)
    );
    let generated = std::process::Command::new("/usr/bin/swift")
        .arg("-module-cache-path")
        .arg(fixture.work.join("swift-cache"))
        .arg(&generator)
        .arg(&fixture.work)
        .output()
        .unwrap();
    assert!(
        generated.status.success(),
        "{}",
        String::from_utf8_lossy(&generated.stderr)
    );
    let manifest = std::fs::read(fixture.work.join("corpus.json")).unwrap();
    let corpus: Corpus = serde_json::from_slice(&manifest).unwrap();
    let baseline_bytes = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../docs/ocr-quality/2026-09-10-preprocessing-complete-dependencies.json"
    ));
    let baseline: serde_json::Value = serde_json::from_slice(baseline_bytes).unwrap();
    let generator_hash = format!("{:x}", Sha256::digest(std::fs::read(&generator).unwrap()));
    assert_eq!(baseline["generatorSha256"], generator_hash);
    let worker = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("solidify");
    let mut rows = Vec::new();
    let mut process_failure = None;
    for case in corpus
        .cases
        .into_iter()
        .filter(|case| case.file.ends_with(".png"))
    {
        let bytes = std::fs::read(fixture.work.join(&case.file)).unwrap();
        let source_hash = format!("{:x}", Sha256::digest(&bytes));
        let previous = baseline["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["file"] == case.file && row["variant"] == "original")
            .unwrap();
        assert_eq!(previous["sourceSha256"], source_hash);
        let staged_bytes = if raw_pixels {
            let image = image::load_from_memory(&bytes).unwrap().to_rgba8();
            assert_eq!(image.dimensions(), (1600, 700));
            assert!(image.pixels().all(|pixel| pixel[3] == 255));
            image.into_raw()
        } else {
            bytes
        };
        let input_hash = format!("{:x}", Sha256::digest(&staged_bytes));
        let input = owner
            .stage(&staged_bytes, &input_hash, "png", 25 * 1024 * 1024)
            .unwrap();
        let mut args = vec![input.input.to_str().unwrap().into()];
        if raw_pixels {
            args.push("--rgba".into());
        }
        let output = if host_diagnostic {
            assert!(!raw_pixels);
            let output = std::process::Command::new("/usr/bin/python3")
                .arg(tools.join("run-ocr-host-probe.py"))
                .arg(&binary)
                .arg(&input.input)
                .arg(&input.work)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            Ok(
                serde_json::from_slice::<super::super::super::worker::ProcessOutput>(
                    &output.stdout,
                )
                .unwrap(),
            )
        } else {
            supervisor::run(
                &worker,
                &ProcessJob {
                    binary: binary.clone(),
                    args,
                    input: input.input.clone(),
                    work: input.work.clone(),
                    runtime_read: vec![],
                    wall_ms: 60_000,
                    cpu_seconds: 30,
                    max_file_bytes: 64 * 1024 * 1024,
                    max_work_bytes: 128 * 1024 * 1024,
                    max_output_bytes: 64 * 1024,
                },
                &|| {
                    if started.elapsed().as_secs() < 600 {
                        Ok(())
                    } else {
                        Err(SandboxError::new(
                            FailureCode::TimedOut,
                            "candidate experiment budget reached",
                        ))
                    }
                },
                &|| panic!("unexpected stop delay"),
            )
        };
        assert_eq!(
            format!("{:x}", Sha256::digest(std::fs::read(&input.input).unwrap())),
            input_hash
        );
        let work_empty = std::fs::read_dir(&input.work).unwrap().next().is_none();
        if !host_diagnostic {
            assert!(work_empty);
        }
        let output = match output {
            Ok(output) => output,
            Err(error) => {
                process_failure = Some(
                    serde_json::json!({"file": case.file, "code": error.code, "message": error.to_string()}),
                );
                break;
            }
        };
        let payload = serde_json::from_slice::<serde_json::Value>(&output.stdout).ok();
        if output.exit_code != Some(0) || payload.as_ref().map_or(true, |p| p["success"] != true) {
            process_failure = Some(
                serde_json::json!({"file": case.file, "exitCode": output.exit_code,
                "stdout": String::from_utf8_lossy(&output.stdout), "stderr": String::from_utf8_lossy(&output.stderr),
                "payload": payload}),
            );
            break;
        }
        let payload = payload.unwrap();
        let text = payload["text"].as_str().unwrap();
        let expected = &case.pages[0];
        let exact = amount_exact(text, &expected.amount);
        let missing: Vec<_> = expected
            .control_lines
            .iter()
            .filter(|line| !compact(text).contains(&compact(line)))
            .collect();
        let row = serde_json::json!({"file": case.file, "expected": expected, "sourceSha256": source_hash,
            "inputSha256": input_hash,
            "workEmpty": work_empty,
            "amountExact": exact, "missingControlLines": missing,
            "strictImprovement": previous["amountExact"] == false && exact,
            "strictRegression": previous["amountExact"] == true && !exact,
            "payload": payload, "stderr": String::from_utf8_lossy(&output.stderr), "durationMs": output.duration_ms});
        eprintln!("VISION_ROW {row}");
        rows.push(row);
    }
    let result = serde_json::json!({"schemaVersion": 1, "engine": "Apple Vision",
        "isolation": if host_diagnostic { "HOST-ONLY-no-confinement" } else { "existing-seatbelt-policy" },
        "hostRunnerSha256": if host_diagnostic { Some(format!("{:x}", Sha256::digest(std::fs::read(tools.join("run-ocr-host-probe.py")).unwrap()))) } else { None },
        "inputEncoding": if raw_pixels { "rgba8-1600x700" } else { "png-data" },
        "scriptSha256": format!("{:x}", Sha256::digest(std::fs::read(&script).unwrap())),
        "binarySha256": format!("{:x}", Sha256::digest(std::fs::read(&binary).unwrap())),
        "experimentSha256": format!("{:x}", Sha256::digest(include_bytes!("vision.rs"))),
        "baselineSha256": format!("{:x}", Sha256::digest(baseline_bytes)), "generatorSha256": generator_hash,
        "manifestSha256": format!("{:x}", Sha256::digest(manifest)), "processFailure": process_failure,
        "completed": rows.len() == 32, "runCount": rows.len(),
        "amountExactCount": rows.iter().filter(|row| row["amountExact"] == true).count(),
        "strictImprovements": rows.iter().filter(|row| row["strictImprovement"] == true).count(),
        "strictRegressions": rows.iter().filter(|row| row["strictRegression"] == true).count(),
        "durationMs": started.elapsed().as_millis(), "rows": rows});
    serde_json::to_writer_pretty(&mut report, &result).unwrap();
    report.write_all(b"\n").unwrap();
    report.sync_all().unwrap();
    eprintln!(
        "VISION_SUMMARY completed={} amountExact={} failure={}",
        result["completed"], result["amountExactCount"], result["processFailure"]
    );
    assert!(
        process_failure.is_none(),
        "candidate process failed; inspect isolation mode in retained report"
    );
    assert_eq!(rows.len(), 32);
    assert!(
        rows.iter().all(|row| row["amountExact"] == true
            && row["missingControlLines"].as_array().unwrap().is_empty()),
        "candidate fails unchanged strict quality gate; report retained"
    );
}
