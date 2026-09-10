//! Database-derived authority for external conversion. No raw host paths,
//! component paths or resource limits are accepted from model/tool arguments.
use super::*;
use crate::fs::sandbox_exec::{
    components::VerifiedComponents,
    execution::CallIdentity,
    ocr, pdf,
    staging::StagingRoot,
    types::{ExecutionLimits, ExtractMethod, ExtractedDocument, FailureCode, SandboxError},
};

#[derive(Clone, Copy)]
pub struct ExtractionRequest<'a> {
    pub task_id: &'a str,
    pub run_id: &'a str,
    pub batch_token: &'a str,
    pub call_id: &'a str,
    pub relative_path: &'a str,
    pub method: ExtractMethod,
}

struct LeaseSnapshot {
    batch_id: String,
    plan_hash: String,
    source_hash: String,
    extension: String,
    expires_at: i64,
    limits: ExecutionLimits,
}

/// Backend-only conversion evidence. Deliberately excludes document text and
/// lease tokens; model checkpoint arguments cannot replace this receipt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionReceipt {
    pub execution_id: String,
    pub run_id: String,
    pub batch_id: String,
    pub method: ExtractMethod,
    pub parser_version: String,
    pub language_versions: Vec<String>,
    pub pages: Vec<u32>,
    pub complete: bool,
    pub warnings: Vec<String>,
    pub duration_ms: u64,
}

impl ExtractionReceipt {
    pub fn parser(&self) -> &'static str {
        match self.method {
            ExtractMethod::ImageOcr => "image_ocr",
            ExtractMethod::PdfOcr => "pdf_ocr",
        }
    }
}

fn persist_receipt(
    manager: &FolderTaskManager,
    request: &ExtractionRequest<'_>,
    authority: &LeaseSnapshot,
    document: &ExtractedDocument,
) -> Result<(), SandboxError> {
    if document.relative_path != request.relative_path
        || document.source_hash != authority.source_hash
        || document.method != request.method
        || !document.complete
        || document.pages.is_empty()
        || document
            .pages
            .iter()
            .enumerate()
            .any(|(index, page)| page.page as usize != index + 1)
    {
        return Err(SandboxError::new(
            FailureCode::InvalidInput,
            "转换来源与已授权输入不一致",
        ));
    }
    let receipt = ExtractionReceipt {
        execution_id: document.execution_id.clone(),
        run_id: request.run_id.into(),
        batch_id: authority.batch_id.clone(),
        method: document.method,
        parser_version: document.parser_version.clone(),
        language_versions: document.language_versions.clone(),
        pages: document.pages.iter().map(|page| page.page).collect(),
        complete: document.complete,
        warnings: document.warnings.clone(),
        duration_ms: document.duration_ms,
    };
    let encoded = serde_json::to_string(&receipt).map_err(denied)?;
    let changed = manager.connection().map_err(denied)?.execute(
        "UPDATE folder_task_items SET extraction_json = ?1
         WHERE task_id = ?2 AND relative_path = ?3 AND content_hash = ?4 AND status = 'processing'
         AND EXISTS (SELECT 1 FROM folder_task_batch_items bi JOIN folder_task_batches b ON b.id = bi.batch_id
                     WHERE bi.item_id = folder_task_items.id AND b.id = ?5 AND b.run_id = ?6
                     AND b.status = 'active' AND b.lease_expires_at > ?7)",
        params![encoded, request.task_id, request.relative_path, authority.source_hash,
                authority.batch_id, request.run_id, now_ms().map_err(denied)?],
    ).map_err(denied)?;
    if changed != 1 {
        return Err(denied(
            "conversion receipt no longer belongs to active input",
        ));
    }
    Ok(())
}

fn denied(_: impl std::fmt::Display) -> SandboxError {
    SandboxError::new(
        FailureCode::LeaseInvalid,
        "任务、计划或批次授权无效，请刷新任务后重试",
    )
}

