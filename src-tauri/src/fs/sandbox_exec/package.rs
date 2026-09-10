//! Authentication gate for optional offline OCR releases, before unpacking.
//! This does not install or activate anything and is not exposed to model IPC.
use super::types::{FailureCode, SandboxError};
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::Path;

mod preparation;
mod unpack;
pub(crate) use preparation::{PreparationPhase, PreparationProgress};
pub(crate) use unpack::PreparedPackage;

const MAX_DESCRIPTOR_BYTES: usize = 64 * 1024;
const MAX_SIGNATURE_BYTES: usize = 4096;
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
// Release authority is application-owned. Never read keys from the package,
// renderer arguments, PATH, a writable settings file or a model parameter.
const TRUSTED_RELEASE_KEYS: &[&str] = &[];

pub(crate) fn preparation_unavailable_reason() -> Option<SandboxError> {
    if !cfg!(target_os = "macos") {
        Some(SandboxError::new(
            FailureCode::PlatformUnavailable,
            "当前平台尚未开放 OCR 组件准备",
        ))
    } else if TRUSTED_RELEASE_KEYS.is_empty() {
        Some(SandboxError::new(
            FailureCode::DependencyMissing,
            "尚未配置可信 OCR 发布公钥",
        ))
    } else {
        None
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseDescriptor {
    schema_version: u32,
    component: String,
    platform: String,
    architecture: String,
    version: String,
    archive_bytes: u64,
    archive_sha256: String,
    manifest_sha256: String,
}

/// A read-only inspection result, NOT an activation or extraction capability.
/// Installation must copy/recheck the exact archive bytes, authenticate the
/// inner manifest, validate all entries, and pass platform signing/probes.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageVerification {
    version: String,
    archive_sha256: String,
    manifest_sha256: String,
    bytes: u64,
}

fn invalid(message: &str) -> SandboxError {
    SandboxError::new(FailureCode::DependencyInvalid, message)
}

fn verify_signature(bytes: &[u8], signature: &str, keys: &[&str]) -> Result<(), SandboxError> {
    if bytes.is_empty()
        || bytes.len() > MAX_DESCRIPTOR_BYTES
        || signature.len() > MAX_SIGNATURE_BYTES
    {
        return Err(invalid("组件发布描述或签名超过限制"));
    }
    if keys.is_empty() {
        return Err(SandboxError::new(
            FailureCode::DependencyMissing,
            "尚未配置可信 OCR 发布公钥，不能安装或激活组件",
        ));
    }
    let signature = Signature::decode(signature).map_err(|_| invalid("组件发布签名格式无效"))?;
    for key in keys {
        let key = PublicKey::from_base64(key).map_err(|_| invalid("应用内置发布公钥无效"))?;
        // Reject legacy non-prehashed signatures; authenticate both the data
        // and Minisign's trusted comment. Comments do not supply policy fields.
        if key.verify(bytes, &signature, false).is_ok() {
            return Ok(());
        }
    }
    Err(invalid("组件发布签名校验失败"))
}

fn validate_descriptor(descriptor: &ReleaseDescriptor) -> Result<(), SandboxError> {
    let hash = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    if descriptor.schema_version != 1
        || descriptor.component != "solidify-ocr"
        || descriptor.platform != std::env::consts::OS
        || descriptor.architecture != std::env::consts::ARCH
        || descriptor.version.is_empty()
        || matches!(descriptor.version.as_str(), "." | "..")
        || descriptor.version.len() > 80
        || !descriptor
            .version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        || descriptor.archive_bytes == 0
        || descriptor.archive_bytes > MAX_ARCHIVE_BYTES
        || !hash(&descriptor.archive_sha256)
        || !hash(&descriptor.manifest_sha256)
    {
        return Err(invalid("组件发布描述的用途、平台、版本或资源范围无效"));
    }
    Ok(())
}

fn verify_archive(path: &Path, descriptor: &ReleaseDescriptor) -> Result<(), SandboxError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    let mut file = options
        .open(path)
        .map_err(|_| invalid("组件包不可读取或不是普通文件"))?;
    let before = file.metadata().map_err(|_| invalid("无法检查组件包"))?;
    if !before.is_file() || before.len() != descriptor.archive_bytes {
        return Err(invalid("组件包大小与已签名描述不符"));
    }
    if hash_archive(&mut file, descriptor.archive_bytes)? != descriptor.archive_sha256 {
        return Err(invalid("组件包内容与已签名 SHA-256 不符"));
    }
    let after = file.metadata().map_err(|_| invalid("无法复核组件包"))?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err(invalid("组件包在校验期间发生变化"));
    }
    Ok(())
}

