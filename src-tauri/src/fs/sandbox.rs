use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

use super::workspace::WorkspaceAuthorization;

/// Resolve a user supplied path inside the workspace. This is the security
/// boundary for every filesystem tool; renderer-side checks are only hints.
pub fn resolve_in_workspace(
    path: &str,
    workspace_root: &str,
    allow_missing: bool,
) -> Result<PathBuf, String> {
    let root = fs::canonicalize(workspace_root)
        .map_err(|e| format!("Workspace root is not accessible: {e}"))?;
    let normalized = path.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.starts_with("//")
        || normalized.starts_with("\\\\")
        || (normalized.len() >= 2 && normalized.as_bytes()[1] == b':')
        || normalized.starts_with("?/")
    {
        return Err("Path must be a relative path inside the workspace".into());
    }

    let candidate = root.join(&normalized);
    let resolved = match fs::canonicalize(&candidate) {
        Ok(path) => path,
        Err(error) if allow_missing && error.kind() == std::io::ErrorKind::NotFound => {
            resolve_missing_path(&candidate)?
        }
        Err(error) => return Err(format!("Path does not exist: {error}")),
    };

    if !is_within(&root, &resolved) {
        return Err("Path escapes the workspace".into());
    }
    Ok(resolved)
}

fn resolve_missing_path(candidate: &Path) -> Result<PathBuf, String> {
    let mut ancestor = candidate;
    let mut missing = Vec::new();
    loop {
        // `symlink_metadata` does not follow links, so a *dangling* symlink counts
        // as existing here and stops the walk — `canonicalize` below then fails and
        // the whole path is rejected. `Path::exists()` follows links, so it reports
        // a broken symlink as missing; that would make us treat the link name as a
        // plain file to be created, and `fs::write` (which has no O_NOFOLLOW) would
        // follow it straight out of the workspace.
        if ancestor.symlink_metadata().is_ok() {
            break;
        }
        missing.push(
            ancestor
                .file_name()
                .ok_or_else(|| "Invalid path".to_string())?
                .to_owned(),
        );
        ancestor = ancestor
            .parent()
            .ok_or_else(|| "Invalid path".to_string())?;
    }
    let mut resolved = fs::canonicalize(ancestor)
        .map_err(|e| format!("Parent directory is not accessible: {e}"))?;
    for part in missing.iter().rev() {
        resolved.push(part);
    }
    Ok(resolved)
}

fn is_within(root: &Path, candidate: &Path) -> bool {
    #[cfg(windows)]
    {
        let root = root.to_string_lossy().to_lowercase();
        let candidate = candidate.to_string_lossy().to_lowercase();
        candidate == root || candidate.starts_with(&(root + "\\"))
    }
    #[cfg(not(windows))]
    {
        candidate == root
            || candidate
                .strip_prefix(root)
                .map(|p| p.components().next().is_some())
                .unwrap_or(false)
    }
}

/// Directory names that agent-facing tools must never write into, at any depth,
/// even though they live inside the workspace.
///
/// Workspace containment alone is not a sufficient write policy: `.solidify/`
/// holds the run ledger and conversation snapshots that the harness treats as
/// authoritative persistent facts, and `.git/hooks/` would hand the model the
/// shell execution that the tool surface deliberately does not expose.
const TOOL_PROTECTED_DIRS: [&str; 2] = [".solidify", ".git"];

/// Reject writes into protected directories. Internal persistence (ledger,
/// snapshots) bypasses this by calling `resolve_in_workspace` directly — only
/// model-driven tools go through `resolve_tool_write_path`.
fn ensure_tool_writable(resolved: &Path, root: &Path) -> Result<(), String> {
    let relative = resolved
        .strip_prefix(root)
        .map_err(|_| "Path escapes the workspace".to_string())?;
    for component in relative.components() {
        let name = component.as_os_str().to_string_lossy().to_lowercase();
        if TOOL_PROTECTED_DIRS.contains(&name.as_str()) {
            return Err(format!(
                "Path is protected and cannot be written by tools: {name}/"
            ));
        }
    }
    Ok(())
}

/// Resolve a path for a model-driven write: workspace containment plus the
/// protected-directory deny list.
pub fn resolve_tool_write_path(path: &str, workspace_root: &str) -> Result<PathBuf, String> {
    let resolved = resolve_in_workspace(path, workspace_root, true)?;
    let root = fs::canonicalize(workspace_root)
        .map_err(|e| format!("Workspace root is not accessible: {e}"))?;
    ensure_tool_writable(&resolved, &root)?;
    Ok(resolved)
}

