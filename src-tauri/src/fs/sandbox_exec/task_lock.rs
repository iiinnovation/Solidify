//! Unix advisory task locks. Files are stable and never unlinked on release;
//! unlinking a locked inode would let another instance lock a replacement.
use super::types::{FailureCode, SandboxError};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::os::unix::{
    fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    io::{AsRawFd, FromRawFd},
};
use std::path::Path;
use std::sync::Arc;

pub(super) struct TaskLocks {
    directory: File,
}

fn invalid() -> SandboxError {
    SandboxError::new(FailureCode::IsolationUnavailable, "任务跨实例锁目录不可用")
}

impl TaskLocks {
    pub fn open(database: &Path) -> Result<Self, SandboxError> {
        let path = database.with_extension("task-locks");
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        match builder.create(&path) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(_) => return Err(invalid()),
        }
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&path)
            .map_err(|_| invalid())?;
        let meta = directory.metadata().map_err(|_| invalid())?;
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
            return Err(invalid());
        }
        Ok(Self { directory })
    }

    pub fn acquire(&self, task: &str) -> Result<Arc<File>, SandboxError> {
        if task.is_empty() || task.len() > 200 {
            return Err(invalid());
        }
        let name =
            std::ffi::CString::new(format!("{:x}.lock", Sha256::digest(task.as_bytes()))).unwrap();
        let raw = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK
                    | libc::O_CLOEXEC,
                0o600,
            )
        };
        if raw < 0 {
            return Err(invalid());
        }
        let file = unsafe { File::from_raw_fd(raw) };
        let meta = file.metadata().map_err(|_| invalid())?;
        if !meta.is_file()
            || meta.nlink() != 1
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o077 != 0
        {
            return Err(invalid());
        }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let error = std::io::Error::last_os_error();
            return Err(if error.kind() == std::io::ErrorKind::WouldBlock {
                SandboxError::new(
                    FailureCode::ExecutionBusy,
                    "另一应用实例正在处理或回收此任务，请等待完成",
                )
            } else {
                invalid()
            });
        }
        // No explicit LOCK_UN: the worker may retain a duplicated descriptor
        // after desktop death. The kernel unlocks after the final close.
        Ok(Arc::new(file))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::sandbox_exec::staging::StagingRoot;

    #[test]
    fn duplicated_descriptor_keeps_other_instances_out_until_the_last_close() {
        let owner = StagingRoot::create().unwrap();
        let staged = owner
            .stage(
                b"seed",
                &format!("{:x}", Sha256::digest(b"seed")),
                "png",
                100,
            )
            .unwrap();
        let database = staged.work.join("tasks.sqlite");
        let first = TaskLocks::open(&database).unwrap();
        let second = TaskLocks::open(&database).unwrap();
        let lock = first.acquire("task").unwrap();
        assert_eq!(
            second.acquire("task").unwrap_err().code,
            FailureCode::ExecutionBusy
        );
        assert!(second.acquire("other-task").is_ok());
        let inherited = lock.try_clone().unwrap();
        drop(lock);
        assert!(second.acquire("task").is_err());
        drop(inherited);
        assert!(second.acquire("task").is_ok());
    }

    #[test]
    fn private_lock_files_cannot_be_replaced_by_links_or_special_files() {
        use std::os::unix::fs::symlink;
        let owner = StagingRoot::create().unwrap();
        let staged = owner
            .stage(
                b"seed",
                &format!("{:x}", Sha256::digest(b"seed")),
                "png",
                100,
            )
            .unwrap();
        let database = staged.work.join("tasks.sqlite");
        let locks = TaskLocks::open(&database).unwrap();
        let path = database
            .with_extension("task-locks")
            .join(format!("{:x}.lock", Sha256::digest(b"task")));
        symlink(&staged.input, &path).unwrap();
        assert!(locks.acquire("task").is_err());
        fs::remove_file(&path).unwrap();
        use std::os::unix::ffi::OsStrExt;
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(locks.acquire("task").is_err());
    }
}
