use super::tree::should_ignore;
use super::workspace::WorkspaceAuthorization;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const DEBOUNCE: Duration = Duration::from_millis(500);
const RESCAN_THRESHOLD: usize = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangeEvent {
    pub kind: String,
    pub path: String,
    pub is_dir: bool,
}

struct WatchSession {
    _watcher: RecommendedWatcher,
    stop: mpsc::Sender<()>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Drop for WatchSession {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[derive(Default)]
pub struct WorkspaceWatcher {
    session: Mutex<Option<WatchSession>>,
}

#[tauri::command]
pub fn watch_dir(
    app: AppHandle,
    workspace_root: String,
    authorization: State<'_, WorkspaceAuthorization>,
    watcher_state: State<'_, WorkspaceWatcher>,
) -> Result<(), String> {
    let root = authorization.require(&workspace_root)?;
    let mut session_guard = watcher_state
        .session
        .lock()
        .map_err(|_| "Watcher state is unavailable")?;
    *session_guard = None;

    let (event_tx, event_rx) = mpsc::channel::<notify::Result<Event>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let mut watcher = RecommendedWatcher::new(
        move |event| {
            let _ = event_tx.send(event);
        },
        Config::default(),
    )
    .map_err(|error| format!("Unable to create workspace watcher: {error}"))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| format!("Unable to watch workspace: {error}"))?;

    let worker_root = root.clone();
    let worker = thread::spawn(move || run_worker(app, worker_root, event_rx, stop_rx));
    *session_guard = Some(WatchSession {
        _watcher: watcher,
        stop: stop_tx,
        worker: Some(worker),
    });
    Ok(())
}

#[tauri::command]
pub fn unwatch_dir(watcher_state: State<'_, WorkspaceWatcher>) -> Result<(), String> {
    *watcher_state
        .session
        .lock()
        .map_err(|_| "Watcher state is unavailable")? = None;
    Ok(())
}

fn run_worker(
    app: AppHandle,
    root: PathBuf,
    events: mpsc::Receiver<notify::Result<Event>>,
    stop: mpsc::Receiver<()>,
) {
    loop {
        if stop.try_recv().is_ok() {
            break;
        }
        let first = match events.recv_timeout(Duration::from_millis(100)) {
            Ok(event) => event,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let mut observed_paths = first.as_ref().map(|event| event.paths.len()).unwrap_or(0);
        let mut batch = vec![first];
        let mut force_rescan = observed_paths > RESCAN_THRESHOLD;
        while let Ok(event) = events.recv_timeout(DEBOUNCE) {
            observed_paths += event.as_ref().map(|value| value.paths.len()).unwrap_or(0);
            batch.push(event);
            if batch.len() > RESCAN_THRESHOLD || observed_paths > RESCAN_THRESHOLD {
                force_rescan = true;
                while events.try_recv().is_ok() {}
                break;
            }
        }
        emit_batch(&app, &root, batch, force_rescan);
    }
}

fn emit_batch(app: &AppHandle, root: &Path, batch: Vec<notify::Result<Event>>, force_rescan: bool) {
    for change in collapse_batch(root, batch, force_rescan) {
        let _ = app.emit("workspace://fs-change", change);
    }
}

fn collapse_batch(
    root: &Path,
    batch: Vec<notify::Result<Event>>,
    force_rescan: bool,
) -> Vec<FsChangeEvent> {
    if force_rescan {
        return vec![FsChangeEvent {
            kind: "rescan".into(),
            path: String::new(),
            is_dir: true,
        }];
    }
    let mut changes = BTreeMap::<String, FsChangeEvent>::new();
    for event in batch.into_iter().flatten() {
        let path_count = event.paths.len();
        for (path_index, path) in event.paths.into_iter().enumerate() {
            if should_ignore(&path, root) {
                continue;
            }
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let relative = relative.to_string_lossy().replace('\\', "/");
            if relative.is_empty() {
                continue;
            }
            changes.insert(
                relative.clone(),
                FsChangeEvent {
                    kind: event_path_kind(&event.kind, path_index, path_count).into(),
                    path: relative,
                    is_dir: path.is_dir(),
                },
            );
        }
    }
    if changes.len() > RESCAN_THRESHOLD {
        return vec![FsChangeEvent {
            kind: "rescan".into(),
            path: String::new(),
            is_dir: true,
        }];
    }
    changes.into_values().collect()
}

fn event_kind(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "created",
        EventKind::Modify(notify::event::ModifyKind::Name(_)) => "renamed",
        EventKind::Modify(_) => "modified",
        EventKind::Remove(_) => "removed",
        _ => "modified",
    }
}

fn event_path_kind(kind: &EventKind, path_index: usize, path_count: usize) -> &'static str {
    if matches!(kind, EventKind::Modify(notify::event::ModifyKind::Name(_))) && path_count >= 2 {
        return if path_index == 0 {
            "removed"
        } else {
            "created"
        };
    }
    event_kind(kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn maps_notify_events_to_workspace_vocabulary() {
        assert_eq!(
            event_kind(&EventKind::Create(notify::event::CreateKind::File)),
            "created"
        );
        assert_eq!(
            event_kind(&EventKind::Remove(notify::event::RemoveKind::File)),
            "removed"
        );
        assert_eq!(
            event_kind(&EventKind::Modify(notify::event::ModifyKind::Name(
                notify::event::RenameMode::Both
            ))),
            "renamed"
        );
        let rename = EventKind::Modify(notify::event::ModifyKind::Name(
            notify::event::RenameMode::Both,
        ));
        assert_eq!(event_path_kind(&rename, 0, 2), "removed");
        assert_eq!(event_path_kind(&rename, 1, 2), "created");
    }

    #[test]
    fn collapses_large_batches_to_one_rescan() {
        let root = std::env::temp_dir();
        let changes = collapse_batch(&root, vec![Ok(Event::new(EventKind::Any))], true);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, "rescan");
        assert!(changes[0].path.is_empty());
    }

    #[test]
    fn receives_external_file_creation_from_the_platform_watcher() {
        let root = std::env::temp_dir().join(format!("solidify-watch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let (sender, receiver) = mpsc::channel();
        let mut watcher = RecommendedWatcher::new(
            move |event| {
                let _ = sender.send(event);
            },
            Config::default(),
        )
        .unwrap();
        watcher.watch(&root, RecursiveMode::Recursive).unwrap();
        thread::sleep(Duration::from_secs(2));
        fs::write(root.join("external.md"), "created outside the app").unwrap();
        let event = receiver
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .unwrap();
        assert!(event.paths.iter().any(|path| path.ends_with("external.md")));
        drop(watcher);
        fs::remove_dir_all(root).unwrap();
    }
}
