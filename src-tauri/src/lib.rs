mod fs;
mod shutdown;

use tauri::Manager;

/// Internal child-process supervisor. It starts before any desktop plugins.
pub fn sandbox_worker_main() -> i32 {
    fs::sandbox_exec::worker::main()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            shutdown::app_shutdown_status,
            shutdown::restart_after_cleanup,
            fs::sandbox_exec::installation::ocr_installation_status,
            fs::sandbox_exec::installation::ocr_prepare_package,
            fs::sandbox_exec::installation::ocr_cancel_preparation,
            fs::sandbox_exec::installation::ocr_retry_preparation_cleanup,
            fs::sandbox::resolve_path,
            fs::tools::list_dir,
            fs::tools::read_file,
            fs::tools::write_file,
            fs::tools::search_files,
            fs::tools::read_file_bytes,
            fs::tree::read_tree,
            fs::index::initialize_index,
            fs::index::rebuild_index,
            fs::index::upsert_index_document,
            fs::index::remove_index_path,
            fs::index::search_index,
            fs::index::index_stats,
            fs::persistence::append_workspace_record,
            fs::persistence::read_workspace_records,
            fs::documents::materialize_document,
            fs::documents::list_document_versions,
            fs::documents::rollback_document,
            fs::watcher::watch_dir,
            fs::watcher::unwatch_dir,
            fs::snapshots::append_snapshot,
            fs::snapshots::read_snapshot,
            fs::snapshots::clear_snapshot,
            fs::workspace::select_workspace,
            fs::workspace::restore_workspace,
            fs::workspace::create_workspace,
            fs::workspace::close_workspace,
            fs::workspace::update_project_stage,
            fs::folder_tasks::create_folder_task,
            fs::folder_tasks::list_folder_tasks,
            fs::folder_tasks::get_folder_task,
            fs::folder_tasks::list_folder_task_items,
            fs::folder_tasks::preview_folder_task_plan,
            fs::folder_tasks::confirm_folder_task_plan,
            fs::folder_tasks::claim_folder_task_batch,
            fs::folder_tasks::update_folder_task_batch,
            fs::folder_tasks::request_folder_task_decision,
            fs::folder_tasks::resolve_folder_task_decision,
            fs::folder_tasks::set_folder_task_status,
            fs::folder_tasks::read_folder_task_file_bytes,
            fs::folder_tasks::sandbox_extract_text,
            fs::folder_tasks::sandbox_cancel_execution,
            fs::folder_tasks::sandbox_capabilities,
            fs::folder_tasks::sandbox_execution_progress,
            fs::folder_tasks::finish_folder_task_run,
            fs::folder_tasks::review_folder_task_items,
            fs::folder_tasks::write_folder_task_output,
            fs::folder_tasks::delete_folder_task,
        ])
        .setup(|app| {
            app.manage(shutdown::ShutdownState::default());
            app.manage(fs::workspace::WorkspaceAuthorization::load(app.handle())?);
            app.manage(fs::watcher::WorkspaceWatcher::default());
            app.manage(fs::folder_tasks::FolderTaskManager::load(app.handle())?);
            app.manage(fs::sandbox_exec::runtime::SandboxRuntime::default());
            app.manage(fs::sandbox_exec::installation::InstallationManager::default());
            fs::sandbox_exec::runtime::SandboxRuntime::recover_abandoned_staging();
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && window.state::<shutdown::ShutdownState>().status() != shutdown::ShutdownStatus::Ready {
                    api.prevent_close();
                    shutdown::request(window.app_handle().clone(), Some(0));
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if app.state::<shutdown::ShutdownState>().status() != shutdown::ShutdownStatus::Ready {
                    api.prevent_exit();
                    shutdown::request(app.clone(), Some(code.unwrap_or(0)));
                }
            }
        });
}
