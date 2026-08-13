mod fs;

use tauri::Manager;

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
            fs::sandbox::resolve_path,
            fs::tools::list_dir,
            fs::tools::read_file,
            fs::tools::write_file,
            fs::tools::search_files,
            fs::snapshots::append_snapshot,
            fs::snapshots::read_snapshot,
            fs::snapshots::clear_snapshot,
            fs::workspace::select_workspace,
        ])
        .setup(|app| {
            app.manage(fs::workspace::WorkspaceAuthorization::load(app.handle())?);
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
