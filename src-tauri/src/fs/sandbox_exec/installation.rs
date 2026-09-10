//! Instance-local package validation jobs. Never publishes runtime capability.
use super::{
    package,
    types::{FailureCode, SandboxError},
};
use package::{PreparationPhase, PreparationProgress};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::State;
use uuid::Uuid;

#[derive(Clone, Default)]
pub(crate) struct InstallationManager(Arc<Mutex<Inner>>);

#[derive(Default)]
struct Inner {
    closing: bool,
    job: Option<Job>,
}

struct Job {
    snapshot: JobSnapshot,
    cancelled: bool,
    retained_root: Option<PathBuf>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum JobStatus {
    Running,
    Stopping,
    CleaningUp,
    Validated,
    Cancelled,
    Failed,
    CleanupFailed,
    Cleaned,
}

impl JobStatus {
    fn active(self) -> bool {
        matches!(self, Self::Running | Self::Stopping | Self::CleaningUp)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobSnapshot {
    pub id: String,
    pub status: JobStatus,
    pub progress: Option<PreparationProgress>,
    pub error: Option<SandboxError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallationSnapshot {
    can_prepare: bool,
    unavailable_reason: Option<String>,
    closing: bool,
    job: Option<JobSnapshot>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PackageSelection {
    archive_path: PathBuf,
    descriptor_path: PathBuf,
    signature_path: PathBuf,
}

fn error(code: FailureCode, message: &str) -> SandboxError {
    SandboxError::new(code, message)
}

impl InstallationManager {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, SandboxError> {
        self.0
            .lock()
            .map_err(|_| error(FailureCode::StopFailed, "组件作业状态异常"))
    }

    pub(crate) fn snapshot(&self) -> Result<InstallationSnapshot, SandboxError> {
        let inner = self.lock()?;
        let unavailable = package::preparation_unavailable_reason();
        Ok(InstallationSnapshot {
            can_prepare: unavailable.is_none() && !inner.closing,
            unavailable_reason: unavailable.map(|error| error.message),
            closing: inner.closing,
            job: inner.job.as_ref().map(|job| job.snapshot.clone()),
        })
    }

    fn reserve(&self) -> Result<String, SandboxError> {
        let mut inner = self.lock()?;
        if inner.closing {
            return Err(error(FailureCode::Cancelled, "应用正在退出"));
        }
        if inner
            .job
            .as_ref()
            .is_some_and(|job| job.snapshot.status.active() || job.retained_root.is_some())
        {
            return Err(error(
                FailureCode::ExecutionBusy,
                "组件作业仍在运行或等待清理",
            ));
        }
        let id = Uuid::new_v4().to_string();
        inner.job = Some(Job {
            snapshot: JobSnapshot {
                id: id.clone(),
                status: JobStatus::Running,
                progress: None,
                error: None,
            },
            cancelled: false,
            retained_root: None,
        });
        Ok(id)
    }

    fn start(&self, selection: PackageSelection) -> Result<String, SandboxError> {
        if let Some(reason) = package::preparation_unavailable_reason() {
            return Err(reason);
        }
        if [
            &selection.archive_path,
            &selection.descriptor_path,
            &selection.signature_path,
        ]
        .iter()
        .any(|path| !path.is_absolute())
        {
            return Err(error(FailureCode::InvalidInput, "组件文件必须是绝对路径"));
        }
        let id = self.reserve()?;
        let manager = self.clone();
        let job_id = id.clone();
        if std::thread::Builder::new()
            .name("ocr-package-validation".into())
            .spawn(move || {
                manager.run(&job_id, |root| {
                    manager.check(&job_id)?;
                    let descriptor = read_small(&selection.descriptor_path, 64 * 1024)?;
                    manager.check(&job_id)?;
                    let signature =
                        String::from_utf8(read_small(&selection.signature_path, 4 * 1024)?)
                            .map_err(|_| {
                                error(FailureCode::DependencyInvalid, "组件签名不是 UTF-8 文本")
                            })?;
                    let prepared = package::prepare_package_with_progress(
                        &selection.archive_path,
                        &descriptor,
                        &signature,
                        root,
                        || manager.check(&job_id),
                        |event| manager.progress(&job_id, event),
                    )?;
                    // Validation UI cannot retain a token for later activation or
                    // reopen the user's archive under a stale verification result.
                    prepared.discard()?;
                    manager.check(&job_id)
                });
            })
            .is_err()
        {
            self.finish(
                &id,
                Err(error(FailureCode::Io, "无法启动组件校验作业")),
                None,
                false,
            )?;
            return Err(error(FailureCode::Io, "无法启动组件校验作业"));
        }
        Ok(id)
    }

    fn check(&self, id: &str) -> Result<(), SandboxError> {
        let inner = self.lock()?;
        let job = inner
            .job
            .as_ref()
            .filter(|job| job.snapshot.id == id)
            .ok_or_else(|| error(FailureCode::Cancelled, "组件作业已失效"))?;
        if inner.closing || job.cancelled || !job.snapshot.status.active() {
            Err(error(FailureCode::Cancelled, "组件作业已取消"))
        } else {
            Ok(())
        }
    }

    fn progress(&self, id: &str, progress: PreparationProgress) {
        if let Ok(mut inner) = self.lock() {
            if let Some(job) = inner
                .job
                .as_mut()
                .filter(|job| job.snapshot.id == id && job.snapshot.status.active())
            {
                if !job.cancelled || progress.phase == PreparationPhase::CleaningUp {
                    job.snapshot.progress = Some(progress);
                }
            }
        }
    }

    fn run(&self, id: &str, operation: impl FnOnce(&Path) -> Result<(), SandboxError>) {
        let mut root = None;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.check(id)?;
            let parent = fs::canonicalize(std::env::temp_dir())
                .map_err(|_| error(FailureCode::Io, "临时目录不可用"))?;
            let path = parent.join(format!("solidify-ocr-install-{}", Uuid::new_v4()));
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder
                .create(&path)
                .map_err(|_| error(FailureCode::Io, "无法创建组件作业私有目录"))?;
            root = Some(path.clone());
            self.check(id)?;
            operation(&path)
        }))
        .unwrap_or_else(|_| Err(error(FailureCode::Io, "组件校验作业异常结束")));
        self.mark_cleaning(id);
        let retained = root.filter(|path| cleanup(path).is_err());
        let _ = self.finish(id, result, retained, false);
    }

    fn mark_cleaning(&self, id: &str) {
        if let Ok(mut inner) = self.lock() {
            if let Some(job) = inner
                .job
                .as_mut()
                .filter(|job| job.snapshot.id == id && job.snapshot.status.active())
            {
                job.snapshot.status = JobStatus::CleaningUp;
                job.snapshot.progress = Some(PreparationProgress {
                    phase: PreparationPhase::CleaningUp,
                    completed_bytes: 0,
                    total_bytes: None,
                    completed_files: 0,
                    total_files: None,
                });
            }
        }
    }

    fn finish(
        &self,
        id: &str,
        result: Result<(), SandboxError>,
        retained: Option<PathBuf>,
        retry: bool,
    ) -> Result<(), SandboxError> {
        let mut inner = self.lock()?;
        let closing = inner.closing;
        let Some(job) = inner.job.as_mut().filter(|job| job.snapshot.id == id) else {
            return Ok(());
        };
        job.retained_root = retained;
        job.snapshot.progress = None;
        if job.retained_root.is_some() {
            job.snapshot.status = JobStatus::CleanupFailed;
            job.snapshot.error = Some(error(
                FailureCode::StopFailed,
                "组件暂存清理失败，请重试清理",
            ));
        } else if retry {
            job.snapshot.status = JobStatus::Cleaned;
            job.snapshot.error = None;
        } else if job.cancelled
            || closing
            || result
                .as_ref()
                .is_err_and(|error| error.code == FailureCode::Cancelled)
        {
            job.snapshot.status = JobStatus::Cancelled;
            job.snapshot.error = None;
        } else {
            job.snapshot.status = if result.is_ok() {
                JobStatus::Validated
            } else {
                JobStatus::Failed
            };
            job.snapshot.error = result.err();
        }
        Ok(())
    }

    fn cancel(&self, id: &str) -> Result<(), SandboxError> {
        let mut inner = self.lock()?;
        let job = inner
            .job
            .as_mut()
            .filter(|job| job.snapshot.id == id)
            .ok_or_else(|| error(FailureCode::InvalidInput, "组件作业不存在或已被替换"))?;
        if job.snapshot.status.active() {
            job.cancelled = true;
            job.snapshot.status = JobStatus::Stopping;
        }
        Ok(())
    }

    fn retry_cleanup(&self, id: &str) -> Result<(), SandboxError> {
        let root = {
            let mut inner = self.lock()?;
            let job = inner
                .job
                .as_mut()
                .filter(|job| {
                    job.snapshot.id == id && job.snapshot.status == JobStatus::CleanupFailed
                })
                .ok_or_else(|| error(FailureCode::InvalidInput, "没有可重试的组件清理作业"))?;
            let root = job
                .retained_root
                .clone()
                .ok_or_else(|| error(FailureCode::StopFailed, "组件清理目录状态异常"))?;
            job.snapshot.status = JobStatus::CleaningUp;
            root
        };
        let manager = self.clone();
        let job_id = id.to_string();
        let retained = root.clone();
        if std::thread::Builder::new()
            .name("ocr-package-cleanup".into())
            .spawn(move || {
                let remaining = cleanup(&root).err().map(|_| root);
                let _ = manager.finish(&job_id, Ok(()), remaining, true);
            })
            .is_err()
        {
            self.finish(id, Ok(()), Some(retained), true)?;
            return Err(error(FailureCode::StopFailed, "无法启动组件清理"));
        }
        Ok(())
    }

    pub(crate) fn begin_shutdown(&self) -> Result<(), SandboxError> {
        let retry = {
            let mut inner = self.lock()?;
            inner.closing = true;
            inner.job.as_mut().and_then(|job| {
                if job.snapshot.status.active() {
                    job.cancelled = true;
                    job.snapshot.status = JobStatus::Stopping;
                }
                (job.snapshot.status == JobStatus::CleanupFailed).then(|| job.snapshot.id.clone())
            })
        };
        if let Some(id) = retry {
            self.retry_cleanup(&id)?;
        }
        Ok(())
    }

    pub(crate) fn shutdown_drained(&self) -> Result<bool, SandboxError> {
        let inner = self.lock()?;
        if let Some(job) = &inner.job {
            if job.snapshot.status == JobStatus::CleanupFailed {
                return Err(error(FailureCode::StopFailed, "组件暂存未完成清理"));
            }
            if job.snapshot.status.active() {
                return Ok(false);
            }
        }
        Ok(inner.closing)
    }
}

fn cleanup(root: &Path) -> Result<(), std::io::Error> {
    match fs::remove_dir_all(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn read_small(path: &Path, limit: u64) -> Result<Vec<u8>, SandboxError> {
    if !path.is_absolute() {
        return Err(error(FailureCode::InvalidInput, "组件文件必须是绝对路径"));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    let file = options
        .open(path)
        .map_err(|_| error(FailureCode::DependencyInvalid, "组件描述或签名不可读取"))?;
    let metadata = file
        .metadata()
        .map_err(|_| error(FailureCode::Io, "组件文件不可检查"))?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(error(
            FailureCode::InvalidInput,
            "组件描述或签名类型/大小无效",
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error(FailureCode::Io, "组件文件读取失败"))?;
    if bytes.len() as u64 > limit {
        return Err(error(FailureCode::InvalidInput, "组件描述或签名超过限制"));
    }
    Ok(bytes)
}

#[tauri::command]
pub(crate) fn ocr_installation_status(
    state: State<'_, InstallationManager>,
) -> Result<InstallationSnapshot, SandboxError> {
    state.snapshot()
}
#[tauri::command]
pub(crate) fn ocr_prepare_package(
    state: State<'_, InstallationManager>,
    selection: PackageSelection,
) -> Result<String, SandboxError> {
    state.start(selection)
}
#[tauri::command]
pub(crate) fn ocr_cancel_preparation(
    state: State<'_, InstallationManager>,
    job_id: String,
) -> Result<(), SandboxError> {
    state.cancel(&job_id)
}
#[tauri::command]
pub(crate) fn ocr_retry_preparation_cleanup(
    state: State<'_, InstallationManager>,
    job_id: String,
) -> Result<(), SandboxError> {
    state.retry_cleanup(&job_id)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn wait_terminal(manager: &InstallationManager) -> JobSnapshot {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let job = manager.snapshot().unwrap().job.unwrap();
            if !job.status.active() {
                return job;
            }
            assert!(Instant::now() < deadline, "job did not finish");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn unconfigured_trust_rejects_selection_before_registering_or_reading() {
        let manager = InstallationManager::default();
        let before = manager.snapshot().unwrap();
        assert!(!before.can_prepare);
        assert!(before.unavailable_reason.is_some());
        assert!(manager
            .start(PackageSelection {
                archive_path: "/missing/archive".into(),
                descriptor_path: "/missing/descriptor".into(),
                signature_path: "/missing/signature".into(),
            })
            .is_err());
        assert!(manager.snapshot().unwrap().job.is_none());
        assert!(serde_json::from_value::<PackageSelection>(serde_json::json!({
            "archivePath": "/archive", "descriptorPath": "/descriptor", "signaturePath": "/signature", "trustedKey": "attacker",
        })).is_err());
    }

    #[test]
    fn active_job_exclusion_cancellation_and_shutdown_wait_for_actual_cleanup() {
        let manager = InstallationManager::default();
        let id = manager.reserve().unwrap();
        assert_eq!(
            manager.reserve().unwrap_err().code,
            FailureCode::ExecutionBusy
        );
        assert!(manager.cancel("stale-id").is_err());
        let (ready, path) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        let worker_manager = manager.clone();
        let worker_id = id.clone();
        let worker = std::thread::spawn(move || {
            worker_manager.run(&worker_id, |root| {
                fs::write(root.join("payload"), b"owned partial data").unwrap();
                ready.send(root.to_path_buf()).unwrap();
                resume.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(()) // Even a late success after cancellation must be discarded.
            })
        });
        let root = path.recv_timeout(Duration::from_secs(5)).unwrap();
        manager.cancel(&id).unwrap();
        assert_eq!(
            manager.snapshot().unwrap().job.unwrap().status,
            JobStatus::Stopping
        );
        assert!(manager.check(&id).is_err());
        manager.progress(
            &id,
            PreparationProgress {
                phase: PreparationPhase::ExtractingFiles,
                completed_bytes: 100,
                total_bytes: Some(100),
                completed_files: 1,
                total_files: Some(1),
            },
        );
        assert!(manager.snapshot().unwrap().job.unwrap().progress.is_none());
        manager.begin_shutdown().unwrap();
        assert!(!manager.shutdown_drained().unwrap());
        assert!(root.exists());
        assert_eq!(manager.reserve().unwrap_err().code, FailureCode::Cancelled);
        let other = InstallationManager::default();
        let other_id = other.reserve().unwrap();
        other.run(&other_id, |_| Ok(()));
        assert_eq!(
            other.snapshot().unwrap().job.unwrap().status,
            JobStatus::Validated
        );
        release.send(()).unwrap();
        worker.join().unwrap();
        assert!(!root.exists());
        assert_eq!(
            manager.snapshot().unwrap().job.unwrap().status,
            JobStatus::Cancelled
        );
        assert!(manager.shutdown_drained().unwrap());
        manager.begin_shutdown().unwrap();
        assert!(manager.shutdown_drained().unwrap());
    }

    #[test]
    fn cleanup_failure_blocks_exit_and_retries_only_the_owned_root() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let manager = InstallationManager::default();
        let id = manager.reserve().unwrap();
        let mut retained = PathBuf::new();
        manager.run(&id, |root| {
            retained = root.to_path_buf();
            fs::create_dir(root.join("protected")).unwrap();
            fs::write(root.join("protected/keep"), b"partial").unwrap();
            fs::set_permissions(root.join("protected"), fs::Permissions::from_mode(0o500)).unwrap();
            Ok(())
        });
        assert_eq!(
            manager.snapshot().unwrap().job.unwrap().status,
            JobStatus::CleanupFailed
        );
        assert!(manager.reserve().is_err());
        assert!(!serde_json::to_string(&manager.snapshot().unwrap())
            .unwrap()
            .contains(retained.to_str().unwrap()));
        manager.begin_shutdown().unwrap();
        assert_eq!(wait_terminal(&manager).status, JobStatus::CleanupFailed);
        assert_eq!(
            manager.shutdown_drained().unwrap_err().code,
            FailureCode::StopFailed
        );
        assert_eq!(
            fs::read(retained.join("protected/keep")).unwrap(),
            b"partial"
        );
        fs::set_permissions(
            retained.join("protected"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        manager.begin_shutdown().unwrap();
        assert_eq!(wait_terminal(&manager).status, JobStatus::Cleaned);
        assert!(manager.shutdown_drained().unwrap());
        assert!(!retained.exists());
    }

    #[test]
    fn panic_and_stale_updates_cannot_leave_running_or_replace_a_new_job() {
        let manager = InstallationManager::default();
        let id = manager.reserve().unwrap();
        let root_path = std::cell::RefCell::new(None);
        manager.run(&id, |root| {
            *root_path.borrow_mut() = Some(root.to_path_buf());
            fs::write(root.join("partial"), b"data").unwrap();
            panic!("test preparation panic");
        });
        assert!(!root_path.into_inner().unwrap().exists());
        assert_eq!(
            manager.snapshot().unwrap().job.unwrap().status,
            JobStatus::Failed
        );
        let next = manager.reserve().unwrap();
        manager.finish(&id, Ok(()), None, false).unwrap();
        assert_eq!(manager.snapshot().unwrap().job.unwrap().id, next);
        assert!(manager.cancel(&id).is_err());
        manager.run(&next, |_| Ok(()));
        assert_eq!(
            manager.snapshot().unwrap().job.unwrap().status,
            JobStatus::Validated
        );
        assert!(InstallationManager::default()
            .snapshot()
            .unwrap()
            .job
            .is_none());
    }

    #[test]
    fn descriptor_reads_are_bounded_and_reject_links_and_special_files() {
        use std::os::unix::{ffi::OsStrExt, fs::symlink};
        let manager = InstallationManager::default();
        let id = manager.reserve().unwrap();
        manager.run(&id, |root| {
            let file = root.join("descriptor");
            fs::write(&file, b"12345").unwrap();
            assert!(read_small(&file, 4).is_err());
            assert_eq!(read_small(&file, 5).unwrap(), b"12345");
            assert!(read_small(Path::new("relative"), 5).is_err());
            assert!(read_small(root, 5).is_err());
            let link = root.join("link");
            symlink(&file, &link).unwrap();
            assert!(read_small(&link, 5).is_err());
            let fifo = root.join("fifo");
            let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            assert!(read_small(&fifo, 5).is_err());
            Ok(())
        });
        assert_eq!(
            manager.snapshot().unwrap().job.unwrap().status,
            JobStatus::Validated
        );
    }
}
