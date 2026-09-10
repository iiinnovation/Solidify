//! Parent end of the worker's lifetime pipe. The worker, not the desktop,
//! owns the converter and its process-group cleanup.
use super::policy::ProcessJob;
use super::types::{FailureCode, SandboxError};
use super::worker::ProcessOutput;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(unix)]
fn inherit_task_lock(command: &mut Command, lock: &std::fs::File) {
    use std::os::unix::{io::AsRawFd, process::CommandExt};
    let fd = lock.as_raw_fd();
    command.arg("--task-lock");
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(fd, 198) < 0 || libc::fcntl(198, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// Blocks only a dedicated background thread. The caller must retain the
/// ExecutionGuard and staged input for this entire call. A stop failure is
/// reported through on_stop_delay while supervision continues: returning
/// before the worker exits would release a still-live batch and its files.
pub fn run(
    worker: &Path,
    job: &ProcessJob,
    check: impl Fn() -> Result<(), SandboxError>,
    on_stop_delay: impl Fn(),
) -> Result<ProcessOutput, SandboxError> {
    run_with_task_lock(worker, job, check, on_stop_delay, None)
}

pub fn run_with_task_lock(
    worker: &Path,
    job: &ProcessJob,
    check: impl Fn() -> Result<(), SandboxError>,
    on_stop_delay: impl Fn(),
    task_lock: Option<&std::fs::File>,
) -> Result<ProcessOutput, SandboxError> {
    job.validate()?;
    check()?;
    let header = serde_json::to_vec(job)
        .map_err(|_| SandboxError::new(FailureCode::InvalidInput, "无法编码转换请求"))?;
    if header.len() >= 1024 * 1024 {
        return Err(SandboxError::new(FailureCode::InvalidInput, "转换请求过大"));
    }
    let mut command = Command::new(worker);
    command.arg("--solidify-sandbox-worker");
    #[cfg(unix)]
    if let Some(lock) = task_lock {
        inherit_task_lock(&mut command, lock);
    }
    #[cfg(not(unix))]
    let _ = task_lock;
    #[cfg(unix)]
    super::staging::recovery::begin_job(&job.input)
        .map_err(|_| SandboxError::new(FailureCode::StopFailed, "转换目录仍有未确认回收的执行"))?;
    let mut child = command
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| {
            #[cfg(unix)]
            let _ = super::staging::recovery::reaped_job(&job.input);
            SandboxError::new(FailureCode::IsolationUnavailable, "无法启动转换监督进程")
        })?;
    let mut lifetime = child.stdin.take();
    let pipe = lifetime.as_mut().unwrap();
    if pipe
        .write_all(&header)
        .and_then(|_| pipe.write_all(b"\n"))
        .and_then(|_| pipe.flush())
        .is_err()
    {
        drop(lifetime.take());
        let _ = child.wait();
        return Err(SandboxError::new(FailureCode::Io, "转换监督进程未接受请求"));
    }
    let mut stdout = child.stdout.take().unwrap();
    // JSON byte arrays expand at most fourfold; bound the protocol independent
    // of the child's own output cap. Overflow closes the reader; the trusted
    // worker only writes this response after it has reaped the converter.
    let reader = std::thread::spawn(move || -> std::io::Result<Vec<u8>> {
        let mut out = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            let n = stdout.read(&mut buffer)?;
            if n == 0 {
                return Ok(out);
            }
            if out.len().saturating_add(n) > 5 * 1024 * 1024 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "worker response exceeded cap",
                ));
            }
            out.extend_from_slice(&buffer[..n]);
        }
    });
    let started = Instant::now();
    let mut failure = None;
    let mut stopping_at = None;
    let mut warned = false;
    let status = loop {
        if failure.is_none() {
            failure = check().err();
            if failure.is_none() && started.elapsed() > Duration::from_millis(job.wall_ms + 5000) {
                failure = Some(SandboxError::new(
                    FailureCode::TimedOut,
                    "转换监督超时，正在回收进程",
                ));
            }
            if failure.is_some() {
                drop(lifetime.take());
                stopping_at = Some(Instant::now());
            }
        }
        if !warned && stopping_at.is_some_and(|at| at.elapsed() > Duration::from_secs(2)) {
            warned = true;
            on_stop_delay();
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                // Keep ownership and retry the reap, without killing the
                // supervisor that must still clean up its child.
                drop(lifetime.take());
                failure = Some(SandboxError::new(
                    FailureCode::StopFailed,
                    "暂时无法确认转换进程已退出",
                ));
                if !warned {
                    warned = true;
                    on_stop_delay();
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    };
    drop(lifetime);
    let bytes = reader
        .join()
        .map_err(|_| SandboxError::new(FailureCode::Io, "读取转换监督结果失败"))?
        .map_err(|_| {
            SandboxError::new(
                FailureCode::OutputLimit,
                "转换监督结果超过协议上限或读取失败",
            )
        })?;
    if let Some(error) = failure {
        return Err(error);
    }
    check()?;
    if !status.success() {
        return Err(SandboxError::new(
            FailureCode::StopFailed,
            "转换监督进程异常退出",
        ));
    }
    serde_json::from_slice::<Result<ProcessOutput, SandboxError>>(&bytes)
        .map_err(|_| SandboxError::new(FailureCode::Io, "转换监督结果格式无效"))?
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::fs::sandbox_exec::staging::StagingRoot;
    use sha2::{Digest, Sha256};

    fn worker_path() -> std::path::PathBuf {
        // The library test harness cannot dispatch the application's worker flag.
        let path = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("solidify");
        assert!(path.is_file(), "Run cargo build --bin solidify first");
        path
    }

    fn job(input: &Path, work: &Path, script: &str) -> ProcessJob {
        ProcessJob {
            binary: std::fs::canonicalize("/bin/bash").unwrap(),
            args: vec!["-c".into(), script.into()],
            input: input.into(),
            work: work.into(),
            runtime_read: vec![],
            wall_ms: 5000,
            cpu_seconds: 5,
            max_file_bytes: 1024,
            max_work_bytes: 4096,
            max_output_bytes: 1024,
        }
    }

    #[test]
    #[ignore = "Requires built app and Seatbelt outside nested sandbox"]
    fn live_supervisor_success_and_cancellation() {
        let root = StagingRoot::create().unwrap();
        let input = root
            .stage(b"x", &format!("{:x}", Sha256::digest(b"x")), "png", 1)
            .unwrap();
        let worker = worker_path();
        let locks = super::super::task_lock::TaskLocks::open(
            &input.input.parent().unwrap().join("task.sqlite"),
        )
        .unwrap();
        let lock = locks.acquire("task").unwrap();
        let positive = run_with_task_lock(
            &worker,
            &job(
                &input.input,
                &input.work,
                "if printf leaked >&198; then exit 9; fi; printf ready",
            ),
            || Ok(()),
            || panic!("unexpected stop delay"),
            Some(&lock),
        )
        .unwrap();
        assert_eq!(positive.exit_code, Some(0));
        assert_eq!(positive.stdout, b"ready");
        assert!(super::super::staging::recovery::may_remove_execution(
            input.input.parent().unwrap().parent().unwrap()
        ));
        let execution = job(
            &input.input,
            &input.work,
            "printf ready > started; while :; do :; done",
        );
        let started = input.work.join("started");
        let result = run(
            &worker,
            &execution,
            || {
                if started.exists() {
                    Err(SandboxError::new(
                        FailureCode::Cancelled,
                        "test cancellation",
                    ))
                } else {
                    Ok(())
                }
            },
            || panic!("worker failed to reap promptly"),
        );
        assert_eq!(result.unwrap_err().code, FailureCode::Cancelled);
        assert!(
            started.exists(),
            "must cancel a running converter, not a failed startup"
        );
    }

    // Only the parent-death test sets this environment variable. The helper's
    // worker owns the converter; killing this helper simulates desktop SIGKILL.
    #[test]
    #[ignore = "Internal subprocess fixture"]
    fn supervisor_parent_death_helper() {
        let Ok(serialized) = std::env::var("SOLIDIFY_TEST_WORKER_JOB") else {
            return;
        };
        let mut execution: ProcessJob = serde_json::from_str(&serialized).unwrap();
        // The recovery variant owns its staging root exclusively in this
        // subprocess so SIGKILL really releases desktop ownership.
        let recovery_parent =
            std::env::var_os("SOLIDIFY_TEST_RECOVERY_PARENT").map(std::path::PathBuf::from);
        let owned_staging = recovery_parent.as_ref().map(|parent| {
            let root = StagingRoot::in_parent(parent).unwrap();
            root.stage(b"x", &format!("{:x}", Sha256::digest(b"x")), "png", 1)
                .unwrap()
        });
        if let Some(staged) = &owned_staging {
            execution.input = staged.input.clone();
            execution.work = staged.work.clone();
            std::fs::write(
                recovery_parent.as_ref().unwrap().join("owned-job.json"),
                serde_json::to_vec(&execution).unwrap(),
            )
            .unwrap();
        }
        let serialized = serde_json::to_string(&execution).unwrap();
        let result_file = std::fs::File::create(
            recovery_parent
                .as_ref()
                .unwrap_or(&execution.work)
                .join("worker-result.json"),
        )
        .unwrap();
        let locks = super::super::task_lock::TaskLocks::open(
            &execution.input.parent().unwrap().join("task.sqlite"),
        )
        .unwrap();
        let lock = locks.acquire("task").unwrap();
        let mut command = Command::new(worker_path());
        command.arg("--solidify-sandbox-worker");
        inherit_task_lock(&mut command, &lock);
        super::super::staging::recovery::begin_job(&execution.input).unwrap();
        let mut worker = command
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(result_file)
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        // Remove the desktop's copy before starting the converter. The outer
        // test must observe exclusion from the worker's inherited FD alone,
        // rather than accidentally proving only that the desktop holds a lock.
        drop(lock);
        let mut lifetime = worker.stdin.take().unwrap();
        lifetime.write_all(serialized.as_bytes()).unwrap();
        lifetime.write_all(b"\n").unwrap();
        lifetime.flush().unwrap();
        let _ = worker.wait();
        drop(lifetime);
        drop(owned_staging);
    }

    #[test]
    #[ignore = "Requires built app and Seatbelt outside nested sandbox"]
    fn live_supervisor_crash_recovery_removes_only_reaped_orphan() {
        let container = StagingRoot::create().unwrap();
        let staged = container
            .stage(b"x", &format!("{:x}", Sha256::digest(b"x")), "png", 1)
            .unwrap();
        let execution = job(
            &staged.input,
            &staged.work,
            "printf ready > started; while :; do :; done",
        );
        let mut parent = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "fs::sandbox_exec::supervisor::tests::supervisor_parent_death_helper",
                "--ignored",
            ])
            .env(
                "SOLIDIFY_TEST_WORKER_JOB",
                serde_json::to_string(&execution).unwrap(),
            )
            .env("SOLIDIFY_TEST_RECOVERY_PARENT", &staged.work)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let owned: Option<ProcessJob> = loop {
            let job = std::fs::read(staged.work.join("owned-job.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<ProcessJob>(&bytes).ok());
            if job
                .as_ref()
                .is_some_and(|job| job.work.join("started").exists())
            {
                break job;
            }
            if Instant::now() >= deadline {
                break None;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let before = super::super::staging::recovery::recover(&staged.work).unwrap();
        let _ = parent.kill();
        parent.wait().unwrap();
        let owned = owned.unwrap_or_else(|| panic!(
            "converter must start before simulated desktop crash; worker result: {:?}",
            std::fs::read_to_string(staged.work.join("worker-result.json"))
        ));
        assert_eq!(before.removed, 0);
        assert_eq!(before.retained, 1);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let report = super::super::staging::recovery::recover(&staged.work).unwrap();
            if report.removed == 1 {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "reaped orphan should become recoverable"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let result = loop {
            if let Some(result) = std::fs::read(staged.work.join("worker-result.json"))
                .ok()
                .and_then(|bytes| {
                    serde_json::from_slice::<Result<ProcessOutput, SandboxError>>(&bytes).ok()
                })
            {
                break result;
            }
            assert!(
                Instant::now() < deadline,
                "worker must confirm converter reap"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(result.unwrap_err().code, FailureCode::Cancelled);
        assert!(!owned.input.exists());
        assert!(
            staged.input.exists(),
            "other live instance must survive recovery"
        );
    }

    #[test]
    #[ignore = "Requires built app and Seatbelt outside nested sandbox"]
    fn live_supervisor_reaps_after_parent_sigkill() {
        let root = StagingRoot::create().unwrap();
        let input = root
            .stage(b"x", &format!("{:x}", Sha256::digest(b"x")), "png", 1)
            .unwrap();
        let execution = job(
            &input.input,
            &input.work,
            "printf ready > started; while :; do :; done",
        );
        let mut parent = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "fs::sandbox_exec::supervisor::tests::supervisor_parent_death_helper",
                "--ignored",
            ])
            .env(
                "SOLIDIFY_TEST_WORKER_JOB",
                serde_json::to_string(&execution).unwrap(),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !input.work.join("started").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let did_start = input.work.join("started").exists();
        let locks = super::super::task_lock::TaskLocks::open(
            &input.input.parent().unwrap().join("task.sqlite"),
        )
        .unwrap();
        let blocked_before_death = locks.acquire("task").is_err();
        let marked_before_death = !super::super::staging::recovery::may_remove_execution(
            input.input.parent().unwrap().parent().unwrap(),
        );
        // Terminate only the exact Child handle created by this test, never a
        // PID recovered from disk. Reap it before testing worker completion.
        let _ = parent.kill();
        parent.wait().unwrap();
        let result_path = input.work.join("worker-result.json");
        let deadline = Instant::now() + Duration::from_secs(3);
        let result = loop {
            if let Ok(bytes) = std::fs::read(&result_path) {
                if let Ok(result) =
                    serde_json::from_slice::<Result<ProcessOutput, SandboxError>>(&bytes)
                {
                    break result;
                }
            }
            assert!(
                Instant::now() < deadline,
                "worker did not acknowledge reap after parent death"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(
            did_start,
            "converter must start before killing its desktop parent; result: {result:?}"
        );
        // The worker serializes this response only after kill + wait and after
        // both converter pipes reach EOF. This is stronger than a PID probe.
        assert_eq!(result.unwrap_err().code, FailureCode::Cancelled);
        assert!(
            marked_before_death,
            "running worker must retain recovery marker"
        );
        assert!(
            super::super::staging::recovery::may_remove_execution(
                input.input.parent().unwrap().parent().unwrap()
            ),
            "worker must acknowledge reap before making orphan cleanup eligible"
        );
        assert!(
            blocked_before_death,
            "active worker must exclude other instances"
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Ok(lock) = locks.acquire("task") {
                drop(lock);
                break;
            }
            assert!(
                Instant::now() < deadline,
                "worker must release lock after reap"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