fn hash_archive(file: &mut File, expected: u64) -> Result<String, SandboxError> {
    let mut hash = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| invalid("读取组件包失败"))?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > expected {
            return Err(invalid("组件包读取超过声明大小"));
        }
        hash.update(&buffer[..count]);
    }
    if total != expected {
        return Err(invalid("组件包读取不完整"));
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Future installer entry: signature verification happens before JSON parsing
/// and before touching the archive. No network, unpacking or execution here.
pub(crate) fn verify_package(
    path: &Path,
    descriptor: &[u8],
    signature: &str,
) -> Result<PackageVerification, SandboxError> {
    verify_signature(descriptor, signature, TRUSTED_RELEASE_KEYS)?;
    let descriptor: ReleaseDescriptor = serde_json::from_slice(descriptor)
        .map_err(|_| invalid("组件发布描述不是有效的 JSON 契约"))?;
    validate_descriptor(&descriptor)?;
    verify_archive(path, &descriptor)?;
    Ok(PackageVerification {
        version: descriptor.version,
        archive_sha256: descriptor.archive_sha256,
        manifest_sha256: descriptor.manifest_sha256,
        bytes: descriptor.archive_bytes,
    })
}

/// Prepare an authenticated package in an installer-owned private parent.
/// This does not publish a version, run binaries, or grant runtime capability.
pub(crate) fn prepare_package(
    path: &Path,
    descriptor: &[u8],
    signature: &str,
    private_parent: &Path,
) -> Result<PreparedPackage, SandboxError> {
    prepare_package_with_progress(
        path,
        descriptor,
        signature,
        private_parent,
        || Ok(()),
        |_| {},
    )
}

/// Callbacks belong to the backend installer, never to model/renderer input.
/// Progress is stage-local work, not installation or activation readiness.
pub(crate) fn prepare_package_with_progress(
    path: &Path,
    descriptor: &[u8],
    signature: &str,
    private_parent: &Path,
    check: impl Fn() -> Result<(), SandboxError>,
    on_progress: impl Fn(PreparationProgress),
) -> Result<PreparedPackage, SandboxError> {
    prepare_observed(
        path,
        descriptor,
        signature,
        private_parent,
        TRUSTED_RELEASE_KEYS,
        &preparation::Monitor::new(&check, &on_progress),
    )
}

#[cfg(test)]
fn prepare_with_keys(
    path: &Path,
    descriptor: &[u8],
    signature: &str,
    private_parent: &Path,
    keys: &[&str],
) -> Result<PreparedPackage, SandboxError> {
    prepare_observed(
        path,
        descriptor,
        signature,
        private_parent,
        keys,
        &preparation::Monitor::default(),
    )
}

fn prepare_observed(
    path: &Path,
    descriptor: &[u8],
    signature: &str,
    private_parent: &Path,
    keys: &[&str],
    monitor: &preparation::Monitor<'_>,
) -> Result<PreparedPackage, SandboxError> {
    // Fail before reading the archive or creating directories if trust fails.
    monitor.phase(PreparationPhase::Authenticating, None, None)?;
    verify_signature(descriptor, signature, keys)?;
    let descriptor: ReleaseDescriptor = serde_json::from_slice(descriptor)
        .map_err(|_| invalid("组件发布描述不是有效的 JSON 契约"))?;
    validate_descriptor(&descriptor)?;
    monitor.check()?;
    unpack::prepare_observed(path, &descriptor, private_parent, monitor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::sandbox_exec::staging::StagingRoot;
    // Public prehashed signature vector from minisign-verify 0.2.4 tests.
    // No private key or production trust key is stored in this fixture.
    const KEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";

    fn descriptor() -> ReleaseDescriptor {
        ReleaseDescriptor {
            schema_version: 1,
            component: "solidify-ocr".into(),
            platform: std::env::consts::OS.into(),
            architecture: std::env::consts::ARCH.into(),
            version: "1.0.0".into(),
            archive_bytes: 4,
            archive_sha256: format!("{:x}", Sha256::digest(b"test")),
            manifest_sha256: "a".repeat(64),
        }
    }

    #[test]
    fn authenticates_prehashed_signature_and_rejects_modified_data_and_comment() {
        assert!(verify_signature(b"test", SIGNATURE, &[KEY]).is_ok());
        assert!(verify_signature(b"evil", SIGNATURE, &[KEY]).is_err());
        assert!(verify_signature(
            b"test",
            &SIGNATURE.replace("file:test", "file:evil"),
            &[KEY]
        )
        .is_err());
        assert!(verify_signature(&vec![0; MAX_DESCRIPTOR_BYTES + 1], SIGNATURE, &[KEY]).is_err());
    }

    #[test]
    fn unconfigured_production_trust_never_reads_or_accepts_package() {
        let error = verify_package(Path::new("/does-not-exist"), b"{}", SIGNATURE).unwrap_err();
        assert_eq!(error.code, FailureCode::DependencyMissing);
        assert!(error.message.contains("公钥"));
        let progress = std::cell::RefCell::new(Vec::new());
        let error = prepare_package_with_progress(
            Path::new("/missing-archive"),
            b"{}",
            SIGNATURE,
            Path::new("/missing-parent"),
            || Ok(()),
            |event| progress.borrow_mut().push(event.phase),
        )
        .unwrap_err();
        assert_eq!(error.code, FailureCode::DependencyMissing);
        assert_eq!(*progress.borrow(), [PreparationPhase::Authenticating]);
        let error = prepare_package_with_progress(
            Path::new("/missing-archive"),
            b"{}",
            SIGNATURE,
            Path::new("/missing-parent"),
            || {
                Err(SandboxError::new(
                    FailureCode::Cancelled,
                    "cancelled before start",
                ))
            },
            |_| panic!("pre-cancelled preparation must not start"),
        )
        .unwrap_err();
        assert_eq!(error.code, FailureCode::Cancelled);
        let error = prepare_package(
            Path::new("/does-not-exist"),
            b"{}",
            SIGNATURE,
            Path::new("/does-not-exist-parent"),
        )
        .unwrap_err();
        assert_eq!(error.code, FailureCode::DependencyMissing);
        assert!(error.message.contains("公钥"));
    }

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    #[test]
    fn authenticated_preparation_reports_work_not_activation() {
        use std::cell::RefCell;
        let archive = include_bytes!("package/fixtures/test-release.zip");
        let owner = StagingRoot::create().unwrap();
        let staged = owner
            .stage(
                archive,
                &format!("{:x}", Sha256::digest(archive)),
                "png",
                4096,
            )
            .unwrap();
        let events = RefCell::new(Vec::<PreparationProgress>::new());
        let check = || Ok(());
        let notify = |event| events.borrow_mut().push(event);
        let prepared = prepare_observed(
            &staged.input,
            include_bytes!("package/fixtures/test-release.json"),
            include_str!("package/fixtures/test-release.json.minisig"),
            &staged.work,
            &[include_str!("package/fixtures/test-release.pub").trim()],
            &preparation::Monitor::new(&check, &notify),
        )
        .unwrap();
        let events = events.borrow();
        let mut phases: Vec<_> = events.iter().map(|event| event.phase).collect();
        phases.dedup();
        assert_eq!(
            phases,
            [
                PreparationPhase::Authenticating,
                PreparationPhase::CopyingArchive,
                PreparationPhase::InspectingArchive,
                PreparationPhase::ExtractingFiles,
                PreparationPhase::VerifyingComponents
            ]
        );
        for pair in events
            .windows(2)
            .filter(|pair| pair[0].phase == pair[1].phase)
        {
            assert!(pair[1].completed_bytes >= pair[0].completed_bytes);
            assert!(pair[1].completed_files >= pair[0].completed_files);
        }
        let copied = events
            .iter()
            .rev()
            .find(|event| event.phase == PreparationPhase::CopyingArchive)
            .unwrap();
        assert_eq!(copied.completed_bytes, archive.len() as u64);
        assert_eq!(copied.total_bytes, Some(copied.completed_bytes));
        let extracted = events
            .iter()
            .rev()
            .find(|event| event.phase == PreparationPhase::ExtractingFiles)
            .unwrap();
        assert_eq!(
            extracted.completed_bytes,
            prepared
                .manifest()
                .files
                .iter()
                .map(|file| file.bytes)
                .sum::<u64>()
        );
        assert_eq!(extracted.total_bytes, Some(extracted.completed_bytes));
        assert_eq!(extracted.completed_files, 3);
        assert_eq!(extracted.total_files, Some(3));
        assert!(events.last().unwrap().total_bytes.is_none());
        prepared.discard().unwrap();
        assert_eq!(std::fs::read_dir(&staged.work).unwrap().count(), 0);
    }

    #[test]
    fn signed_test_release_follows_the_full_preparation_chain_without_production_trust() {
        // RFC 8032 public test key, injected only in this private unit test.
        // No signing executable or private credential is needed at test time.
        let key = include_str!("package/fixtures/test-release.pub").trim();
        let signature = include_str!("package/fixtures/test-release.json.minisig");
        let descriptor = include_bytes!("package/fixtures/test-release.json");
        let archive = include_bytes!("package/fixtures/test-release.zip");
        verify_signature(descriptor, signature, &[key]).unwrap();
        assert!(!TRUSTED_RELEASE_KEYS.contains(&key));
        let owner = StagingRoot::create().unwrap();
        let hash = format!("{:x}", Sha256::digest(archive));
        let staged = owner.stage(archive, &hash, "png", 4096).unwrap();
        assert_eq!(
            prepare_package(&staged.input, descriptor, signature, &staged.work)
                .unwrap_err()
                .code,
            FailureCode::DependencyMissing
        );
        assert_eq!(std::fs::read_dir(&staged.work).unwrap().count(), 0);
        let result = prepare_with_keys(&staged.input, descriptor, signature, &staged.work, &[key]);
        if !cfg!(all(target_os = "macos", target_arch = "x86_64")) {
            assert_eq!(result.unwrap_err().code, FailureCode::DependencyInvalid);
            return; // This fixture explicitly targets macOS x86_64.
        }
        let prepared = result.unwrap();
        assert_eq!(prepared.manifest().package_version, "test-rfc8032");
        assert_eq!(
            std::fs::read(prepared.root().join("bin/tesseract")).unwrap(),
            b"TEST ONLY: not executable OCR code\n"
        );
        drop(prepared);
        assert_eq!(std::fs::read_dir(&staged.work).unwrap().count(), 0);

        let mut changed = descriptor.to_vec();
        changed[0] ^= 1;
        assert!(prepare_with_keys(
            Path::new("/missing-archive"),
            &changed,
            signature,
            Path::new("/missing-parent"),
            &[key]
        )
        .unwrap_err()
        .message
        .contains("签名"));
        let source = staged.work.join("changed.zip");
        let mut changed = archive.to_vec();
        changed[0] ^= 1;
        std::fs::write(&source, changed).unwrap();
        assert!(
            prepare_with_keys(&source, descriptor, signature, &staged.work, &[key])
                .unwrap_err()
                .message
                .contains("签名")
        );
        assert_eq!(
            std::fs::read_dir(&staged.work).unwrap().count(),
            1,
            "only the caller-owned altered source remains"
        );
    }

    #[test]
    fn descriptor_is_domain_platform_and_budget_bound() {
        assert!(validate_descriptor(&descriptor()).is_ok());
        for field in [
            "component",
            "platform",
            "architecture",
            "version",
            "archiveSha256",
            "manifestSha256",
        ] {
            let mut value = serde_json::to_value(descriptor()).unwrap();
            value[field] = serde_json::json!("../invalid");
            assert!(validate_descriptor(&serde_json::from_value(value).unwrap()).is_err());
        }
        let mut value = descriptor();
        for version in [".", ".."] {
            value.version = version.into();
            assert!(validate_descriptor(&value).is_err());
        }
        let mut value = descriptor();
        value.archive_bytes = MAX_ARCHIVE_BYTES + 1;
        assert!(validate_descriptor(&value).is_err());
    }

    #[test]
    fn archive_is_streamed_and_hash_or_size_changes_are_rejected() {
        let owner = StagingRoot::create().unwrap();
        let staged = owner
            .stage(b"test", &descriptor().archive_sha256, "png", 4)
            .unwrap();
        let path = staged.work.join("package.zip");
        std::fs::write(&path, b"test").unwrap();
        assert!(verify_archive(&path, &descriptor()).is_ok());
        std::fs::write(&path, b"evil").unwrap();
        assert!(verify_archive(&path, &descriptor()).is_err());
        std::fs::write(&path, b"bigger").unwrap();
        assert!(verify_archive(&path, &descriptor()).is_err());
        #[cfg(unix)]
        {
            std::fs::rename(&path, staged.work.join("actual.zip")).unwrap();
            std::os::unix::fs::symlink(staged.work.join("actual.zip"), &path).unwrap();
            assert!(verify_archive(&path, &descriptor()).is_err());
        }
    }
}
