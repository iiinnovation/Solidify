//! A separate supervisor outlives desktop crashes long enough to reap its
//! converter. Closing the parent's stdin pipe is a cancellation signal.
//! No Tauri command exposes ProcessJob; trusted Rust constructs every job.
use super::policy::ProcessJob;
use super::types::{FailureCode, SandboxError};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
}

pub fn main() -> i32 {
    // Retain the parent's lock across its death until converter reap. Mark it
    // CLOEXEC immediately so the untrusted converter never inherits it.
    #[cfg(unix)]
    let _task_lock = if std::env::args().nth(2).as_deref() == Some("--task-lock") {
        use std::os::unix::io::FromRawFd;
        if unsafe { libc::fcntl(198, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return 2;
        }
        let lock = unsafe { std::fs::File::from_raw_fd(198) };
        if !lock.metadata().map(|meta| meta.is_file()).unwrap_or(false) {
            return 2;
        }
        Some(lock)
    } else {
        None
    };
    let mut input = std::io::BufReader::new(std::io::stdin());
    let mut header = Vec::new();
    // Bound even the internal protocol before deserialization.
    if (&mut input)
        .take(1024 * 1024)
        .read_until(b'\n', &mut header)
        .is_err()
        || header.last() != Some(&b'\n')
    {
        return 2;
    }
    let job: ProcessJob = match serde_json::from_slice(&header) {
        Ok(value) => value,
        Err(_) => return 2,
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    let watcher = cancelled.clone();
    std::thread::spawn(move || {
        let mut byte = [0u8; 1];
        // Any further data, EOF or error closes this one-job lifetime.
        let _ = input.read(&mut byte);
        watcher.store(true, Ordering::SeqCst);
    });
    let output = run(&job, cancelled);
    #[cfg(unix)]
    if super::staging::recovery::reaped_job(&job.input).is_err() {
        return 2;
    }
    let Ok(bytes) = serde_json::to_vec(&output) else {
        return 2;
    };
    if std::io::stdout().write_all(&bytes).is_err() {
        return 2;
    }
    0
}

#[cfg(not(target_os = "macos"))]
pub fn run(_job: &ProcessJob, _cancelled: Arc<AtomicBool>) -> Result<ProcessOutput, SandboxError> {
    Err(SandboxError::new(
        FailureCode::PlatformUnavailable,
        "当前平台的隔离执行器尚未通过验收",
    ))
}

#[cfg(target_os = "macos")]
pub fn run(job: &ProcessJob, cancelled: Arc<AtomicBool>) -> Result<ProcessOutput, SandboxError> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let profile = super::policy::seatbelt_profile(job)?;
    if cancelled.load(Ordering::SeqCst) {
        return Err(SandboxError::new(FailureCode::Cancelled, "转换已取消"));
    }
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command
        .args(["-p", &profile])
        .arg(&job.binary)
        .args(&job.args)
        .env_clear()
        .env("HOME", &job.work)
        .env("TMPDIR", &job.work)
        .env("LC_ALL", "C")
        .env("OMP_THREAD_LIMIT", "1")
        .current_dir(&job.work)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let cpu = job.cpu_seconds;
    let file_bytes = job.max_file_bytes;
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            for (resource, limit) in [(libc::RLIMIT_CPU, cpu), (libc::RLIMIT_FSIZE, file_bytes)] {
                let limits = libc::rlimit {
                    rlim_cur: limit,
                    rlim_max: limit,
                };
                if libc::setrlimit(resource, &limits) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    let started = Instant::now();
    let child = command
        .spawn()
        .map_err(|_| SandboxError::new(FailureCode::IsolationUnavailable, "无法启动隔离转换器"))?;
    let mut child = ChildGuard(Some(child));
    let total = Arc::new(AtomicUsize::new(0));
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout = collect(
        child.0.as_mut().unwrap().stdout.take().unwrap(),
        job.max_output_bytes,
        total.clone(),
        overflow.clone(),
    );
    let stderr = collect(
        child.0.as_mut().unwrap().stderr.take().unwrap(),
        job.max_output_bytes,
        total,
        overflow.clone(),
    );
    let outcome = loop {
        let failure = if cancelled.load(Ordering::SeqCst) {
            Some((FailureCode::Cancelled, "转换已取消"))
        } else if started.elapsed() >= Duration::from_millis(job.wall_ms) {
            Some((FailureCode::TimedOut, "转换超过执行时限"))
        } else if overflow.load(Ordering::SeqCst) {
            Some((FailureCode::OutputLimit, "转换输出超过大小上限"))
        } else if work_bytes(&job.work, job.max_work_bytes)
            .map_or(true, |size| size > job.max_work_bytes)
        {
            Some((
                FailureCode::WorkspaceLimit,
                "转换临时空间超过上限或包含异常文件",
            ))
        } else {
            None
        };
        if let Some((code, message)) = failure {
            break Err(SandboxError::new(code, message));
        }
        match child.0.as_mut().unwrap().try_wait() {
            Ok(Some(status)) => {
                // Fork is denied by this Phase A profile. Once this process is
                // reaped there cannot be converter children holding the pipes.
                child.0.take();
                break Ok(status.code());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                break Err(SandboxError::new(
                    FailureCode::StopFailed,
                    "无法确认转换进程状态",
                ))
            }
        }
    };
    drop(child); // terminate/reap before readers and temporary directories
    let out = stdout
        .join()
        .map_err(|_| SandboxError::new(FailureCode::Io, "读取转换输出失败"))?;
    let err = stderr
        .join()
        .map_err(|_| SandboxError::new(FailureCode::Io, "读取转换错误输出失败"))?;
    let exit_code = outcome?;
    if overflow.load(Ordering::SeqCst) {
        return Err(SandboxError::new(
            FailureCode::OutputLimit,
            "转换输出超过大小上限",
        ));
    }
    Ok(ProcessOutput {
        stdout: out?,
        stderr: err?,
        exit_code,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(target_os = "macos")]
struct ChildGuard(Option<std::process::Child>);

#[cfg(target_os = "macos")]
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            // Child has not been reaped, so its process/group ID cannot be reused.
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            // Never return (and clear the persistent unreaped marker) on an
            // ambiguous wait error. Keep ownership and retry confirmation;
            // do not issue another kill using a potentially recycled PID.
            while child.wait().is_err() {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

fn collect(
    reader: impl Read + Send + 'static,
    limit: usize,
    total: Arc<AtomicUsize>,
    overflow: Arc<AtomicBool>,
) -> std::thread::JoinHandle<Result<Vec<u8>, SandboxError>> {
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            let count = reader
                .read(&mut buffer)
                .map_err(|_| SandboxError::new(FailureCode::Io, "读取转换输出失败"))?;
            if count == 0 {
                return Ok(bytes);
            }
            let before = total.fetch_add(count, Ordering::SeqCst);
            if before.saturating_add(count) > limit {
                overflow.store(true, Ordering::SeqCst);
            }
            let keep = count.min(limit.saturating_sub(before));
            bytes.extend_from_slice(&buffer[..keep]);
        }
    })
}

/// Directory usage is monitored, not a hard filesystem quota. Stop on links,
/// special files or excessive entry counts; never traverse outside work.
#[cfg(unix)]
fn work_bytes(path: &std::path::Path, limit: u64) -> std::io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    let fd = unsafe {
        libc::open(
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // Every recursive lookup is anchored to an open directory descriptor;
    // an untrusted rename/symlink swap cannot redirect parent-side traversal.
    fn scan(fd: i32, limit: u64, bytes: &mut u64, entries: &mut usize) -> std::io::Result<()> {
        let raw = unsafe { libc::fdopendir(fd) };
        if raw.is_null() {
            unsafe {
                libc::close(fd);
            }
            return Err(std::io::Error::last_os_error());
        }
        struct Directory(*mut libc::DIR);
        impl Drop for Directory {
            fn drop(&mut self) {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
        let directory = Directory(raw);
        loop {
            let entry = unsafe { libc::readdir(directory.0) };
            if entry.is_null() {
                break;
            }
            let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
            if matches!(name.to_bytes(), b"." | b"..") {
                continue;
            }
            *entries += 1;
            if *entries > 2048 {
                *bytes = limit.saturating_add(1);
                break;
            }
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe {
                libc::fstatat(
                    fd,
                    name.as_ptr(),
                    stat.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            let stat = unsafe { stat.assume_init() };
            match stat.st_mode & libc::S_IFMT {
                libc::S_IFDIR => {
                    let child = unsafe {
                        libc::openat(
                            fd,
                            name.as_ptr(),
                            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                        )
                    };
                    if child < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    scan(child, limit, bytes, entries)?;
                }
                libc::S_IFREG => *bytes = bytes.saturating_add(stat.st_size.max(0) as u64),
                _ => *bytes = limit.saturating_add(1),
            }
            if *bytes > limit {
                break;
            }
        }
        Ok(())
    }
    let mut bytes = 0;
    scan(fd, limit, &mut bytes, &mut 0)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stdout_and_stderr_share_one_bounded_budget() {
        let total = Arc::new(AtomicUsize::new(0));
        let overflow = Arc::new(AtomicBool::new(false));
        let out = collect(
            std::io::Cursor::new(vec![b'a'; 8000]),
            10_000,
            total.clone(),
            overflow.clone(),
        );
        let err = collect(
            std::io::Cursor::new(vec![b'b'; 8000]),
            10_000,
            total,
            overflow.clone(),
        );
        assert_eq!(
            out.join().unwrap().unwrap().len() + err.join().unwrap().unwrap().len(),
            10_000
        );
        assert!(overflow.load(Ordering::SeqCst));
    }

    #[cfg(target_os = "macos")]
    fn job(
        binary: &str,
        input: &std::path::Path,
        work: &std::path::Path,
        args: Vec<String>,
    ) -> ProcessJob {
        ProcessJob {
            binary: std::fs::canonicalize(binary).unwrap(),
            args,
            input: input.into(),
            work: work.into(),
            runtime_read: vec![],
            wall_ms: 1000,
            cpu_seconds: 1,
            max_file_bytes: 1024 * 1024,
            max_work_bytes: 1024 * 1024,
            max_output_bytes: 1024,
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "Requires Seatbelt outside an already sandboxed test runner"]
    fn live_seatbelt_read_write_exec_and_cancel_boundaries() {
        use super::super::staging::StagingRoot;
        use sha2::{Digest, Sha256};
        let owner = StagingRoot::create().unwrap();
        let bytes = b"private input\n";
        let hash = format!("{:x}", Sha256::digest(bytes));
        let first = owner.stage(bytes, &hash, "png", 100).unwrap();
        let other = owner.stage(bytes, &hash, "png", 100).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let positive = run(
            &job(
                "/bin/cat",
                &first.input,
                &first.work,
                vec![first.input.display().to_string()],
            ),
            cancelled.clone(),
        )
        .unwrap();
        assert_eq!(
            positive.exit_code,
            Some(0),
            "positive probe failed: {:?}",
            positive.stderr
        );
        assert_eq!(positive.stdout, bytes);
        let denied = run(
            &job(
                "/bin/cat",
                &first.input,
                &first.work,
                vec![other.input.display().to_string()],
            ),
            cancelled.clone(),
        )
        .unwrap();
        assert_ne!(denied.exit_code, Some(0));
        assert!(denied.stdout.is_empty());
        let output_path = first.work.join("result.txt");
        let write = run(
            &job(
                "/bin/bash",
                &first.input,
                &first.work,
                vec![
                    "-c".into(),
                    "printf ok > \"$1\"; printf bad > \"$2\"".into(),
                    "test".into(),
                    output_path.display().to_string(),
                    first.input.display().to_string(),
                ],
            ),
            cancelled.clone(),
        )
        .unwrap();
        assert_ne!(write.exit_code, Some(0));
        assert!(
            output_path.exists(),
            "positive write failed: {}",
            String::from_utf8_lossy(&write.stderr)
        );
        assert_eq!(std::fs::read(&output_path).unwrap(), b"ok");
        assert_eq!(std::fs::read(&first.input).unwrap(), bytes);
        let exec = run(
            &job(
                "/bin/bash",
                &first.input,
                &first.work,
                vec!["-c".into(), "exec /usr/bin/true".into()],
            ),
            cancelled.clone(),
        )
        .unwrap();
        assert_ne!(exec.exit_code, Some(0));
        // Bash builtins exercise fork and socket creation without granting an
        // additional executable. Never use an unbounded fork fixture.
        let fork = run(
            &job(
                "/bin/bash",
                &first.input,
                &first.work,
                vec!["-c".into(), "(printf escaped > forked)".into()],
            ),
            cancelled.clone(),
        );
        assert!(!first.work.join("forked").exists());
        assert!(fork.is_err() || fork.unwrap().exit_code != Some(0));
        // A real listener avoids mistaking a closed port for sandbox denial.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let network = run(
            &job(
                "/bin/bash",
                &first.input,
                &first.work,
                vec![
                    "-c".into(),
                    format!("printf escaped > /dev/tcp/127.0.0.1/{port}"),
                ],
            ),
            cancelled.clone(),
        )
        .unwrap();
        assert_ne!(network.exit_code, Some(0));
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        let mut timeout_job = job(
            "/bin/bash",
            &first.input,
            &first.work,
            vec!["-c".into(), "while :; do :; done".into()],
        );
        timeout_job.wall_ms = 50;
        assert_eq!(
            run(&timeout_job, cancelled.clone()).unwrap_err().code,
            FailureCode::TimedOut
        );
        let cancel = cancelled.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            cancel.store(true, Ordering::SeqCst);
        });
        timeout_job.wall_ms = 1000;
        assert_eq!(
            run(&timeout_job, cancelled).unwrap_err().code,
            FailureCode::Cancelled
        );
    }

    #[cfg(unix)]
    #[test]
    fn directory_monitor_rejects_links_and_counts_regular_files() {
        use super::super::staging::StagingRoot;
        use sha2::{Digest, Sha256};
        let owner = StagingRoot::create().unwrap();
        let input = owner
            .stage(b"x", &format!("{:x}", Sha256::digest(b"x")), "png", 1)
            .unwrap();
        std::fs::write(input.work.join("a"), b"abc").unwrap();
        assert_eq!(work_bytes(&input.work, 100).unwrap(), 3);
        std::os::unix::fs::symlink(&input.input, input.work.join("link")).unwrap();
        assert!(work_bytes(&input.work, 100).unwrap() > 100);
    }
}
