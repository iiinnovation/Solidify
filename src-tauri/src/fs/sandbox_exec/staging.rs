//! Per-instance private directories and byte-exact, read-only input snapshots.
use super::types::{FailureCode, SandboxError};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

#[cfg(unix)]
pub(crate) mod recovery;

fn io_error(_: std::io::Error) -> SandboxError {
    SandboxError::new(FailureCode::Io, "无法准备隔离执行的临时文件")
}

fn create_private_dir(path: &Path) -> Result<(), SandboxError> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(io_error)
}

/// Owns a private root; recovery only considers the versioned ownership format.
#[derive(Debug)]
pub struct StagingRoot {
    path: PathBuf,
    #[cfg(unix)]
    _owner_lock: std::fs::File,
}

impl StagingRoot {
    pub(super) fn remove_empty(&self) -> Result<(), SandboxError> {
        #[cfg(unix)]
        let result = recovery::remove_empty(&self.path);
        #[cfg(not(unix))]
        let result = fs::remove_dir(&self.path);
        result.map_err(|_| {
            SandboxError::new(
                FailureCode::StopFailed,
                "隔离暂存目录未清理完成，退出已暂停",
            )
        })
    }
    pub fn create() -> Result<Arc<Self>, SandboxError> {
        Self::in_parent(&std::env::temp_dir())
    }

    pub(super) fn in_parent(parent: &Path) -> Result<Arc<Self>, SandboxError> {
        let parent = fs::canonicalize(parent).map_err(io_error)?;
        #[cfg(unix)]
        {
            // Publish only after locking. A crash during initialization leaves
            // an unrecognized directory, never one mistaken for an idle owner.
            let id = Uuid::new_v4();
            let preparing = parent.join(format!("solidify-sandbox-initializing-{id}"));
            create_private_dir(&preparing)?;
            let prepared = (|| {
                let lock = recovery::lock_owner(&preparing, true)?;
                let path = parent.join(format!("{}{id}", recovery::PREFIX));
                fs::rename(&preparing, &path)?;
                Ok::<_, std::io::Error>((path, lock))
            })();
            match prepared {
                Ok((path, lock)) => {
                    return Ok(Arc::new(Self {
                        path,
                        _owner_lock: lock,
                    }))
                }
                Err(error) => {
                    let _ = fs::remove_dir_all(&preparing);
                    return Err(io_error(error));
                }
            }
        }
        #[cfg(not(unix))]
        {
            let path = parent.join(format!("solidify-sandbox-{}", Uuid::new_v4()));
            create_private_dir(&path)?;
            Ok(Arc::new(Self { path }))
        }
    }

    /// Bytes must come from the trusted FolderTask reader, not model input.
    /// Verify again before granting a converter access to this exact snapshot.
    pub fn stage(
        self: &Arc<Self>,
        bytes: &[u8],
        expected_hash: &str,
        extension: &str,
        byte_limit: u64,
    ) -> Result<StagedInput, SandboxError> {
        if bytes.len() as u64 > byte_limit {
            return Err(SandboxError::new(
                FailureCode::InvalidInput,
                "源文件超过解析大小上限",
            ));
        }
        if !matches!(extension, "png" | "jpg" | "jpeg" | "pdf") {
            return Err(SandboxError::new(
                FailureCode::InvalidInput,
                "不支持的外部解析格式",
            ));
        }
        let source_hash = format!("{:x}", Sha256::digest(bytes));
        if source_hash != expected_hash {
            return Err(SandboxError::new(
                FailureCode::SnapshotChanged,
                "文件内容与已确认快照不一致，请重新扫描",
            ));
        }
        let root = self.path.join(Uuid::new_v4().to_string());
        create_private_dir(&root)?;
        let mut staged = StagedInput {
            owner: self.clone(),
            root,
            input: PathBuf::new(),
            work: PathBuf::new(),
            source_hash,
        };
        let input_dir = staged.root.join("input");
        create_private_dir(&input_dir)?;
        staged.work = staged.root.join("work");
        create_private_dir(&staged.work)?;
        staged.input = input_dir.join(format!("source.{extension}"));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let mut file = options.open(&staged.input).map_err(io_error)?;
        file.write_all(bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o400))
                .map_err(io_error)?;
        }
        Ok(staged)
    }
}

impl Drop for StagingRoot {
    fn drop(&mut self) {
        // All StagedInput owners have gone. Do not recursively remove unknown
        // contents if a cleanup failed: leave them for ownership-aware recovery.
        let _ = self.remove_empty();
    }
}

#[derive(Debug)]
pub struct StagedInput {
    owner: Arc<StagingRoot>,
    root: PathBuf,
    pub input: PathBuf,
    pub work: PathBuf,
    pub source_hash: String,
}

