use super::sandbox::resolve_in_workspace;
use super::workspace::WorkspaceAuthorization;
use std::fs::{self, OpenOptions};
use std::io::Write;
use tauri::State;

fn snapshot_relative_path(conversation_id: &str) -> String {
    let safe_id: String = conversation_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect();
    format!(".solidify/conversations/{safe_id}.jsonl")
}

fn snapshot_path(
    conversation_id: &str,
    workspace_root: &str,
    allow_missing: bool,
) -> Result<std::path::PathBuf, String> {
    resolve_in_workspace(
        &snapshot_relative_path(conversation_id),
        workspace_root,
        allow_missing,
    )
}

#[tauri::command(async)]
pub fn append_snapshot(
    conversation_id: String,
    content: String,
    workspace_root: String,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<(), String> {
    authorization.require(&workspace_root)?;
    append_snapshot_impl(conversation_id, content, workspace_root)
}

fn append_snapshot_impl(
    conversation_id: String,
    content: String,
    workspace_root: String,
) -> Result<(), String> {
    let path = snapshot_path(&conversation_id, &workspace_root, true)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Snapshot path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create snapshot directory: {error}"))?;

    // Resolve again after directory creation so a symlinked parent cannot
    // redirect the append outside the selected workspace.
    let path = snapshot_path(&conversation_id, &workspace_root, true)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("Unable to open snapshot: {error}"))?;
    file.write_all(content.as_bytes())
        .map_err(|error| format!("Unable to append snapshot: {error}"))
}

#[tauri::command(async)]
pub fn read_snapshot(
    conversation_id: String,
    workspace_root: String,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<Option<String>, String> {
    authorization.require(&workspace_root)?;
    read_snapshot_impl(conversation_id, workspace_root)
}

fn read_snapshot_impl(
    conversation_id: String,
    workspace_root: String,
) -> Result<Option<String>, String> {
    let relative = snapshot_relative_path(&conversation_id);
    let path = match resolve_in_workspace(&relative, &workspace_root, false) {
        Ok(path) => path,
        Err(error) if error.starts_with("Path does not exist:") => return Ok(None),
        Err(error) => return Err(error),
    };
    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| format!("Unable to read snapshot: {error}"))
}

#[tauri::command(async)]
pub fn clear_snapshot(
    conversation_id: String,
    workspace_root: String,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<(), String> {
    authorization.require(&workspace_root)?;
    clear_snapshot_impl(conversation_id, workspace_root)
}

fn clear_snapshot_impl(conversation_id: String, workspace_root: String) -> Result<(), String> {
    let relative = snapshot_relative_path(&conversation_id);
    let path = match resolve_in_workspace(&relative, &workspace_root, false) {
        Ok(path) => path,
        Err(error) if error.starts_with("Path does not exist:") => return Ok(()),
        Err(error) => return Err(error),
    };
    fs::remove_file(path).map_err(|error| format!("Unable to remove snapshot: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static WORKSPACE_ID: AtomicU64 = AtomicU64::new(0);

    fn workspace() -> std::path::PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = WORKSPACE_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("solidify-snapshots-{id}-{sequence}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn appends_reads_and_clears_snapshot() {
        let root = workspace();
        let workspace_root = root.to_string_lossy().into_owned();

        append_snapshot_impl(
            "conversation-1".into(),
            "first\n".into(),
            workspace_root.clone(),
        )
        .unwrap();
        append_snapshot_impl(
            "conversation-1".into(),
            "second\n".into(),
            workspace_root.clone(),
        )
        .unwrap();
        assert_eq!(
            read_snapshot_impl("conversation-1".into(), workspace_root.clone()).unwrap(),
            Some("first\nsecond\n".into())
        );

        clear_snapshot_impl("conversation-1".into(), workspace_root.clone()).unwrap();
        assert_eq!(
            read_snapshot_impl("conversation-1".into(), workspace_root).unwrap(),
            None
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn conversation_id_cannot_escape_snapshot_directory() {
        let root = workspace();
        let workspace_root = root.to_string_lossy().into_owned();

        append_snapshot_impl(
            "../../outside".into(),
            "safe\n".into(),
            workspace_root.clone(),
        )
        .unwrap();

        assert!(root
            .join(".solidify/conversations/______outside.jsonl")
            .exists());
        assert!(!root.parent().unwrap().join("outside.jsonl").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
