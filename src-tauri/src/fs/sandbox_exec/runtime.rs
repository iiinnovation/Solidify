//! Per-desktop installed capability state. The installer must complete package
//! authentication and platform self-tests before publishing components here.
use super::{components::VerifiedComponents, staging::StagingRoot, types::*};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

#[derive(Default)]
pub struct SandboxRuntime {
    closing: AtomicBool,
    // No PATH/environment auto-discovery and no unverified startup activation.
    components: RwLock<Option<Arc<VerifiedComponents>>>,
    staging: Mutex<Option<Arc<StagingRoot>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodCapability {
    method: ExtractMethod,
    available: bool,
    reason_code: Option<FailureCode>,
    reason: Option<String>,
}

impl SandboxRuntime {
    pub(crate) fn recover_abandoned_staging() {
        #[cfg(unix)]
        std::thread::spawn(
            || match super::staging::recovery::recover(&std::env::temp_dir()) {
                Ok(report) => log::info!(
                    "Sandbox staging recovery: removed={}, retained={}, limited={}",
                    report.removed,
                    report.retained,
                    report.limited
                ),
                Err(_) => {
                    log::warn!("Sandbox staging recovery could not inspect temporary storage")
                }
            },
        );
    }

    pub fn components(
        &self,
        method: ExtractMethod,
    ) -> Result<Arc<VerifiedComponents>, SandboxError> {
        if self.closing.load(Ordering::Acquire) {
            return Err(SandboxError::new(FailureCode::Cancelled, "应用正在退出"));
        }
        if !cfg!(target_os = "macos") {
            return Err(SandboxError::new(
                FailureCode::PlatformUnavailable,
                "当前平台尚未开放隔离转换",
            ));
        }
        let components = self
            .components
            .read()
            .map_err(|_| SandboxError::new(FailureCode::DependencyInvalid, "组件状态不可用"))?
            .clone()
            .ok_or_else(|| {
                SandboxError::new(
                    FailureCode::DependencyMissing,
                    "OCR 组件未安装或尚未完成平台验证",
                )
            })?;
        components.revalidate()?;
        if !components.supports(method) {
            return Err(SandboxError::new(
                FailureCode::DependencyMissing,
                "所需转换方法未安装",
            ));
        }
        Ok(components)
    }

    pub fn staging(&self) -> Result<Arc<StagingRoot>, SandboxError> {
        let mut owner = self
            .staging
            .lock()
            .map_err(|_| SandboxError::new(FailureCode::Io, "暂存目录状态不可用"))?;
        if self.closing.load(Ordering::Acquire) {
            return Err(SandboxError::new(FailureCode::Cancelled, "应用正在退出"));
        }
        if owner.is_none() {
            *owner = Some(StagingRoot::create()?);
        }
        Ok(owner.as_ref().unwrap().clone())
    }

    pub fn begin_shutdown(&self) {
        self.closing.store(true, Ordering::Release);
    }

    pub fn finish_shutdown(&self) -> Result<bool, SandboxError> {
        if !self.closing.load(Ordering::Acquire) {
            return Ok(false);
        }
        let mut owner = self
            .staging
            .lock()
            .map_err(|_| SandboxError::new(FailureCode::StopFailed, "暂存目录回收状态异常"))?;
        if let Some(root) = owner.as_ref() {
            if Arc::strong_count(root) != 1 {
                return Ok(false);
            }
            root.remove_empty()?;
        }
        owner.take();
        Ok(true)
    }

    pub fn capabilities(&self) -> Vec<MethodCapability> {
        [ExtractMethod::ImageOcr, ExtractMethod::PdfOcr]
            .into_iter()
            .map(|method| match self.components(method) {
                Ok(_) => MethodCapability {
                    method,
                    available: true,
                    reason_code: None,
                    reason: None,
                },
                Err(error) => MethodCapability {
                    method,
                    available: false,
                    reason_code: Some(error.code),
                    reason: Some(error.message),
                },
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn shutdown_waits_for_staged_owners_then_removes_empty_instance() {
        let runtime = SandboxRuntime::default();
        let owner = runtime.staging().unwrap();
        let staged = owner
            .stage(
                b"test",
                &format!("{:x}", Sha256::digest(b"test")),
                "png",
                100,
            )
            .unwrap();
        let instance = staged
            .input
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        assert!(!runtime.finish_shutdown().unwrap());
        runtime.begin_shutdown();
        assert!(runtime.staging().is_err());
        assert!(runtime.components(ExtractMethod::ImageOcr).is_err());
        assert!(!runtime.finish_shutdown().unwrap());
        drop(staged);
        assert!(!runtime.finish_shutdown().unwrap());
        // Unexpected leftovers are not recursively erased to make exit green.
        let leftover = instance.join("unexpected");
        std::fs::write(&leftover, b"preserve").unwrap();
        drop(owner);
        assert_eq!(
            runtime.finish_shutdown().unwrap_err().code,
            FailureCode::StopFailed
        );
        assert_eq!(std::fs::read(&leftover).unwrap(), b"preserve");
        std::fs::remove_file(leftover).unwrap();
        assert!(runtime.finish_shutdown().unwrap());
        assert!(!instance.exists());
        assert!(runtime.finish_shutdown().unwrap());
        assert!(runtime.staging().is_err());
    }
    #[test]
    fn desktop_runtime_never_infers_readiness_from_host_installation() {
        let runtime = SandboxRuntime::default();
        assert!(runtime
            .capabilities()
            .iter()
            .all(|method| !method.available && method.reason_code.is_some()));
        let first = runtime.staging().unwrap();
        assert!(Arc::ptr_eq(&first, &runtime.staging().unwrap()));
    }
}
