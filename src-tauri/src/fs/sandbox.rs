use std::fs;
use std::path::{Path, PathBuf};

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
        if ancestor.exists() {
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

#[tauri::command]
pub fn resolve_path(path: String, workspace_root: String) -> Result<String, String> {
    resolve_in_workspace(&path, &workspace_root, true).map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, remove_dir_all, write};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tempdir() -> std::path::PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("solidify-sandbox-{id}"));
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
}