#[tauri::command(async)]
pub fn resolve_path(
    path: String,
    workspace_root: String,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<String, String> {
    authorization.require(&workspace_root)?;
    resolve_in_workspace(&path, &workspace_root, true).map(|p| p.to_string_lossy().into_owned())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, remove_dir_all, write};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_ID: AtomicU64 = AtomicU64::new(0);

    fn tempdir() -> std::path::PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("solidify-sandbox-{id}-{sequence}"));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn rejects_parent_traversal() {
        let dir = tempdir();
        write(dir.join("ok.txt"), "ok").unwrap();
        assert!(resolve_in_workspace("../../../etc/passwd", dir.to_str().unwrap(), false).is_err());
        remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_absolute_path() {
        let dir = tempdir();
        assert!(resolve_in_workspace("/etc/passwd", dir.to_str().unwrap(), false).is_err());
        remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_windows_unc_path() {
        let dir = tempdir();
        assert!(
            resolve_in_workspace(r"\\?\C:\Windows\system32", dir.to_str().unwrap(), false).is_err()
        );
        remove_dir_all(dir).unwrap();
    }

    #[test]
    fn allows_normal_relative_path() {
        let dir = tempdir();
        create_dir_all(dir.join("nested")).unwrap();
        write(dir.join("nested/ok.txt"), "ok").unwrap();
        assert!(resolve_in_workspace("nested/ok.txt", dir.to_str().unwrap(), false).is_ok());
        remove_dir_all(dir).unwrap();
    }

    #[test]
    fn allows_internal_symlink() {
        let dir = tempdir();
        create_dir_all(dir.join("nested")).unwrap();
        write(dir.join("nested/ok.txt"), "ok").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("nested/ok.txt", dir.join("link.txt")).unwrap();
            assert!(resolve_in_workspace("link.txt", dir.to_str().unwrap(), false).is_ok());
        }
        remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_external_symlink() {
        let dir = tempdir();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/tmp", dir.join("escape")).unwrap();
            assert!(resolve_in_workspace("escape", dir.to_str().unwrap(), false).is_err());
        }
        remove_dir_all(dir).unwrap();
    }

    #[test]
    fn treats_solidify_case_as_the_filesystem_does() {
        let dir = tempdir();
        create_dir_all(dir.join(".solidify")).unwrap();
        write(dir.join(".solidify/state"), "ok").unwrap();
        let lower = resolve_in_workspace(".solidify/state", dir.to_str().unwrap(), false);
        let upper = resolve_in_workspace(".SOLIDIFY/state", dir.to_str().unwrap(), false);
        assert!(lower.is_ok());
        if dir.join(".SOLIDIFY/state").exists() {
            assert!(upper.is_ok());
        } else {
            assert!(upper.is_err());
        }
        remove_dir_all(dir).unwrap();
    }

    #[test]
    fn allows_missing_nested_path_for_safe_write() {
        let dir = tempdir();
        let result =
            resolve_in_workspace("new/nested/file.txt", dir.to_str().unwrap(), true).unwrap();
        assert!(result.starts_with(fs::canonicalize(&dir).unwrap()));
        remove_dir_all(dir).unwrap();
    }

    /// A broken symlink is not a missing file: `fs::write` would follow it out of
    /// the workspace. Regression test for the dangling-leaf sandbox escape.
    #[test]
    fn rejects_dangling_symlink_leaf_on_write() {
        let dir = tempdir();
        let outside = tempdir();
        create_dir_all(dir.join("notes")).unwrap();
        #[cfg(unix)]
        {
            let target = outside.join("PWNED.txt");
            std::os::unix::fs::symlink(&target, dir.join("notes/report.md")).unwrap();
            assert!(!target.exists());
            let resolved = resolve_in_workspace("notes/report.md", dir.to_str().unwrap(), true);
            assert!(
                resolved.is_err(),
                "dangling symlink leaf must not resolve as a writable missing path"
            );
            assert!(
                !target.exists(),
                "target outside the workspace must stay absent"
            );
        }
        remove_dir_all(dir).unwrap();
        remove_dir_all(outside).unwrap();
    }

    /// Same escape one level up: a dangling symlink used as a parent component.
    #[test]
    fn rejects_dangling_symlink_parent_on_write() {
        let dir = tempdir();
        let outside = tempdir();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.join("missing"), dir.join("out")).unwrap();
            assert!(resolve_in_workspace("out/file.txt", dir.to_str().unwrap(), true).is_err());
        }
        remove_dir_all(dir).unwrap();
        remove_dir_all(outside).unwrap();
    }

    #[test]
    fn blocks_tool_writes_into_protected_directories() {
        let dir = tempdir();
        let root = dir.to_str().unwrap();
        // The ledger and conversation snapshots the harness treats as authoritative.
        assert!(resolve_tool_write_path(".solidify/ledger/run-1.jsonl", root).is_err());
        assert!(resolve_tool_write_path(".solidify/conversations/a.chat.jsonl", root).is_err());
        // Git hooks would be shell execution the tool surface does not offer.
        assert!(resolve_tool_write_path(".git/hooks/post-commit", root).is_err());
        // Nested, not just top level.
        assert!(resolve_tool_write_path("sub/.git/hooks/pre-push", root).is_err());
        // Ordinary deliverables stay writable.
        assert!(resolve_tool_write_path("03-交付物/需求规格.md", root).is_ok());
        remove_dir_all(dir).unwrap();
    }

    /// Internal persistence still reaches `.solidify/` — the deny list applies to
    /// model-driven tool writes only.
    #[test]
    fn internal_persistence_still_resolves_inside_solidify() {
        let dir = tempdir();
        assert!(
            resolve_in_workspace(".solidify/ledger/run-1.jsonl", dir.to_str().unwrap(), true)
                .is_ok()
        );
        remove_dir_all(dir).unwrap();
    }
}
