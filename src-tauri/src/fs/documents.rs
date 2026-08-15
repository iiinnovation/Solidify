use super::sandbox::resolve_tool_write_path;
use super::workspace::WorkspaceAuthorization;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

const MAX_VERSIONS: usize = 20;
static TEMPORARY_ID: AtomicU64 = AtomicU64::new(0);
static DOCUMENT_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentVersion {
    pub n: u32,
    pub ts: String,
    pub run_id: String,
    pub message_id: String,
    pub content: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct VersionMetadata {
    versions: Vec<VersionMetadataEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionMetadataEntry {
    n: u32,
    ts: String,
    run_id: String,
    message_id: String,
    file: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializeResult {
    pub path: String,
    pub created: bool,
    pub snapshot_version: Option<u32>,
    pub current_version: u32,
    pub modified_at: u64,
}

#[tauri::command(async)]
pub fn materialize_document(
    path: String,
    content: String,
    workspace_root: String,
    run_id: String,
    message_id: String,
    expected_modified_at: Option<u64>,
    force: bool,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<MaterializeResult, String> {
    authorization.require(&workspace_root)?;
    let _guard = DOCUMENT_WRITE_LOCK
        .lock()
        .map_err(|_| "Document writer is unavailable".to_string())?;
    materialize_document_impl(
        &path,
        &content,
        &workspace_root,
        &run_id,
        &message_id,
        expected_modified_at,
        force,
    )
}

#[tauri::command(async)]
pub fn list_document_versions(
    path: String,
    workspace_root: String,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<Vec<DocumentVersion>, String> {
    authorization.require(&workspace_root)?;
    list_document_versions_impl(&path, &workspace_root)
}

#[tauri::command(async)]
pub fn rollback_document(
    path: String,
    version: u32,
    workspace_root: String,
    run_id: String,
    message_id: String,
    expected_modified_at: Option<u64>,
    force: bool,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<MaterializeResult, String> {
    authorization.require(&workspace_root)?;
    let _guard = DOCUMENT_WRITE_LOCK
        .lock()
        .map_err(|_| "Document writer is unavailable".to_string())?;
    let versions = list_document_versions_impl(&path, &workspace_root)?;
    let selected = versions
        .into_iter()
        .find(|item| item.n == version)
        .ok_or_else(|| format!("Document version v{version} does not exist"))?;
    materialize_document_impl(
        &path,
        &selected.content,
        &workspace_root,
        &run_id,
        &message_id,
        expected_modified_at,
        force,
    )
}

fn materialize_document_impl(
    path: &str,
    content: &str,
    workspace_root: &str,
    run_id: &str,
    message_id: &str,
    expected_modified_at: Option<u64>,
    force: bool,
) -> Result<MaterializeResult, String> {
    let target = resolve_tool_write_path(path, workspace_root)?;
    let created = !target.exists();
    let actual_modified_at = if created {
        None
    } else {
        Some(modified_at(&target)?)
    };
    if !force
        && expected_modified_at.is_some()
        && expected_modified_at.unwrap_or_default() != actual_modified_at.unwrap_or_default()
    {
        return Err(format!(
            "DOCUMENT_CONFLICT:{}:{}",
            expected_modified_at.unwrap_or_default(),
            actual_modified_at.unwrap_or_default()
        ));
    }

    let versions_root = version_root(path, workspace_root);
    let mut metadata = read_metadata(&versions_root)?;
    let snapshot_version = if created {
        None
    } else {
        fs::create_dir_all(&versions_root)
            .map_err(|error| format!("Unable to create document history: {error}"))?;
        let n = metadata
            .versions
            .iter()
            .map(|item| item.n)
            .max()
            .unwrap_or(0)
            + 1;
        let file = format!("v{n}{}", extension_suffix(path));
        let old_content = fs::read_to_string(&target)
            .map_err(|error| format!("Unable to snapshot existing document: {error}"))?;
        atomic_write(&versions_root.join(&file), old_content.as_bytes())?;
        metadata.versions.push(VersionMetadataEntry {
            n,
            ts: now_iso(),
            run_id: run_id.to_string(),
            message_id: message_id.to_string(),
            file,
        });
        while metadata.versions.len() > MAX_VERSIONS {
            let removed = metadata.versions.remove(0);
            let _ = fs::remove_file(versions_root.join(removed.file));
        }
        write_metadata(&versions_root, &metadata)?;
        Some(n)
    };

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Unable to create document directory: {error}"))?;
    }
    // Re-resolve after creating parents so a newly introduced symlink cannot
    // redirect the write beyond the authorized workspace.
    let target = resolve_tool_write_path(path, workspace_root)?;
    atomic_write(&target, content.as_bytes())?;
    let modified_at = modified_at(&target)?;
    let current_version = metadata
        .versions
        .iter()
        .map(|item| item.n)
        .max()
        .unwrap_or(0)
        + 1;
    Ok(MaterializeResult {
        path: path.to_string(),
        created,
        snapshot_version,
        current_version,
        modified_at,
    })
}

fn list_document_versions_impl(
    path: &str,
    workspace_root: &str,
) -> Result<Vec<DocumentVersion>, String> {
    // Resolve even though history is internal: callers may not use an escaping path
    // to probe or create arbitrary metadata locations.
    resolve_tool_write_path(path, workspace_root)?;
    let root = version_root(path, workspace_root);
    let metadata = read_metadata(&root)?;
    metadata
        .versions
        .into_iter()
        .map(|entry| {
            let content = fs::read_to_string(root.join(&entry.file)).map_err(|error| {
                format!("Unable to read document version v{}: {error}", entry.n)
            })?;
            Ok(DocumentVersion {
                n: entry.n,
                ts: entry.ts,
                run_id: entry.run_id,
                message_id: entry.message_id,
                content,
            })
        })
        .collect()
}

fn version_root(path: &str, workspace_root: &str) -> PathBuf {
    // Keep the directory portable below common 255-byte filename limits while
    // retaining a readable suffix. FNV-1a is stable across app versions.
    let hash = path
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325_u64, |value, byte| {
            (value ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
    let readable = path
        .chars()
        .map(|value| {
            if value.is_alphanumeric() || matches!(value, '-' | '_' | '.') {
                value
            } else {
                '_'
            }
        })
        .take(48)
        .collect::<String>();
    let safe = format!("{hash:016x}-{readable}");
    Path::new(workspace_root)
        .join(".solidify")
        .join("artifacts")
        .join(safe)
}

fn extension_suffix(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| value.chars().all(|c| c.is_ascii_alphanumeric()))
        .map(|value| format!(".{value}"))
        .unwrap_or_default()
}

fn read_metadata(root: &Path) -> Result<VersionMetadata, String> {
    let path = root.join("meta.json");
    if !path.exists() {
        return Ok(VersionMetadata::default());
    }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|error| format!("Invalid document history metadata: {error}"))
}

fn write_metadata(root: &Path, metadata: &VersionMetadata) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(metadata).map_err(|error| error.to_string())?;
    atomic_write(&root.join("meta.json"), &content)
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Document path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("document"),
        std::process::id(),
        TEMPORARY_ID.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    match fs::rename(&temporary, path) {
        Ok(()) => Ok(()),
        // Windows does not replace an existing destination. Its fallback has a
        // brief gap; Unix/macOS keep the normal rename-overwrite atomic path.
        Err(_) if path.exists() => {
            fs::remove_file(path).map_err(|error| error.to_string())?;
            fs::rename(&temporary, path).map_err(|error| error.to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn modified_at(path: &Path) -> Result<u64, String> {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .and_then(|time| {
            time.duration_since(UNIX_EPOCH)
                .map_err(std::io::Error::other)
        })
        .map(|duration| duration.as_millis() as u64)
        .map_err(|error| format!("Unable to read document modification time: {error}"))
}

fn now_iso() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("{millis}")
}

#[cfg(test)]
mod tests {
    use super::*;

    static WORKSPACE_ID: AtomicU64 = AtomicU64::new(0);

    fn workspace() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "solidify-documents-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            WORKSPACE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("03-交付物")).unwrap();
        root
    }

    #[test]
    fn snapshots_before_overwrite_and_rolls_back_without_losing_current() {
        let root = workspace();
        let root_text = root.to_string_lossy();
        let first = materialize_document_impl(
            "03-交付物/spec.md",
            "one",
            &root_text,
            "r1",
            "m1",
            None,
            false,
        )
        .unwrap();
        assert!(first.created);
        let second = materialize_document_impl(
            "03-交付物/spec.md",
            "two",
            &root_text,
            "r2",
            "m2",
            Some(first.modified_at),
            false,
        )
        .unwrap();
        assert_eq!(second.snapshot_version, Some(1));
        let versions = list_document_versions_impl("03-交付物/spec.md", &root_text).unwrap();
        assert_eq!(versions[0].content, "one");
        materialize_document_impl(
            "03-交付物/spec.md",
            &versions[0].content,
            &root_text,
            "rollback",
            "m3",
            Some(second.modified_at),
            false,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("03-交付物/spec.md")).unwrap(),
            "one"
        );
        assert_eq!(
            list_document_versions_impl("03-交付物/spec.md", &root_text).unwrap()[1].content,
            "two"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_external_change_without_force() {
        let root = workspace();
        let root_text = root.to_string_lossy();
        let first = materialize_document_impl(
            "03-交付物/spec.md",
            "one",
            &root_text,
            "r1",
            "m1",
            None,
            false,
        )
        .unwrap();
        let error = materialize_document_impl(
            "03-交付物/spec.md",
            "two",
            &root_text,
            "r2",
            "m2",
            Some(first.modified_at + 1),
            false,
        )
        .unwrap_err();
        assert!(error.starts_with("DOCUMENT_CONFLICT:"));
        assert_eq!(
            fs::read_to_string(root.join("03-交付物/spec.md")).unwrap(),
            "one"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detects_a_file_created_after_generation_started_and_retains_twenty_versions() {
        let root = workspace();
        let root_text = root.to_string_lossy();
        fs::write(root.join("03-交付物/spec.md"), "external").unwrap();
        let conflict = materialize_document_impl(
            "03-交付物/spec.md",
            "ai",
            &root_text,
            "r",
            "m",
            Some(0),
            false,
        )
        .unwrap_err();
        assert!(conflict.starts_with("DOCUMENT_CONFLICT:"));

        let mut mtime = modified_at(&root.join("03-交付物/spec.md")).unwrap();
        for index in 0..25 {
            let result = materialize_document_impl(
                "03-交付物/spec.md",
                &format!("content-{index}"),
                &root_text,
                "r",
                "m",
                Some(mtime),
                false,
            )
            .unwrap_or_else(|error| panic!("iteration {index}: {error}"));
            mtime = result.modified_at;
        }
        let versions = list_document_versions_impl("03-交付物/spec.md", &root_text).unwrap();
        assert_eq!(versions.len(), 20);
        assert_eq!(versions.first().unwrap().n, 6);
        assert_eq!(versions.last().unwrap().n, 25);
        fs::remove_dir_all(root).unwrap();
    }
}
