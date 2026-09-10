//! Durable exit checkpoint, scoped to batches claimed by this app instance.
use super::*;

impl FolderTaskManager {
    pub(crate) fn finish_shutdown_batches(&self) -> Result<(), String> {
        if !self
            .executions
            .shutdown_drained()
            .map_err(|error| error.to_string())?
        {
            return Err(
                "Converters and task mutations must finish before releasing exit batches".into(),
            );
        }
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let batches: Vec<(String, String, String)> = {
            let mut statement = transaction.prepare(
                "SELECT id, task_id, run_id FROM folder_task_batches WHERE owner_instance_id = ?1 AND status = 'active' ORDER BY task_id, id"
            ).map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([&self.instance_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .map_err(|error| error.to_string())?;
            rows.collect::<Result<_, _>>()
                .map_err(|error| error.to_string())?
        };
        let now = now_ms()?;
        for (batch, task, run) in batches {
            let released = transaction.execute(
                "UPDATE folder_task_items SET status = 'pending', result_json = NULL, error = NULL, extraction_json = NULL
                 WHERE task_id = ?1 AND status = 'processing' AND id IN
                 (SELECT item_id FROM folder_task_batch_items WHERE batch_id = ?2)",
                params![task, batch],
            ).map_err(|error| error.to_string())?;
            transaction.execute(
                "UPDATE folder_task_batches SET status = 'interrupted', completed_at = ?1, checkpoint_note = 'Application exited after converter cleanup'
                 WHERE id = ?2 AND owner_instance_id = ?3 AND status = 'active'",
                params![now, batch, self.instance_id],
            ).map_err(|error| error.to_string())?;
            transaction.execute(
                "UPDATE folder_task_runs SET status = 'aborted', error = 'Application exited after converter cleanup', updated_at = ?1, completed_at = ?1
                 WHERE run_id = ?2 AND task_id = ?3 AND status = 'active'
                 AND NOT EXISTS (SELECT 1 FROM folder_task_batches WHERE run_id = ?2 AND status = 'active')",
                params![now, run, task],
            ).map_err(|error| error.to_string())?;
            transaction.execute(
                "UPDATE folder_tasks SET status = CASE WHEN status = 'running' THEN 'paused' ELSE status END,
                 updated_at = ?1, revision = revision + 1
                 WHERE id = ?2 AND NOT EXISTS (SELECT 1 FROM folder_task_batches WHERE task_id = ?2 AND status = 'active')",
                params![now, task],
            ).map_err(|error| error.to_string())?;
            append_event(
                &transaction,
                &task,
                "batch.released",
                json!({ "batchId": batch, "runId": run, "outcome": "app_exit", "releasedItems": released }),
                now,
            )?;
        }
        transaction.commit().map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::sandbox_exec::{
        execution::CallIdentity,
        staging::{StagedInput, StagingRoot},
    };

    #[cfg(unix)]
    #[test]
    fn another_instance_cannot_release_or_checkpoint_a_live_converter_even_after_lease_expiry() {
        let staged = workspace();
        let database = staged.work.join("tasks.sqlite3");
        let owner = FolderTaskManager::for_test(database.clone()).unwrap();
        let other = FolderTaskManager::for_test(database).unwrap();
        let detail = task(&owner, &staged.work, "locked", 1);
        let claim =
            claim_folder_task_batch_impl(&owner, &detail.summary.id, "run-locked", 1).unwrap();
        let batch = claim.batch.unwrap();
        let revision = get_folder_task_impl(&owner, &detail.summary.id)
            .unwrap()
            .summary
            .revision;
        let guard = owner
            .executions
            .begin(
                CallIdentity::new(&detail.summary.id, "run-locked", "conversion").unwrap(),
                &batch.id,
                Duration::from_secs(10),
            )
            .unwrap();
        guard.start().unwrap();
        assert!(
            set_folder_task_status_impl(&other, &detail.summary.id, "pause", revision)
                .unwrap_err()
                .contains("另一应用实例")
        );
        assert!(update_folder_task_batch_impl(
            &other,
            &detail.summary.id,
            "run-locked",
            &batch.lease_token,
            vec![FolderTaskItemUpdate {
                item_id: claim.items[0].id.clone(),
                status: "completed".into(),
                result: Some(json!({"summary": "invalid", "facts": []})),
                error: None
            }],
            None,
            "complete"
        )
        .is_err());
        assert!(read_folder_task_file_bytes_impl(
            &other,
            &detail.summary.id,
            "run-locked",
            &batch.lease_token,
            "0.txt"
        )
        .unwrap_err()
        .contains("instance"));
        owner
            .connection()
            .unwrap()
            .execute(
                "UPDATE folder_task_batches SET lease_expires_at = 0 WHERE id = ?1",
                [&batch.id],
            )
            .unwrap();
        assert!(claim_folder_task_batch_impl(&other, &detail.summary.id, "run-new", 1).is_err());
        assert_eq!(
            get_item(
                &owner.connection().unwrap(),
                &detail.summary.id,
                &claim.items[0].id
            )
            .unwrap()
            .status,
            "processing"
        );
        // Own-instance stop can share the file descriptor, but cancellation is
        // still not permission for another instance to claim before guard drop.
        owner
            .executions
            .cancel_call(
                &CallIdentity::new(&detail.summary.id, "run-locked", "conversion").unwrap(),
            )
            .unwrap();
        assert!(claim_folder_task_batch_impl(&other, &detail.summary.id, "run-new", 1).is_err());
        drop(guard);
        let recovered =
            claim_folder_task_batch_impl(&other, &detail.summary.id, "run-new", 1).unwrap();
        assert_eq!(recovered.items.len(), 1);
        assert_ne!(recovered.batch.unwrap().id, batch.id);
    }

    fn workspace() -> StagedInput {
        StagingRoot::create()
            .unwrap()
            .stage(b"seed", &sha256_bytes(b"seed"), "png", 1024)
            .unwrap()
    }

    fn task(
        manager: &FolderTaskManager,
        root: &Path,
        name: &str,
        count: usize,
    ) -> FolderTaskDetail {
        let input = root.join(name);
        fs::create_dir(&input).unwrap();
        for index in 0..count {
            fs::write(input.join(format!("{index}.txt")), b"fixture").unwrap();
        }
        let detail = create_folder_task_impl(
            manager,
            input,
            name.into(),
            "Extract".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        confirm_folder_task_plan_impl(
            manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap()
    }

    #[test]
    fn exit_releases_only_owned_batches_preserves_checkpoint_and_reopens_for_explicit_resume() {
        let staged = workspace();
        let database = staged.work.join("tasks.sqlite3");
        let owner = FolderTaskManager::for_test(database.clone()).unwrap();
        let other = FolderTaskManager::for_test(database.clone()).unwrap();
        let owned = task(&owner, &staged.work, "owned", 3);
        let completed =
            claim_folder_task_batch_impl(&owner, &owned.summary.id, "run-done", 1).unwrap();
        update_folder_task_batch_impl(
            &owner,
            &owned.summary.id,
            "run-done",
            &completed.batch.as_ref().unwrap().lease_token,
            vec![FolderTaskItemUpdate {
                item_id: completed.items[0].id.clone(),
                status: "completed".into(),
                result: Some(json!({"summary": "committed", "facts": []})),
                error: None,
            }],
            None,
            "complete",
        )
        .unwrap();
        let active =
            claim_folder_task_batch_impl(&owner, &owned.summary.id, "run-active", 1).unwrap();
        let foreign = task(&other, &staged.work, "foreign", 1);
        let foreign_claim =
            claim_folder_task_batch_impl(&other, &foreign.summary.id, "run-foreign", 1).unwrap();
        let legacy = task(&owner, &staged.work, "legacy", 1);
        let legacy_claim =
            claim_folder_task_batch_impl(&owner, &legacy.summary.id, "run-legacy", 1).unwrap();
        owner
            .connection()
            .unwrap()
            .execute(
                "UPDATE folder_task_batches SET owner_instance_id = NULL WHERE id = ?1",
                [&legacy_claim.batch.as_ref().unwrap().id],
            )
            .unwrap();
        let guard = owner
            .executions
            .begin(
                CallIdentity::new(&owned.summary.id, "run-active", "conversion").unwrap(),
                &active.batch.as_ref().unwrap().id,
                Duration::from_secs(10),
            )
            .unwrap();
        owner.executions.begin_shutdown().unwrap();
        assert!(owner.finish_shutdown_batches().is_err());
        assert_eq!(
            get_item(
                &owner.connection().unwrap(),
                &owned.summary.id,
                &active.items[0].id
            )
            .unwrap()
            .status,
            "processing"
        );
        drop(guard);
        owner.clone().finish_shutdown_batches().unwrap();
        let detail = get_folder_task_impl(&owner, &owned.summary.id).unwrap();
        assert_eq!(detail.summary.status, FolderTaskStatus::Paused);
        assert!(detail.active_batch.is_none());
        assert_eq!(detail.summary.progress.completed, 1);
        assert_eq!(detail.summary.progress.pending, 2);
        assert_eq!(
            get_item(
                &owner.connection().unwrap(),
                &owned.summary.id,
                &completed.items[0].id
            )
            .unwrap()
            .result
            .unwrap()["summary"],
            "committed"
        );
        assert_eq!(
            get_folder_task_impl(&other, &foreign.summary.id)
                .unwrap()
                .active_batch
                .unwrap()
                .id,
            foreign_claim.batch.unwrap().id
        );
        assert_eq!(
            get_folder_task_impl(&owner, &legacy.summary.id)
                .unwrap()
                .active_batch
                .unwrap()
                .id,
            legacy_claim.batch.unwrap().id
        );
        let revision = detail.summary.revision;
        owner.finish_shutdown_batches().unwrap();
        assert_eq!(
            get_folder_task_impl(&owner, &owned.summary.id)
                .unwrap()
                .summary
                .revision,
            revision
        );
        let reopened = FolderTaskManager::for_test(database).unwrap();
        let detail = get_folder_task_impl(&reopened, &owned.summary.id).unwrap();
        assert_eq!(detail.summary.progress.completed, 1);
        set_folder_task_status_impl(
            &reopened,
            &owned.summary.id,
            "resume",
            detail.summary.revision,
        )
        .unwrap();
        let resumed =
            claim_folder_task_batch_impl(&reopened, &owned.summary.id, "run-resumed", 8).unwrap();
        assert_eq!(resumed.items.len(), 2);
        assert!(resumed
            .items
            .iter()
            .all(|item| item.id != completed.items[0].id));
    }

    #[test]
    fn shutdown_transaction_failure_keeps_batch_intact_and_retry_is_atomic() {
        let staged = workspace();
        let manager = FolderTaskManager::for_test(staged.work.join("tasks.sqlite3")).unwrap();
        let detail = task(&manager, &staged.work, "rollback", 1);
        let claim =
            claim_folder_task_batch_impl(&manager, &detail.summary.id, "run-rollback", 1).unwrap();
        manager.connection().unwrap().execute_batch("CREATE TRIGGER reject_exit BEFORE UPDATE ON folder_task_batches WHEN NEW.status = 'interrupted' BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
        manager.executions.begin_shutdown().unwrap();
        assert!(manager.finish_shutdown_batches().is_err());
        let unchanged = get_folder_task_impl(&manager, &detail.summary.id).unwrap();
        assert_eq!(unchanged.summary.status, FolderTaskStatus::Running);
        assert_eq!(unchanged.active_batch.unwrap().id, claim.batch.unwrap().id);
        assert_eq!(
            get_item(
                &manager.connection().unwrap(),
                &detail.summary.id,
                &claim.items[0].id
            )
            .unwrap()
            .status,
            "processing"
        );
        manager
            .connection()
            .unwrap()
            .execute_batch("DROP TRIGGER reject_exit;")
            .unwrap();
        manager.finish_shutdown_batches().unwrap();
        assert_eq!(
            get_folder_task_impl(&manager, &detail.summary.id)
                .unwrap()
                .summary
                .status,
            FolderTaskStatus::Paused
        );
    }

    #[test]
    fn renewal_never_adopts_another_instance_or_legacy_batch() {
        let staged = workspace();
        let database = staged.work.join("tasks.sqlite3");
        let owner = FolderTaskManager::for_test(database.clone()).unwrap();
        let detail = task(&owner, &staged.work, "ownership", 1);
        let claim =
            claim_folder_task_batch_impl(&owner, &detail.summary.id, "run-shared", 1).unwrap();
        assert!(
            claim_folder_task_batch_impl(&owner.clone(), &detail.summary.id, "run-shared", 1)
                .is_ok()
        );
        let other = FolderTaskManager::for_test(database.clone()).unwrap();
        assert!(
            claim_folder_task_batch_impl(&other, &detail.summary.id, "run-shared", 1)
                .unwrap_err()
                .contains("instance")
        );
        // Reproduce a v8 database: no owner column. Migration must leave old
        // batches unowned rather than claiming them for whichever app opens it.
        owner.connection().unwrap().execute_batch("ALTER TABLE folder_task_batches DROP COLUMN owner_instance_id; UPDATE folder_task_meta SET value = '8' WHERE key = 'schema_version';").unwrap();
        let migrated = FolderTaskManager::for_test(database).unwrap();
        assert!(
            claim_folder_task_batch_impl(&migrated, &detail.summary.id, "run-shared", 1)
                .unwrap_err()
                .contains("instance")
        );
        migrated.executions.begin_shutdown().unwrap();
        migrated.finish_shutdown_batches().unwrap();
        assert_eq!(
            get_folder_task_impl(&migrated, &detail.summary.id)
                .unwrap()
                .active_batch
                .unwrap()
                .id,
            claim.batch.unwrap().id
        );
    }
}