fn lease(
    manager: &FolderTaskManager,
    request: &ExtractionRequest<'_>,
) -> Result<LeaseSnapshot, SandboxError> {
    validate_id(request.task_id).map_err(denied)?;
    validate_id(request.run_id).map_err(denied)?;
    validate_id(request.batch_token).map_err(denied)?;
    let relative = validate_relative_path(request.relative_path).map_err(denied)?;
    if portable_path(&relative) != request.relative_path {
        return Err(denied("noncanonical path"));
    }
    let mut connection = manager.connection().map_err(denied)?;
    let transaction = connection.transaction().map_err(denied)?;
    let (status, plan_json, plan_hash): (String, String, Option<String>) = transaction
        .query_row(
            "SELECT status, plan_json, confirmed_plan_hash FROM folder_tasks WHERE id = ?1",
            [request.task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(denied)?;
    if status != "running" {
        return Err(denied("not running"));
    }
    let plan_hash = plan_hash
        .filter(|value| !value.is_empty())
        .ok_or_else(|| denied("unconfirmed plan"))?;
    let now = now_ms().map_err(denied)?;
    let batch = require_active_batch(
        &transaction,
        &manager.instance_id,
        request.task_id,
        request.run_id,
        request.batch_token,
        now,
    )
    .map_err(denied)?;
    let (extension, hash): (String, String) = transaction.query_row(
        "SELECT item.extension, item.content_hash FROM folder_task_items item
         JOIN folder_task_batch_items bi ON bi.item_id = item.id
         WHERE item.task_id = ?1 AND item.relative_path = ?2 AND item.status = 'processing' AND bi.batch_id = ?3",
        params![request.task_id, request.relative_path, batch.id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(denied)?;
    if !request.method.accepts_extension(&extension) {
        return Err(SandboxError::new(
            FailureCode::InvalidInput,
            "转换方法与批次文件类型不符",
        ));
    }
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(SandboxError::new(
            FailureCode::SnapshotChanged,
            "转换需要已确认的完整 SHA-256 快照，请重新扫描",
        ));
    }
    let plan: FolderTaskPlan = from_json(&plan_json, "plan").map_err(denied)?;
    plan.validate().map_err(denied)?;
    if !plan
        .include_extensions
        .iter()
        .any(|value| value.trim().eq_ignore_ascii_case(&extension))
    {
        return Err(denied("extension outside plan"));
    }
    let mut exclusions = GitignoreBuilder::new("");
    for pattern in &plan.exclusions {
        if !pattern.trim().is_empty() {
            exclusions.add_line(None, pattern.trim()).map_err(denied)?;
        }
    }
    if exclusions
        .build()
        .map_err(denied)?
        .matched_path_or_any_parents(&relative, false)
        .is_ignore()
    {
        return Err(denied("path outside plan"));
    }
    let mut limits = ExecutionLimits::for_plan(
        plan.resource_limits.max_pdf_pages,
        usize::try_from(plan.resource_limits.max_parsed_characters_per_file).unwrap_or(usize::MAX),
    )?;
    limits.wall = limits
        .wall
        .min(Duration::from_millis((batch.lease_expires_at - now) as u64));
    Ok(LeaseSnapshot {
        batch_id: batch.id,
        plan_hash,
        source_hash: hash,
        extension,
        expires_at: batch.lease_expires_at,
        limits,
    })
}

fn recheck(
    manager: &FolderTaskManager,
    request: &ExtractionRequest<'_>,
    original: &LeaseSnapshot,
) -> Result<(), SandboxError> {
    // A renewal elsewhere cannot prolong this conversion's original lease.
    if now_ms().map_err(denied)? >= original.expires_at {
        return Err(denied("original lease expired"));
    }
    let current = lease(manager, request)?;
    if current.batch_id != original.batch_id
        || current.plan_hash != original.plan_hash
        || current.source_hash != original.source_hash
    {
        return Err(denied("authorization changed"));
    }
    Ok(())
}

/// Invoked by the IPC service with trusted installed components only.
/// Preparing registration precedes file I/O; the guard outlives staged files.
pub(super) fn extract(
    manager: &FolderTaskManager,
    components: &VerifiedComponents,
    staging: &Arc<StagingRoot>,
    worker: &Path,
    request: &ExtractionRequest<'_>,
    on_stop_delay: impl Fn(),
) -> Result<ExtractedDocument, SandboxError> {
    let authority = lease(manager, request)?;
    if !components.supports(request.method) {
        return Err(SandboxError::new(
            FailureCode::DependencyMissing,
            "所需转换组件不可用",
        ));
    }
    let identity = CallIdentity::new(request.task_id, request.run_id, request.call_id)?;
    let guard = manager.executions.begin_document(
        identity,
        &authority.batch_id,
        authority.limits.wall,
        request.relative_path,
        request.method,
    )?;
    recheck(manager, request, &authority)?;
    let snapshot = read_folder_task_snapshot_impl(
        manager,
        request.task_id,
        request.run_id,
        request.batch_token,
        request.relative_path,
        false,
    );
    let bytes = match snapshot {
        Ok(bytes) => bytes,
        Err(_) => {
            guard.check()?;
            recheck(manager, request, &authority)?;
            return Err(SandboxError::new(
                FailureCode::SnapshotChanged,
                "无法获取与已确认快照一致的输入，请刷新或重新扫描",
            ));
        }
    };
    guard.check()?;
    let staged = staging.stage(
        &bytes.bytes,
        &authority.source_hash,
        &authority.extension,
        authority.limits.max_input_bytes,
    )?;
    drop(bytes);
    recheck(manager, request, &authority)?;
    guard.start()?;
    if request.method == ExtractMethod::ImageOcr {
        guard.report_pages(0, 1)?;
    }
    let check = || {
        guard.check()?;
        recheck(manager, request, &authority)
    };
    let task_lock = guard.task_lock()?;
    let result = match request.method {
        ExtractMethod::ImageOcr => ocr::extract_image_with_task_lock(
            worker,
            components,
            &staged,
            guard.id(),
            request.relative_path,
            authority.limits.clone(),
            &check,
            &on_stop_delay,
            task_lock.as_deref(),
        ),
        ExtractMethod::PdfOcr => pdf::extract_pdf_with_progress(
            worker,
            components,
            &staged,
            guard.id(),
            request.relative_path,
            authority.limits.clone(),
            &check,
            &on_stop_delay,
            |completed, total| guard.report_pages(completed, total),
            task_lock.as_deref(),
        ),
    }?;
    guard.report_pages(result.pages.len() as u32, result.pages.len() as u32)?;
    guard.accept(|| {
        recheck(manager, request, &authority)?;
        persist_receipt(manager, request, &authority, &result)?;
        Ok(result)
    })
}

pub(super) fn cancel(
    manager: &FolderTaskManager,
    request: &ExtractionRequest<'_>,
) -> Result<(), SandboxError> {
    lease(manager, request)?;
    manager.executions.cancel_call(&CallIdentity::new(
        request.task_id,
        request.run_id,
        request.call_id,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_receipt_survives_checkpoint_reopen_and_both_output_formats() {
        let owner = StagingRoot::create().unwrap();
        let staged = owner
            .stage(b"seed", &sha256_bytes(b"seed"), "png", 1024)
            .unwrap();
        let input = staged.work.join("input");
        fs::create_dir(&input).unwrap();
        fs::write(input.join("scan.pdf"), b"%PDF-fixture").unwrap();
        let database = staged.work.join("tasks.sqlite3");
        let manager = FolderTaskManager::for_test(database.clone()).unwrap();
        let mut detail = create_folder_task_impl(
            &manager,
            input.clone(),
            "OCR".into(),
            "Review".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        // Simulate an existing v7 database, then exercise the additive migration
        // with an inventoried task already present.
        manager
            .connection()
            .unwrap()
            .execute_batch(
                "ALTER TABLE folder_task_items DROP COLUMN extraction_json;
             UPDATE folder_task_meta SET value = '7' WHERE key = 'schema_version';",
            )
            .unwrap();
        drop(manager);
        let manager = FolderTaskManager::for_test(database.clone()).unwrap();
        detail.plan.output.auto_write = true;
        detail.plan.output.format = "json".into();
        detail.plan.output.relative_path = ".solidify/outputs/receipt.json".into();
        let detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        let claim =
            claim_folder_task_batch_impl(&manager, &detail.summary.id, "run-receipt", 1).unwrap();
        let batch = claim.batch.unwrap();
        let request = ExtractionRequest {
            task_id: &detail.summary.id,
            run_id: "run-receipt",
            batch_token: &batch.lease_token,
            call_id: "receipt",
            relative_path: "scan.pdf",
            method: ExtractMethod::PdfOcr,
        };
        let authority = lease(&manager, &request).unwrap();
        let document = ExtractedDocument {
            execution_id: "execution-receipt".into(),
            relative_path: "scan.pdf".into(),
            source_hash: authority.source_hash.clone(),
            method: ExtractMethod::PdfOcr,
            parser_version: "poppler:fixture;tesseract:fixture".into(),
            language_versions: vec!["chi_sim:fixture".into(), "eng:fixture".into()],
            pages: vec![crate::fs::sandbox_exec::types::ExtractedPage {
                page: 1,
                text: "private OCR text".into(),
            }],
            complete: true,
            warnings: vec!["OCR 金额需核对".into()],
            duration_ms: 42,
        };
        persist_receipt(&manager, &request, &authority, &document).unwrap();
        let detail = update_folder_task_batch_impl(
            &manager,
            request.task_id,
            request.run_id,
            request.batch_token,
            vec![FolderTaskItemUpdate {
                item_id: claim.items[0].id.clone(),
                status: "completed".into(),
                result: Some(
                    json!({"summary": "reviewed", "facts": [], "parserVersion": "model-invented"}),
                ),
                error: None,
            }],
            None,
            "complete",
        )
        .unwrap();
        assert!(
            persist_receipt(&manager, &request, &authority, &document).is_err(),
            "completed batch must reject late evidence"
        );
        let output = detail.latest_output.as_ref().unwrap();
        let payload: Value =
            serde_json::from_slice(&fs::read(input.join(&output.relative_path)).unwrap()).unwrap();
        let provenance = &payload["records"][0]["provenance"][0];
        assert_eq!(provenance["parser"], "pdf_ocr");
        assert_eq!(provenance["parserVersion"], document.parser_version);
        assert_eq!(provenance["sourceHash"], document.source_hash);
        assert_eq!(provenance["extraction"]["pages"], json!([1]));
        assert_eq!(
            provenance["extraction"]["warnings"],
            json!(document.warnings)
        );
        assert_eq!(
            provenance["extraction"]["languageVersions"],
            json!(document.language_versions)
        );
        assert!(!provenance.to_string().contains("private OCR text"));
        assert!(!provenance.to_string().contains(&batch.lease_token));
        drop(manager);
        let reopened = FolderTaskManager::for_test(database).unwrap();
        let item = get_item(
            &reopened.connection().unwrap(),
            request.task_id,
            &claim.items[0].id,
        )
        .unwrap();
        assert_eq!(serde_json::to_value(&item.provenance).unwrap(), *provenance);
        let bytes = build_xlsx_output(&payload, &[item]).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut sheet = String::new();
        archive
            .by_name("xl/worksheets/sheet2.xml")
            .unwrap()
            .read_to_string(&mut sheet)
            .unwrap();
        for expected in [
            "pdf_ocr",
            "execution-receipt",
            "OCR 金额需核对",
            "chi_sim:fixture",
            "&quot;pages&quot;:[1]",
        ] {
            assert!(
                sheet.contains(expected),
                "missing XLSX evidence: {expected}"
            );
        }
    }

    #[test]
    fn receipt_rejects_wrong_input_and_is_cleared_when_reclaimed() {
        let owner = StagingRoot::create().unwrap();
        let staged = owner
            .stage(b"seed", &sha256_bytes(b"seed"), "png", 1024)
            .unwrap();
        let input = staged.work.join("input");
        fs::create_dir(&input).unwrap();
        fs::write(input.join("scan.pdf"), b"%PDF-fixture").unwrap();
        let manager = FolderTaskManager::for_test(staged.work.join("tasks.sqlite3")).unwrap();
        let detail = create_folder_task_impl(
            &manager,
            input,
            "OCR".into(),
            "Review".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        let detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        let claim =
            claim_folder_task_batch_impl(&manager, &detail.summary.id, "run-first", 1).unwrap();
        let batch = claim.batch.unwrap();
        let request = ExtractionRequest {
            task_id: &detail.summary.id,
            run_id: "run-first",
            batch_token: &batch.lease_token,
            call_id: "receipt",
            relative_path: "scan.pdf",
            method: ExtractMethod::PdfOcr,
        };
        let authority = lease(&manager, &request).unwrap();
        let mut document = ExtractedDocument {
            execution_id: "execution-first".into(),
            relative_path: "scan.pdf".into(),
            source_hash: "wrong-hash".into(),
            method: ExtractMethod::PdfOcr,
            parser_version: "fixture".into(),
            language_versions: vec![],
            pages: vec![crate::fs::sandbox_exec::types::ExtractedPage {
                page: 1,
                text: "text".into(),
            }],
            complete: true,
            warnings: vec![],
            duration_ms: 1,
        };
        assert!(persist_receipt(&manager, &request, &authority, &document).is_err());
        document.source_hash = authority.source_hash.clone();
        document.complete = false;
        assert!(persist_receipt(&manager, &request, &authority, &document).is_err());
        document.complete = true;
        document.pages[0].page = 2;
        assert!(persist_receipt(&manager, &request, &authority, &document).is_err());
        document.pages[0].page = 1;
        persist_receipt(&manager, &request, &authority, &document).unwrap();
        // An interrupted checkpoint requeues this uncommitted item. Its next
        // claim must not inherit the previous conversion's metadata.
        let (_, revision) =
            current_status_and_revision(&manager.connection().unwrap(), request.task_id).unwrap();
        let paused =
            set_folder_task_status_impl(&manager, request.task_id, "pause", revision).unwrap();
        assert!(persist_receipt(&manager, &request, &authority, &document).is_err());
        set_folder_task_status_impl(&manager, request.task_id, "resume", paused.summary.revision)
            .unwrap();
        let next =
            claim_folder_task_batch_impl(&manager, request.task_id, "run-second", 1).unwrap();
        assert_eq!(next.items.len(), 1);
        assert!(next.items[0].provenance.extraction.is_none());
    }

    #[test]
    fn authority_requires_current_batch_plan_method_and_unchanged_lease() {
        let owner = StagingRoot::create().unwrap();
        let bytes = b"%PDF-fixture";
        let staged = owner
            .stage(bytes, &sha256_bytes(bytes), "pdf", 1024)
            .unwrap();
        let input = staged.work.join("documents");
        fs::create_dir(&input).unwrap();
        fs::write(input.join("scan.pdf"), bytes).unwrap();
        let manager = FolderTaskManager::for_test(staged.work.join("tasks.sqlite3")).unwrap();
        let detail = create_folder_task_impl(
            &manager,
            input,
            "test".into(),
            "test".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        let detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        let batch = claim_folder_task_batch_impl(&manager, &detail.summary.id, "run-auth", 1)
            .unwrap()
            .batch
            .unwrap();
        let request = ExtractionRequest {
            task_id: &detail.summary.id,
            run_id: "run-auth",
            batch_token: &batch.lease_token,
            call_id: "call-auth",
            relative_path: "scan.pdf",
            method: ExtractMethod::PdfOcr,
        };
        let original = lease(&manager, &request).unwrap();
        assert_eq!(original.source_hash, sha256_bytes(bytes));
        assert_eq!(original.limits.max_pages, 20);
        for invalid in [
            ExtractionRequest {
                run_id: "other",
                ..request
            },
            ExtractionRequest {
                batch_token: "fake",
                ..request
            },
            ExtractionRequest {
                relative_path: "../scan.pdf",
                ..request
            },
            ExtractionRequest {
                relative_path: "unclaimed.pdf",
                ..request
            },
            ExtractionRequest {
                method: ExtractMethod::ImageOcr,
                ..request
            },
        ] {
            assert!(lease(&manager, &invalid).is_err());
        }
        read_folder_task_snapshot_impl(
            &manager,
            request.task_id,
            request.run_id,
            request.batch_token,
            request.relative_path,
            false,
        )
        .unwrap();
        assert_eq!(
            lease(&manager, &request).unwrap().expires_at,
            original.expires_at,
            "conversion reads must not renew leases"
        );
        let connection = manager.connection().unwrap();
        let mut excluded = detail.plan.clone();
        excluded.exclusions.push("scan.pdf".into());
        connection
            .execute(
                "UPDATE folder_tasks SET plan_json = ?1 WHERE id = ?2",
                params![serde_json::to_string(&excluded).unwrap(), request.task_id],
            )
            .unwrap();
        assert!(lease(&manager, &request).is_err());
        connection
            .execute(
                "UPDATE folder_tasks SET plan_json = ?1 WHERE id = ?2",
                params![
                    serde_json::to_string(&detail.plan).unwrap(),
                    request.task_id
                ],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE folder_task_items SET status = 'pending' WHERE task_id = ?1",
                [request.task_id],
            )
            .unwrap();
        assert!(lease(&manager, &request).is_err());
        connection
            .execute(
                "UPDATE folder_task_items SET status = 'processing' WHERE task_id = ?1",
                [request.task_id],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE folder_task_batches SET lease_expires_at = 1 WHERE id = ?1",
                [&batch.id],
            )
            .unwrap();
        assert!(recheck(&manager, &request, &original).is_err());
    }
}
