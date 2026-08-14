use super::sandbox::resolve_in_workspace;
use super::workspace::WorkspaceAuthorization;
use ignore::WalkBuilder;
use serde::Serialize;
use std::fs;
use std::time::UNIX_EPOCH;
use tauri::State;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub modified_at: u64,
}

#[tauri::command(async)]
pub fn read_tree(
    workspace_root: String,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<Vec<TreeEntry>, String> {
    authorization.require(&workspace_root)?;
    read_tree_impl(&workspace_root)
}

pub fn read_tree_impl(workspace_root: &str) -> Result<Vec<TreeEntry>, String> {
    let root = resolve_in_workspace(".", workspace_root, false)?;
    let canonical_root = fs::canonicalize(workspace_root).map_err(|error| error.to_string())?;
    let ignore_root = canonical_root.clone();
    let mut builder = WalkBuilder::new(&root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .add_custom_ignore_filename(".solidifyignore")
        .filter_entry(move |entry| !should_ignore(entry.path(), &ignore_root));

    let mut entries = Vec::new();
    for entry in builder.build() {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.path() == root {
            continue;
        }
        if entry.file_type().is_some_and(|kind| kind.is_symlink()) {
            continue;
        }
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        let path = entry
            .path()
            .strip_prefix(&canonical_root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        entries.push(TreeEntry {
            path,
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
            modified_at: metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_millis() as u64)
                .unwrap_or_default(),
        });
    }
    entries.sort_by(|left, right| {
        let left_dir = left.kind == "directory";
        let right_dir = right.kind == "directory";
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(entries)
}

pub fn should_ignore(path: &std::path::Path, root: &std::path::Path) -> bool {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if matches!(name, ".git" | "node_modules" | ".DS_Store" | "Thumbs.db")
        || name.starts_with("~$")
        || matches!(
            path.extension().and_then(|value| value.to_str()),
            Some("tmp" | "swp" | "crdownload")
        )
    {
        return true;
    }
    relative
        .components()
        .next()
        .and_then(|part| part.as_os_str().to_str())
        == Some(".solidify")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    fn tempdir() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "solidify-tree-{}-{}",
            std::process::id(),
            TEST_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn reads_relative_tree_and_excludes_internal_content() {
        let root = tempdir();
        fs::create_dir_all(root.join("资料")).unwrap();
        fs::create_dir_all(root.join(".solidify/cache")).unwrap();
        fs::create_dir_all(root.join("node_modules/dependency")).unwrap();
        fs::write(root.join("资料/说明.md"), "中文内容").unwrap();
        fs::write(root.join(".solidify/cache/derived.txt"), "ignored").unwrap();
        fs::write(root.join("node_modules/dependency/index.js"), "ignored").unwrap();

        let entries = read_tree_impl(root.to_string_lossy().as_ref()).unwrap();
        assert!(entries.iter().any(|entry| entry.path == "资料/说明.md"));
        assert!(!entries
            .iter()
            .any(|entry| entry.path.starts_with(".solidify")));
        assert!(!entries
            .iter()
            .any(|entry| entry.path.starts_with("node_modules")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn applies_solidifyignore_rules() {
        let root = tempdir();
        fs::write(root.join(".solidifyignore"), "private/\n*.secret\n").unwrap();
        fs::create_dir_all(root.join("private")).unwrap();
        fs::write(root.join("private/hidden.txt"), "ignored").unwrap();
        fs::write(root.join("token.secret"), "ignored").unwrap();
        fs::write(root.join("visible.txt"), "visible").unwrap();

        let entries = read_tree_impl(root.to_string_lossy().as_ref()).unwrap();
        assert!(entries.iter().any(|entry| entry.path == "visible.txt"));
        assert!(!entries
            .iter()
            .any(|entry| entry.path.starts_with("private")));
        assert!(!entries.iter().any(|entry| entry.path == "token.secret"));
        fs::remove_dir_all(root).unwrap();
    }
}
