use super::sandbox::{resolve_in_workspace, resolve_tool_write_path};
use super::workspace::WorkspaceAuthorization;
use ignore::WalkBuilder;
use serde::Serialize;
use std::fs;
use std::path::Path;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct DirEntry {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size: u64,
}

#[tauri::command(async)]
pub fn list_dir(
    path: String,
    workspace_root: String,
    depth: Option<usize>,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<Vec<DirEntry>, String> {
    authorization.require(&workspace_root)?;
    list_dir_impl(path, workspace_root, depth)
}

fn list_dir_impl(
    path: String,
    workspace_root: String,
    depth: Option<usize>,
) -> Result<Vec<DirEntry>, String> {
    let root = resolve_in_workspace(&path, &workspace_root, false)?;
    let canonical_workspace = fs::canonicalize(&workspace_root).map_err(|e| e.to_string())?;
    let max_depth = depth.unwrap_or(1).max(1);
    let mut out = Vec::new();
    let mut builder = WalkBuilder::new(&root);
    let ignore_root = canonical_workspace.clone();
    builder
        .max_depth(Some(max_depth))
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .add_custom_ignore_filename(".solidifyignore")
        .filter_entry(move |entry| !is_default_ignored(entry.path(), &ignore_root));
    for entry in builder.build() {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path() == root {
            continue;
        }
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        let relative = entry
            .path()
            .strip_prefix(&canonical_workspace)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        out.push(DirEntry {
            path: relative,
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: if metadata.is_dir() {
                "directory"
            } else {
                "file"
            }
            .into(),
            size: if metadata.is_file() {
                metadata.len()
            } else {
                0
            },
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[derive(Debug, Serialize)]
pub struct FileReadResult {
    pub content: Option<String>,
    pub binary: bool,
    pub bytes: usize,
    pub truncated: bool,
}

#[tauri::command(async)]
pub fn read_file(
    path: String,
    workspace_root: String,
    offset: Option<usize>,
    limit: Option<usize>,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<FileReadResult, String> {
    authorization.require(&workspace_root)?;
    read_file_impl(path, workspace_root, offset, limit)
}

#[tauri::command(async)]
pub fn read_file_bytes(
    path: String,
    workspace_root: String,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<Vec<u8>, String> {
    authorization.require(&workspace_root)?;
    let resolved = resolve_in_workspace(&path, &workspace_root, false)?;
    fs::read(resolved).map_err(|error| format!("Unable to read file: {error}"))
}

fn read_file_impl(
    path: String,
    workspace_root: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<FileReadResult, String> {
    let resolved = resolve_in_workspace(&path, &workspace_root, false)?;
    let bytes = fs::read(&resolved).map_err(|e| format!("Unable to read file: {e}"))?;
    if let Ok(text) = std::str::from_utf8(&bytes) {
        let start_chars = offset.unwrap_or(0);
        let mut chars = text.chars();
        let selected: String = match limit {
            Some(count) => chars.by_ref().skip(start_chars).take(count).collect(),
            None => chars.by_ref().skip(start_chars).collect(),
        };
        let total_chars = text.chars().count();
        let truncated = start_chars.saturating_add(selected.chars().count()) < total_chars;
        return Ok(FileReadResult {
            content: Some(selected),
            binary: false,
            bytes: bytes.len(),
            truncated,
        });
    }
    Ok(FileReadResult {
        content: None,
        binary: true,
        bytes: bytes.len(),
        truncated: false,
    })
}

#[tauri::command(async)]
pub fn write_file(
    path: String,
    content: String,
    workspace_root: String,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<usize, String> {
    authorization.require(&workspace_root)?;
    write_file_impl(path, content, workspace_root)
}

fn write_file_impl(path: String, content: String, workspace_root: String) -> Result<usize, String> {
    let resolved = resolve_tool_write_path(&path, &workspace_root)?;
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Unable to create parent directory: {e}"))?;
    }
    // Re-resolve after creating directories so a symlinked parent cannot turn
    // a missing target into an out-of-workspace write.
    let resolved = resolve_tool_write_path(&path, &workspace_root)?;
    fs::write(&resolved, content.as_bytes()).map_err(|e| format!("Unable to write file: {e}"))?;
    Ok(content.len())
}

#[derive(Debug, Serialize)]
pub struct SearchMatch {
    pub path: String,
    pub line: Option<usize>,
    pub text: Option<String>,
}

#[tauri::command(async)]
pub fn search_files(
    query: String,
    path: String,
    workspace_root: String,
    max_results: Option<usize>,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<Vec<SearchMatch>, String> {
    authorization.require(&workspace_root)?;
    search_files_impl(query, path, workspace_root, max_results)
}

fn search_files_impl(
    query: String,
    path: String,
    workspace_root: String,
    max_results: Option<usize>,
) -> Result<Vec<SearchMatch>, String> {
    let root = resolve_in_workspace(&path, &workspace_root, false)?;
    let canonical_workspace = fs::canonicalize(&workspace_root).map_err(|e| e.to_string())?;
    let max = max_results.unwrap_or(100).max(1);
    let needle = query.to_lowercase();
    let mut out = Vec::new();
    let mut builder = WalkBuilder::new(&root);
    let ignore_root = canonical_workspace.clone();
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .add_custom_ignore_filename(".solidifyignore")
        .filter_entry(move |entry| !is_default_ignored(entry.path(), &ignore_root));
    for entry in builder.build() {
        let entry = entry.map_err(|e| e.to_string())?;
        if out.len() >= max || !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(&canonical_workspace)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        if entry
            .file_name()
            .to_string_lossy()
            .to_lowercase()
            .contains(&needle)
        {
            out.push(SearchMatch {
                path: relative.clone(),
                line: None,
                text: None,
            });
            continue;
        }
        let Ok(content) = fs::read_to_string(entry.path()) else {
            continue;
        };
        for (index, line) in content.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                out.push(SearchMatch {
                    path: relative.clone(),
                    line: Some(index + 1),
                    text: Some(line.to_string()),
                });
                if out.len() >= max {
                    break;
                }
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    Ok(out)
}

fn is_default_ignored(path: &Path, workspace_root: &Path) -> bool {
    let relative = path.strip_prefix(workspace_root).unwrap_or(path);
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if matches!(name, ".git" | "node_modules" | ".DS_Store" | "Thumbs.db")
        || name.starts_with("~$")
        || matches!(
            path.extension().and_then(|e| e.to_str()),
            Some("tmp" | "swp" | "crdownload")
        )
    {
        return true;
    }
    let mut components = relative.components().filter_map(|c| c.as_os_str().to_str());
    matches!(
        (components.next(), components.next()),
        (Some(".solidify"), Some("cache"))
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, remove_dir_all, write};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static WORKSPACE_ID: AtomicU64 = AtomicU64::new(0);

    fn workspace() -> std::path::PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = WORKSPACE_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("solidify-tools-{id}-{sequence}"));
        create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn list_dir_applies_default_and_workspace_ignores() {
        let root = workspace();
        create_dir_all(root.join("node_modules/pkg")).unwrap();
        create_dir_all(root.join(".solidify/cache")).unwrap();
        write(root.join("visible.md"), "ok").unwrap();
        write(root.join("ignored.log"), "no").unwrap();
        write(root.join(".solidifyignore"), "*.log\n").unwrap();
        let entries =
            list_dir_impl(".".into(), root.to_string_lossy().into_owned(), Some(3)).unwrap();
        let paths: Vec<_> = entries.iter().map(|e| e.path.as_str()).collect();
        assert!(paths.contains(&"visible.md"));
        assert!(!paths.iter().any(|p| p.starts_with("node_modules")));
        assert!(!paths.iter().any(|p| p.starts_with(".solidify/cache")));
        assert!(!paths.contains(&"ignored.log"));
        remove_dir_all(root).unwrap();
    }

    #[test]
    fn read_file_slices_unicode_and_reports_binary() {
        let root = workspace();
        write(root.join("text.txt"), "甲乙丙丁").unwrap();
        write(root.join("data.bin"), [0xff, 0xfe, 0xfd]).unwrap();
        let text = read_file_impl(
            "text.txt".into(),
            root.to_string_lossy().into_owned(),
            Some(1),
            Some(2),
        )
        .unwrap();
        assert_eq!(text.content.as_deref(), Some("乙丙"));
        assert!(text.truncated);
        let binary = read_file_impl(
            "data.bin".into(),
            root.to_string_lossy().into_owned(),
            None,
            None,
        )
        .unwrap();
        assert!(binary.binary);
        assert_eq!(binary.bytes, 3);
        remove_dir_all(root).unwrap();
    }

    #[test]
    fn write_file_creates_nested_directories() {
        let root = workspace();
        let bytes = write_file_impl(
            "new/nested/file.txt".into(),
            "content".into(),
            root.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert_eq!(bytes, 7);
        assert_eq!(
            fs::read_to_string(root.join("new/nested/file.txt")).unwrap(),
            "content"
        );
        remove_dir_all(root).unwrap();
    }

    #[test]
    fn search_files_matches_names_and_content() {
        let root = workspace();
        write(root.join("needle-name.md"), "other").unwrap();
        write(root.join("content.md"), "first\nNeedle here\nlast").unwrap();
        let matches = search_files_impl(
            "needle".into(),
            ".".into(),
            root.to_string_lossy().into_owned(),
            Some(10),
        )
        .unwrap();
        assert!(matches
            .iter()
            .any(|m| m.path == "needle-name.md" && m.line.is_none()));
        assert!(matches
            .iter()
            .any(|m| m.path == "content.md" && m.line == Some(2)));
        remove_dir_all(root).unwrap();
    }
}
