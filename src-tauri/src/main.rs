// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--solidify-sandbox-worker") {
        std::process::exit(app_lib::sandbox_worker_main());
    }
    app_lib::run();
}
