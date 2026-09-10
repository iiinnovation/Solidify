//! Desktop exit/restart waits for the same execution guards as task stopping.
use crate::fs::folder_tasks::FolderTaskManager;
use crate::fs::sandbox_exec::installation::InstallationManager;
use crate::fs::sandbox_exec::runtime::SandboxRuntime;
use serde::Serialize;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub(crate) struct ShutdownState(AtomicU8);

#[derive(Clone, Copy, Serialize, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ShutdownStatus {
    Idle,
    Stopping,
    Delayed,
    Failed,
    Ready,
}

impl ShutdownState {
    pub fn status(&self) -> ShutdownStatus {
        match self.0.load(Ordering::Acquire) {
            0 => ShutdownStatus::Idle,
            1 => ShutdownStatus::Stopping,
            2 => ShutdownStatus::Delayed,
            3 => ShutdownStatus::Failed,
            _ => ShutdownStatus::Ready,
        }
    }
    fn start(&self) -> bool {
        self.0
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
            || self
                .0
                .compare_exchange(3, 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
    }
    fn set(&self, status: ShutdownStatus) {
        self.0.store(
            match status {
                ShutdownStatus::Idle => 0,
                ShutdownStatus::Stopping => 1,
                ShutdownStatus::Delayed => 2,
                ShutdownStatus::Failed => 3,
                ShutdownStatus::Ready => 4,
            },
            Ordering::Release,
        );
    }
}

#[tauri::command]
pub(crate) fn app_shutdown_status(state: State<'_, ShutdownState>) -> ShutdownStatus {
    state.status()
}

#[tauri::command]
pub(crate) fn restart_after_cleanup(app: AppHandle) {
    request(app, None);
}

/// None requests an update restart, Some(code) a normal exit. First intent wins.
pub(crate) fn request(app: AppHandle, exit_code: Option<i32>) {
    let state = app.state::<ShutdownState>();
    if !state.start() {
        return;
    }
    let manager = app.state::<FolderTaskManager>().execution_manager();
    if manager.begin_shutdown().is_err() {
        state.set(ShutdownStatus::Failed);
        log::error!("Unable to fence converters for shutdown");
        return;
    }
    app.state::<SandboxRuntime>().begin_shutdown();
    if app.state::<InstallationManager>().begin_shutdown().is_err() {
        state.set(ShutdownStatus::Failed);
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        loop {
            let drained = manager.shutdown_drained().and_then(|drained| {
                if drained {
                    if app.state::<InstallationManager>().shutdown_drained()? {
                        app.state::<SandboxRuntime>().finish_shutdown()
                    } else {
                        Ok(false)
                    }
                } else {
                    Ok(false)
                }
            });
            match drained {
                Ok(true) => break,
                Ok(false) => {
                    if started.elapsed() >= Duration::from_secs(2) {
                        app.state::<ShutdownState>().set(ShutdownStatus::Delayed);
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(_) => {
                    app.state::<ShutdownState>().set(ShutdownStatus::Failed);
                    return;
                }
            }
        }
        if app
            .state::<FolderTaskManager>()
            .finish_shutdown_batches()
            .is_err()
        {
            app.state::<ShutdownState>().set(ShutdownStatus::Failed);
            return;
        }
        app.state::<ShutdownState>().set(ShutdownStatus::Ready);
        match exit_code {
            Some(code) => app.exit(code),
            None => app.request_restart(),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_exit_requests_do_not_start_multiple_drains() {
        let state = ShutdownState::default();
        assert_eq!(state.status(), ShutdownStatus::Idle);
        assert!(state.start());
        assert!(!state.start());
        state.set(ShutdownStatus::Delayed);
        assert!(!state.start());
        state.set(ShutdownStatus::Ready);
        assert_eq!(state.status(), ShutdownStatus::Ready);
        assert!(!state.start());
        state.set(ShutdownStatus::Failed);
        assert!(
            state.start(),
            "a later exit request can retry failed cleanup"
        );
    }
}