impl Drop for StagedInput {
    fn drop(&mut self) {
        // Only this fresh, owned directory, never an untrusted path or glob.
        // The process supervisor must hold this value until all children exit.
        if self.root.parent() == Some(self.owner.path.as_path()) {
            #[cfg(unix)]
            if !recovery::may_remove_execution(&self.root) {
                return;
            }
            if fs::symlink_metadata(&self.root)
                .map(|m| m.is_dir() && !m.file_type().is_symlink())
                .unwrap_or(false)
            {
                let _ = fs::remove_dir_all(&self.root);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn stages_only_verified_bytes_with_separate_write_scope() {
        let owner = StagingRoot::create().unwrap();
        let bytes = b"verified snapshot";
        let staged = owner.stage(bytes, &hash(bytes), "pdf", 100).unwrap();
        assert_eq!(fs::read(&staged.input).unwrap(), bytes);
        assert!(!staged.input.starts_with(&staged.work));
        assert_eq!(staged.source_hash, hash(bytes));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&staged.input).unwrap().permissions().mode() & 0o777,
                0o400
            );
            assert_eq!(
                fs::metadata(&staged.work).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        assert_eq!(
            owner
                .stage(b"changed", &hash(bytes), "pdf", 100)
                .unwrap_err()
                .code,
            FailureCode::SnapshotChanged
        );
        assert!(owner
            .stage(bytes, &hash(bytes), "../../elsewhere", 100)
            .is_err());
        assert!(owner.stage(bytes, &hash(bytes), "pdf", 1).is_err());
    }

    #[test]
    fn cleanup_preserves_other_executions_and_keeps_instance_alive() {
        let owner = StagingRoot::create().unwrap();
        let first = owner.stage(b"a", &hash(b"a"), "png", 10).unwrap();
        let second = owner.stage(b"b", &hash(b"b"), "png", 10).unwrap();
        let instance = owner.path.clone();
        let first_path = first.root.clone();
        drop(owner);
        drop(first);
        assert!(!first_path.exists());
        assert_eq!(fs::read(&second.input).unwrap(), b"b");
        drop(second);
        assert!(!instance.exists());
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_does_not_follow_a_link_from_work_to_other_input() {
        let owner = StagingRoot::create().unwrap();
        let first = owner.stage(b"a", &hash(b"a"), "png", 10).unwrap();
        let second = owner.stage(b"b", &hash(b"b"), "png", 10).unwrap();
        std::os::unix::fs::symlink(&second.root, first.work.join("outside")).unwrap();
        drop(first);
        assert_eq!(fs::read(&second.input).unwrap(), b"b");
    }

    #[cfg(unix)]
    #[test]
    fn recovery_preserves_live_owners_and_unreaped_jobs_until_acknowledged() {
        let container = StagingRoot::create().unwrap();
        let live = StagingRoot::in_parent(&container.path).unwrap();
        let abandoned = StagingRoot::in_parent(&container.path).unwrap();
        let staged = abandoned
            .stage(b"document", &hash(b"document"), "png", 100)
            .unwrap();
        let input = staged.input.clone();
        let abandoned_path = abandoned.path.clone();
        recovery::begin_job(&input).unwrap();
        assert!(
            recovery::begin_job(&input).is_err(),
            "unreaped execution cannot be reused"
        );
        drop(staged);
        drop(abandoned);
        // Simulates loss of desktop ownership with an unresolved worker. Even
        // without an owner FD, the persistent marker must prevent deletion.
        let report = recovery::recover(&container.path).unwrap();
        assert_eq!(report.removed, 0);
        assert_eq!(report.retained, 2);
        assert!(input.exists());
        recovery::reaped_job(&input).unwrap();
        let report = recovery::recover(&container.path).unwrap();
        assert_eq!(report.removed, 1);
        assert_eq!(report.retained, 1);
        assert!(!abandoned_path.exists());
        assert!(live.path.exists());
        assert_eq!(recovery::recover(&container.path).unwrap().removed, 0);
    }

    #[cfg(unix)]
    #[test]
    fn recovery_retains_unknown_roots_and_refuses_links() {
        let container = StagingRoot::create().unwrap();
        let old = container
            .path
            .join(format!("solidify-sandbox-{}", Uuid::new_v4()));
        create_private_dir(&old).unwrap();
        fs::write(old.join("keep"), b"legacy").unwrap();
        let candidate = StagingRoot::in_parent(&container.path).unwrap();
        let candidate_path = candidate.path.clone();
        std::os::unix::fs::symlink(&old, candidate.path.join("outside")).unwrap();
        drop(candidate);
        let link = container
            .path
            .join(format!("{}{}", recovery::PREFIX, Uuid::new_v4()));
        std::os::unix::fs::symlink(&old, &link).unwrap();
        let report = recovery::recover(&container.path).unwrap();
        assert_eq!(report.removed, 0);
        assert_eq!(report.retained, 2);
        assert_eq!(fs::read(old.join("keep")).unwrap(), b"legacy");
        fs::remove_file(candidate_path.join("outside")).unwrap();
        assert_eq!(recovery::recover(&container.path).unwrap().removed, 1);
        fs::remove_file(link).unwrap();
        fs::remove_dir_all(old).unwrap();
    }
}
