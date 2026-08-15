use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
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

    fn clear(&self) -> Result<(), String> {
        if self.storage_path.exists() {
            fs::remove_file(&self.storage_path)
                .map_err(|error| format!("Unable to clear workspace authorization: {error}"))?;
        }
        *self
            .root
            .lock()
            .map_err(|_| "Workspace authorization state is unavailable".to_string())? = None;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetadata {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub stage: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub root: String,
    pub project: ProjectMetadata,
}

#[tauri::command]
pub async fn select_workspace(
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

#[tauri::command]
pub fn restore_workspace(
    workspace_root: String,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<WorkspaceInfo, String> {
    let root = authorization.require(&workspace_root)?;
    initialize_workspace(root)
}

#[tauri::command]
pub async fn create_workspace(
    app: AppHandle,
    name: String,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<Option<WorkspaceInfo>, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err("Workspace name is invalid".into());
    }
    let Some(parent) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let parent = parent
        .into_path()
        .map_err(|error| format!("Unable to use selected parent directory: {error}"))?;
    let root = parent.join(name);
    if root.exists() {
        return Err("A file or directory with this name already exists".into());
    }
    fs::create_dir_all(&root).map_err(|error| format!("Unable to create workspace: {error}"))?;
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    authorization.set(root.clone())?;
    initialize_workspace(root).map(Some)
}

#[tauri::command]
pub fn close_workspace(authorization: State<'_, WorkspaceAuthorization>) -> Result<(), String> {
    authorization.clear()
}

#[tauri::command(async)]
pub fn update_project_stage(
    workspace_root: String,
    stage: String,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<ProjectMetadata, String> {
    let root = authorization.require(&workspace_root)?;
    let allowed = [
        "discovery",
        "requirements",
        "solution",
        "delivery",
        "completed",
    ];
    if !allowed.contains(&stage.as_str()) {
        return Err("Unsupported project stage".into());
    }
    let path = root.join(".solidify/project.json");
    let mut project: ProjectMetadata =
        serde_json::from_slice(&fs::read(&path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("Invalid .solidify/project.json: {error}"))?;
    project.stage = stage;
    let encoded = serde_json::to_vec_pretty(&project).map_err(|error| error.to_string())?;
    let temporary = root.join(".solidify/project.json.tmp");
    fs::write(&temporary, encoded).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())?;
    Ok(project)
}

fn initialize_workspace(root: PathBuf) -> Result<WorkspaceInfo, String> {
    let metadata_root = root.join(".solidify");
    for directory in [
        metadata_root.join("conversations"),
        metadata_root.join("ledger"),
        metadata_root.join("artifacts"),
        metadata_root.join("skills"),
        metadata_root.join("cache"),
        root.join("01-输入材料"),
        root.join("02-过程"),
        root.join("03-交付物"),
    ] {
        fs::create_dir_all(directory)
            .map_err(|error| format!("Unable to initialize workspace: {error}"))?;
    }
    let metadata_path = metadata_root.join("project.json");
    let project = if metadata_path.exists() {
        serde_json::from_slice(&fs::read(&metadata_path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("Invalid .solidify/project.json: {error}"))?
    } else {
        let name = root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Untitled Workspace")
            .to_string();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis();
        let project = ProjectMetadata {
            schema_version: 1,
            id: format!("prj_{now:x}_{:x}", std::process::id()),
            name,
            created_at: unix_timestamp_to_iso(now / 1000),
            stage: "discovery".into(),
        };
        let encoded = serde_json::to_vec_pretty(&project).map_err(|error| error.to_string())?;
        let temporary = metadata_root.join("project.json.tmp");
        fs::write(&temporary, encoded).map_err(|error| error.to_string())?;
        fs::rename(temporary, &metadata_path).map_err(|error| error.to_string())?;
        project
    };
    Ok(WorkspaceInfo {
        root: root.to_string_lossy().into_owned(),
        project,
    })
}

fn unix_timestamp_to_iso(seconds: u128) -> String {
    let seconds = seconds as i64;
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };
    (year, month, day)
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

    #[test]
    fn scaffold_survives_workspace_directory_rename() {
        let parent = tempdir("workspace-rename-parent");
        let original = parent.join("original");
        fs::create_dir_all(&original).unwrap();
        let first = initialize_workspace(fs::canonicalize(&original).unwrap()).unwrap();
        assert!(original.join(".solidify/project.json").exists());
        assert!(original.join("01-输入材料").is_dir());
        assert!(first.project.created_at.ends_with('Z'));

        let renamed = parent.join("renamed");
        fs::rename(&original, &renamed).unwrap();
        let second = initialize_workspace(fs::canonicalize(&renamed).unwrap()).unwrap();
        assert_eq!(second.project.id, first.project.id);
        assert_eq!(
            PathBuf::from(second.root),
            fs::canonicalize(&renamed).unwrap()
        );
        fs::remove_dir_all(parent).unwrap();
    }
}
