//! Explicit retry preserves the confirmed scope and exact inventory snapshot.
use super::*;
use crate::fs::sandbox_exec::types::ExtractMethod;

pub(super) fn validate(
    manager: &FolderTaskManager,
    task: &str,
    updates: &[FolderTaskReviewUpdate],
    revision: u64,
    check_method: impl Fn(ExtractMethod) -> Result<(), String>,
) -> Result<(), String> {
    if !updates.iter().any(|update| update.action == "retry") {
        return Ok(());
    }
    let connection = manager.connection()?;
    require_status_and_revision(
        &connection,
        task,
        &[
            FolderTaskStatus::Reviewing,
            FolderTaskStatus::Paused,
            FolderTaskStatus::Failed,
            FolderTaskStatus::Completed,
        ],
        revision,
    )?;
    let (root, plan_json, confirmed): (String, String, Option<String>) = connection
        .query_row(
            "SELECT root_path, plan_json, confirmed_plan_hash FROM folder_tasks WHERE id = ?1",
            [task],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| error.to_string())?;
    if confirmed
        .as_ref()
        .map_or(true, |hash| hash.trim().is_empty())
    {
        return Err("重试需要已确认的任务计划，请先重新确认范围".into());
    }
    let plan: FolderTaskPlan = from_json(&plan_json, "folder task plan")?;
    plan.validate()?;
    let mut builder = GitignoreBuilder::new("");
    for pattern in &plan.exclusions {
        if !pattern.trim().is_empty() {
            builder
                .add_line(None, pattern.trim())
                .map_err(|error| error.to_string())?;
        }
    }
    let exclusions = builder.build().map_err(|error| error.to_string())?;
    let root =
        fs::canonicalize(root).map_err(|_| "任务目录不可用，请重新选择并扫描".to_string())?;
    let mut total = 0_u64;
    let mut checked_methods = BTreeSet::new();
    let mut seen = BTreeSet::new();
    for update in updates.iter().filter(|update| update.action == "retry") {
        validate_id(&update.item_id)?;
        if !seen.insert(&update.item_id) {
            return Err("重复的重试项目".into());
        }
        let (path, extension, status, size, modified, hash): (String, String, String, u64, i64, String) = connection.query_row(
            "SELECT relative_path, extension, status, size, modified_at, content_hash FROM folder_task_items WHERE task_id = ?1 AND id = ?2",
            params![task, update.item_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        ).map_err(|error| map_not_found(error, "Folder task item"))?;
        if !matches!(
            status.as_str(),
            "completed" | "failed" | "skipped" | "manual_review" | "awaiting_external_parser"
        ) {
            return Err("当前文件状态不允许重试".into());
        }
        let relative = validate_relative_path(&path)?;
        if !plan
            .include_extensions
            .iter()
            .any(|item| item.trim().eq_ignore_ascii_case(&extension))
            || exclusions
                .matched_path_or_any_parents(&relative, false)
                .is_ignore()
        {
            return Err(format!(
                "{path} 不属于已确认计划；请重新确认范围或创建新任务，不能直接重试"
            ));
        }
        let method = if is_external_image_extension(&extension) {
            Some(ExtractMethod::ImageOcr)
        } else if extension == "pdf" && status == "awaiting_external_parser" {
            Some(ExtractMethod::PdfOcr)
        } else if is_model_readable_extension(&extension) {
            None
        } else {
            return Err(format!("{path} 当前没有可用解析方法，请转换格式后重新扫描"));
        };
        if let Some(method) = method {
            // Cache only within this bounded preflight; execution probes again.
            let key = if method == ExtractMethod::ImageOcr {
                "image"
            } else {
                "pdf"
            };
            if checked_methods.insert(key) {
                check_method(method)?;
            }
        }
        total = total.saturating_add(size);
        if size > MAX_MODEL_FILE_BYTES || total > 200 * 1024 * 1024 {
            return Err("重试快照校验超过读取预算，请缩小本次选择范围".into());
        }
        let mut file = open_task_snapshot(&root, &relative)?;
        let before = file.metadata().map_err(|error| error.to_string())?;
        let mtime = before
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_millis() as i64);
        if !before.is_file() || before.len() != size || mtime != Some(modified) || hash.len() != 64
        {
            return Err(format!("{path} 已变化或缺少可信快照，请重新扫描并确认计划"));
        }
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        let mut read = 0_u64;
        loop {
            let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            read += count as u64;
            if read > size {
                return Err(format!("{path} 在校验期间发生变化，请重新扫描"));
            }
            digest.update(&buffer[..count]);
        }
        let after = file.metadata().map_err(|error| error.to_string())?;
        if read != size
            || before.len() != after.len()
            || before.modified().ok() != after.modified().ok()
            || format!("{:x}", digest.finalize()) != hash
        {
            return Err(format!("{path} 与已确认快照不一致，请重新扫描并确认计划"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(
        exclude_image: bool,
    ) -> (
        PathBuf,
        FolderTaskManager,
        FolderTaskDetail,
        Vec<FolderTaskItem>,
    ) {
        let root = std::env::temp_dir().join(format!("solidify-retry-{}", Uuid::new_v4()));
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("one.txt"), b"original").unwrap();
        fs::write(input.join("scan.png"), b"format-fixture").unwrap();
        let manager = FolderTaskManager::for_test(root.join("tasks.sqlite3")).unwrap();
        let mut detail = create_folder_task_impl(
            &manager,
            input,
            "retry".into(),
            "retry".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        if exclude_image {
            detail.plan.include_extensions = vec!["txt".into()];
        }
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        detail = set_folder_task_status_impl(
            &manager,
            &detail.summary.id,
            "pause",
            detail.summary.revision,
        )
        .unwrap();
        manager.connection().unwrap().execute("UPDATE folder_task_items SET status = 'failed' WHERE task_id = ?1 AND status = 'pending'", [&detail.summary.id]).unwrap();
        let items = list_folder_task_items_impl(&manager, &detail.summary.id, None, 0, 10).unwrap();
        (root, manager, detail, items)
    }

    fn retry(item: &FolderTaskItem) -> FolderTaskReviewUpdate {
        FolderTaskReviewUpdate {
            item_id: item.id.clone(),
            action: "retry".into(),
            result: None,
            error: None,
        }
    }

    #[test]
    fn missing_component_rolls_back_entire_selection_then_explicit_ready_retry_succeeds() {
        let (root, manager, detail, items) = fixture(false);
        let request = || items.iter().map(retry).collect();
        let error = review_folder_task_items_with_capability(
            &manager,
            &detail.summary.id,
            request(),
            detail.summary.revision,
            |_| Err("dependency_missing".into()),
        )
        .unwrap_err();
        assert!(error.contains("dependency_missing"));
        let unchanged = get_folder_task_impl(&manager, &detail.summary.id).unwrap();
        assert_eq!(unchanged.summary.revision, detail.summary.revision);
        assert_eq!(unchanged.summary.progress.pending, 0);
        assert_eq!(unchanged.summary.progress.failed, 2);
        let ready = review_folder_task_items_with_capability(
            &manager,
            &detail.summary.id,
            request(),
            detail.summary.revision,
            |method| {
                assert_eq!(method, ExtractMethod::ImageOcr);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(ready.summary.status, FolderTaskStatus::Running);
        assert_eq!(ready.summary.progress.pending, 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retry_cannot_expand_confirmed_extensions_or_patterns() {
        let (root, manager, detail, items) = fixture(true);
        let image = items.iter().find(|item| item.extension == "png").unwrap();
        let error = review_folder_task_items_with_capability(
            &manager,
            &detail.summary.id,
            vec![retry(image)],
            detail.summary.revision,
            |_| panic!("scope must be checked before component activation"),
        )
        .unwrap_err();
        assert!(error.contains("不属于已确认计划"));
        assert_eq!(
            get_folder_task_impl(&manager, &detail.summary.id)
                .unwrap()
                .summary
                .revision,
            detail.summary.revision
        );
        let mut plan = detail.plan.clone();
        plan.exclusions = vec!["one.txt".into()];
        manager
            .connection()
            .unwrap()
            .execute(
                "UPDATE folder_tasks SET plan_json = ?1 WHERE id = ?2",
                params![to_json(&plan).unwrap(), detail.summary.id],
            )
            .unwrap();
        let text = items.iter().find(|item| item.extension == "txt").unwrap();
        assert!(review_folder_task_items_impl(
            &manager,
            &detail.summary.id,
            vec![retry(text)],
            detail.summary.revision
        )
        .unwrap_err()
        .contains("不属于已确认计划"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_retry_needs_no_ocr_but_waiting_pdf_requires_pdf_components() {
        let (root, manager, detail, items) = fixture(false);
        let text = items.iter().find(|item| item.extension == "txt").unwrap();
        // First prove a native retry does not consult the external runtime.
        let result = review_folder_task_items_with_capability(
            &manager,
            &detail.summary.id,
            vec![retry(text)],
            detail.summary.revision,
            |_| panic!("native parsing does not require OCR"),
        )
        .unwrap();
        assert_eq!(result.summary.progress.pending, 1);
        let detail = set_folder_task_status_impl(
            &manager,
            &detail.summary.id,
            "pause",
            result.summary.revision,
        )
        .unwrap();
        // Model a previously inventoried PDF in the dependency-wait state.
        fs::rename(root.join("input/one.txt"), root.join("input/scan.pdf")).unwrap();
        let mut plan = detail.plan.clone();
        plan.include_extensions.push("pdf".into());
        let connection = manager.connection().unwrap();
        connection
            .execute(
                "UPDATE folder_tasks SET plan_json = ?1 WHERE id = ?2",
                params![to_json(&plan).unwrap(), detail.summary.id],
            )
            .unwrap();
        connection.execute("UPDATE folder_task_items SET relative_path = 'scan.pdf', extension = 'pdf', status = 'awaiting_external_parser', error = 'dependency_missing' WHERE id = ?1", [&text.id]).unwrap();
        let error = review_folder_task_items_with_capability(
            &manager,
            &detail.summary.id,
            vec![retry(text)],
            detail.summary.revision,
            |method| {
                assert_eq!(method, ExtractMethod::PdfOcr);
                Err("PDF renderer missing".into())
            },
        )
        .unwrap_err();
        assert!(error.contains("PDF renderer missing"));
        let result = review_folder_task_items_with_capability(
            &manager,
            &detail.summary.id,
            vec![retry(text)],
            detail.summary.revision,
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(result.summary.progress.awaiting_external_parser, 0);
        let history: String = connection.query_row("SELECT data_json FROM folder_task_events WHERE task_id = ?1 AND event_type = 'item.retry_requested' ORDER BY seq DESC LIMIT 1", [&detail.summary.id], |row| row.get(0)).unwrap();
        assert!(history.contains("dependency_missing"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changed_snapshot_and_active_converter_both_block_retry() {
        use crate::fs::sandbox_exec::execution::CallIdentity;
        let (root, manager, detail, items) = fixture(false);
        let text = items.iter().find(|item| item.extension == "txt").unwrap();
        let active = manager
            .executions
            .begin(
                CallIdentity::new(&detail.summary.id, "run", "call").unwrap(),
                "batch",
                Duration::from_secs(10),
            )
            .unwrap();
        assert!(review_folder_task_items_impl(
            &manager,
            &detail.summary.id,
            vec![retry(text)],
            detail.summary.revision
        )
        .is_err());
        assert!(active.check().is_ok());
        drop(active);
        fs::write(root.join("input/one.txt"), b"modified").unwrap();
        assert!(review_folder_task_items_impl(
            &manager,
            &detail.summary.id,
            vec![retry(text)],
            detail.summary.revision
        )
        .unwrap_err()
        .contains("重新扫描"));
        assert_eq!(
            get_folder_task_impl(&manager, &detail.summary.id)
                .unwrap()
                .summary
                .progress
                .pending,
            0
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn retry_rejects_symlink_replacement() {
        let (root, manager, detail, items) = fixture(false);
        let text = items.iter().find(|item| item.extension == "txt").unwrap();
        fs::rename(root.join("input/one.txt"), root.join("outside.txt")).unwrap();
        std::os::unix::fs::symlink(root.join("outside.txt"), root.join("input/one.txt")).unwrap();
        assert!(review_folder_task_items_impl(
            &manager,
            &detail.summary.id,
            vec![retry(text)],
            detail.summary.revision
        )
        .is_err());
        assert_eq!(
            get_folder_task_impl(&manager, &detail.summary.id)
                .unwrap()
                .summary
                .progress
                .pending,
            0
        );
        fs::remove_dir_all(root).unwrap();
    }
}
