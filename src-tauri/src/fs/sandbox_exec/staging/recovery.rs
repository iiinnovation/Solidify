//! Only versioned, published roots with an unlocked owner and no unreaped job
//! may be reclaimed. Legacy/unpublished roots have no ownership proof.
use std::fs::{self, File, OpenOptions};
use std::os::unix::{
    fs::{MetadataExt, OpenOptionsExt},
    io::AsRawFd,
};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use uuid::Uuid;

pub(super) const PREFIX: &str = "solidify-sandbox-v2-";
const OWNER: &str = ".owner-lock";
const RUNNING: &str = ".converter-unreaped";

fn invalid() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid staging ownership")
}

fn private_directory(path: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err(invalid());
    }
    Ok(())
}

pub(super) fn lock_owner(path: &Path, create: bool) -> std::io::Result<File> {
    private_directory(path)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(create)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path.join(OWNER))?;
    let meta = lock.metadata()?;
    if !meta.is_file()
        || meta.nlink() != 1
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.len() != 0
    {
        return Err(invalid());
    }
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(lock)
}

fn published(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix(PREFIX))
        .is_some_and(|id| Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id))
}

fn execution(input: &Path) -> std::io::Result<PathBuf> {
    let input_dir = input.parent().ok_or_else(invalid)?;
    let execution = input_dir.parent().ok_or_else(invalid)?;
    let instance = execution.parent().ok_or_else(invalid)?;
    if input_dir.file_name().and_then(|s| s.to_str()) != Some("input")
        || !published(instance)
        || !execution
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| Uuid::parse_str(s).is_ok())
    {
        return Err(invalid());
    }
    private_directory(instance)?;
    private_directory(execution)?;
    Ok(execution.to_path_buf())
}

pub(crate) fn begin_job(input: &Path) -> std::io::Result<()> {
    let execution = execution(input)?;
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(execution.join(RUNNING))?;
    file.sync_all()
}

/// The worker calls this only after run has returned from converter reap.
pub(crate) fn reaped_job(input: &Path) -> std::io::Result<()> {
    fs::remove_file(execution(input)?.join(RUNNING))
}

pub(crate) fn may_remove_execution(path: &Path) -> bool {
    matches!(fs::symlink_metadata(path.join(RUNNING)), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
}

pub(super) fn remove_empty(path: &Path) -> std::io::Result<()> {
    // Unexpected contents leave ownership evidence intact. Callers retain
    // the owner FD until the directory is gone, including an rmdir retry.
    for entry in fs::read_dir(path)? {
        if entry?.file_name() != OWNER {
            return Err(invalid());
        }
    }
    match fs::remove_file(path.join(OWNER)) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error),
    }
    fs::remove_dir(path)
}

#[derive(Default, Debug)]
pub(crate) struct RecoveryReport {
    pub removed: usize,
    pub retained: usize,
    pub limited: bool,
}

// Bound both metadata work and recursion. Refuse links/special files rather
// than traversing them; no converter can mutate this tree without an owner
// lock or an unreaped marker keeping it out of recovery.
fn inspect(
    path: &Path,
    depth: usize,
    entries: &mut usize,
    deadline: Instant,
) -> std::io::Result<()> {
    if depth > 12 || Instant::now() >= deadline {
        return Err(invalid());
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        *entries += 1;
        if *entries > 4096 || Instant::now() >= deadline || entry.file_name() == RUNNING {
            return Err(invalid());
        }
        let meta = fs::symlink_metadata(entry.path())?;
        if meta.uid() != unsafe { libc::geteuid() } {
            return Err(invalid());
        }
        if meta.is_dir() {
            inspect(&entry.path(), depth + 1, entries, deadline)?;
        } else if !meta.is_file() || meta.nlink() != 1 {
            return Err(invalid());
        }
    }
    Ok(())
}

pub(crate) fn recover(parent: &Path) -> std::io::Result<RecoveryReport> {
    let mut report = RecoveryReport::default();
    let deadline = Instant::now() + Duration::from_secs(2);
    for (index, entry) in fs::read_dir(parent)?.enumerate() {
        if index >= 4096 || Instant::now() >= deadline {
            report.limited = true;
            break;
        }
        let path = entry?.path();
        if !published(&path) {
            continue;
        }
        let Ok(_lock) = lock_owner(&path, false) else {
            report.retained += 1;
            continue;
        };
        if inspect(&path, 0, &mut 0, deadline).is_err() {
            report.retained += 1;
            continue;
        }
        // std's recursive removal does not follow symlinks. Keep the owner
        // descriptor locked through removal to exclude concurrent cleaners.
        if fs::remove_dir_all(&path).is_ok() {
            report.removed += 1;
        } else {
            report.retained += 1;
        }
    }
    Ok(report)
}
