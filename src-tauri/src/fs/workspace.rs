use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

pub struct WorkspaceAuthorization {
    storage_path: PathBuf,
    root: Mutex<Option<PathBuf>>,
}

impl WorkspaceAuthorization {
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let storage_path = app
            .path()
            .app_config_dir()
            .map_err(|error| format!("Unable to locate app config directory: {error}"))?
            .join("authorized-workspace.txt");
        Ok(Self::from_storage_path(storage_path))
    }

    fn from_storage_path(storage_path: PathBuf) -> Self {
        let root = fs::read_to_string(&storage_path)
            .ok()
            .and_then(|value| fs::canonicalize(value.trim()).ok())
            .filter(|path| path.is_dir());
        Self {
            storage_path,
            root: Mutex::new(root),
        }
    }

    pub fn require(&self, workspace_root: &str) -> Result<PathBuf, String> {
        let requested = fs::canonicalize(workspace_root)
            .map_err(|error| format!("Workspace root is not accessible: {error}"))?;
        let authorized = self
            .root
            .lock()
            .map_err(|_| "Workspace authorization state is unavailable".to_string())?;
        match authorized.as_ref() {
            Some(root) if root == &requested => Ok(requested),
            _ => Err("Workspace root was not authorized by the directory picker".into()),
        }
    }

    fn set(&self, root: PathBuf) -> Result<(), String> {
        let parent = self
            .storage_path
            .parent()
            .ok_or_else(|| "Workspace authorization path has no parent".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("Unable to create app config directory: {error}"))?;
        fs::write(&self.storage_path, root.to_string_lossy().as_bytes())
            .map_err(|error| format!("Unable to persist workspace authorization: {error}"))?;
        *self
            .root
            .lock()
            .map_err(|_| "Workspace authorization state is unavailable".to_string())? = Some(root);
        Ok(())
    }
}

#[tauri::command]
pub fn select_workspace(
    app: AppHandle,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<Option<String>, String> {
    let Some(selected) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let selected = selected
        .into_path()
        .map_err(|error| format!("Unable to use selected workspace: {error}"))?;
    let root = fs::canonicalize(selected)
        .map_err(|error| format!("Workspace root is not accessible: {error}"))?;
    if !root.is_dir() {
        return Err("Workspace root must be a directory".into());
    }
    authorization.set(root.clone())?;
    Ok(Some(root.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    fn tempdir(name: &str) -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = TEST_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("solidify-{name}-{id}-{sequence}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn only_accepts_the_persisted_canonical_root() {
        let config = tempdir("workspace-auth-config");
        let selected = tempdir("workspace-auth-selected");
        let other = tempdir("workspace-auth-other");
        let storage_path = config.join("authorized-workspace.txt");
        let authorization = WorkspaceAuthorization::from_storage_path(storage_path.clone());
        authorization
            .set(fs::canonicalize(&selected).unwrap())
            .unwrap();

        assert!(authorization
            .require(selected.to_string_lossy().as_ref())
            .is_ok());
        assert!(authorization
            .require(other.to_string_lossy().as_ref())
            .is_err());

        let reloaded = WorkspaceAuthorization::from_storage_path(storage_path);
        assert!(reloaded
            .require(selected.to_string_lossy().as_ref())
            .is_ok());
        assert!(reloaded.require(other.to_string_lossy().as_ref()).is_err());

        fs::remove_dir_all(config).unwrap();
        fs::remove_dir_all(selected).unwrap();
        fs::remove_dir_all(other).unwrap();
    }
}
