//! Private package preparation. ZIP paths are never passed to an archive
//! extractor: only an authenticated, bounded manifest controls file creation.
use super::{invalid, ReleaseDescriptor, MAX_ARCHIVE_BYTES};
use super::{preparation::Monitor, PreparationPhase};
use crate::fs::sandbox_exec::{
    components::{ComponentManifest, VerifiedComponents},
    types::{FailureCode, SandboxError},
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const MANIFEST: &str = "manifest.json";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_FILES: usize = 240;
const MAX_CENTRAL_BYTES: u64 = 256 * 1024;

/// Owns temporary files until platform checks and atomic publication exist.
/// It deliberately cannot be installed into SandboxRuntime as a capability.
#[derive(Debug)]
pub(crate) struct PreparedPackage {
    directory: PathBuf,
    root: PathBuf,
    manifest: Option<ComponentManifest>,
    cleaned: bool,
}

impl PreparedPackage {
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
    pub(crate) fn manifest(&self) -> &ComponentManifest {
        self.manifest
            .as_ref()
            .expect("only complete packages leave preparation")
    }

    pub(crate) fn discard(mut self) -> Result<(), SandboxError> {
        self.cleanup()
    }

    fn cleanup(&mut self) -> Result<(), SandboxError> {
        if !self.cleaned {
            match fs::remove_dir_all(&self.directory) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    return Err(SandboxError::new(
                        FailureCode::StopFailed,
                        "组件准备目录清理失败，不能确认准备已回收",
                    ))
                }
            }
            self.cleaned = true;
        }
        Ok(())
    }
}

impl Drop for PreparedPackage {
    fn drop(&mut self) {
        // Fresh random directory under a checked private installer root. No
        // package code has been executed, and no archive links are created.
        if self.cleanup().is_err() {
            log::warn!("OCR package preparation directory could not be cleaned");
        }
    }
}

fn private_dir(path: &Path) -> Result<(), SandboxError> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|_| invalid("无法创建组件私有暂存目录"))
}

fn new_file(path: &Path) -> Result<File, SandboxError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    options
        .open(path)
        .map_err(|_| invalid("无法创建组件私有文件"))
}

fn seal(file: &File, executable: bool) -> Result<(), SandboxError> {
    file.sync_all().map_err(|_| invalid("无法同步组件文件"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(if executable {
            0o500
        } else {
            0o400
        }))
        .map_err(|_| invalid("无法设置组件文件权限"))?;
    }
    Ok(())
}

#[cfg(test)]
fn prepare(
    source: &Path,
    descriptor: &ReleaseDescriptor,
    parent: &Path,
) -> Result<PreparedPackage, SandboxError> {
    prepare_observed(source, descriptor, parent, &Monitor::default())
}

pub(super) fn prepare_observed(
    source: &Path,
    descriptor: &ReleaseDescriptor,
    parent: &Path,
    monitor: &Monitor<'_>,
) -> Result<PreparedPackage, SandboxError> {
    monitor.check()?;
    if !cfg!(unix) {
        return Err(SandboxError::new(
            FailureCode::PlatformUnavailable,
            "当前平台尚未实现组件私有目录权限验证",
        ));
    }
    // Canonical private parent is supplied by the installer, never the model.
    let metadata = fs::symlink_metadata(parent).map_err(|_| invalid("组件暂存父目录不存在"))?;
    if !parent.is_absolute()
        || !metadata.is_dir()
        || fs::canonicalize(parent).ok().as_deref() != Some(parent)
    {
        return Err(invalid("组件暂存父目录必须是规范化的独立目录"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(invalid("组件暂存父目录必须由当前用户私有持有"));
        }
    }
    let directory = parent.join(format!("ocr-prepare-{}", Uuid::new_v4()));
    private_dir(&directory)?;
    let mut prepared = PreparedPackage {
        root: directory.join("payload"),
        directory,
        manifest: None,
        cleaned: false,
    };
    let result = (|| {
        private_dir(&prepared.root)?;
        monitor.phase(
            PreparationPhase::CopyingArchive,
            Some(descriptor.archive_bytes),
            None,
        )?;
        let snapshot_path = prepared.directory.join("archive.zip");
        let mut snapshot = new_file(&snapshot_path)?;
        snapshot_archive_observed(source, descriptor, &mut snapshot, monitor)?;
        seal(&snapshot, false)?;
        snapshot
            .seek(SeekFrom::Start(0))
            .map_err(|_| invalid("无法读取组件副本"))?;
        monitor.phase(PreparationPhase::InspectingArchive, None, None)?;
        let manifest = unpack_observed(&mut snapshot, descriptor, &prepared.root, monitor)?;
        monitor.phase(PreparationPhase::VerifyingComponents, None, None)?;
        // Rehashing up to 512 MiB must remain cancellable too, not just ZIP I/O.
        VerifiedComponents::verify_with_check(&prepared.root, manifest.clone(), || {
            monitor.check()
        })?;
        drop(snapshot);
        fs::remove_file(snapshot_path).map_err(|_| invalid("无法清理组件归档副本"))?;
        monitor.check()?;
        Ok(manifest)
    })();
    match result {
        Ok(manifest) => {
            prepared.manifest = Some(manifest);
            Ok(prepared)
        }
        Err(error) => {
            monitor.cleaning_up();
            // A failed cleanup must not be presented as successful cancellation.
            prepared.discard()?;
            Err(error)
        }
    }
}

#[cfg(test)]
fn snapshot_archive(
    source: &Path,
    descriptor: &ReleaseDescriptor,
    destination: &mut File,
) -> Result<(), SandboxError> {
    snapshot_archive_observed(source, descriptor, destination, &Monitor::default())
}

fn snapshot_archive_observed(
    source: &Path,
    descriptor: &ReleaseDescriptor,
    destination: &mut File,
    monitor: &Monitor<'_>,
) -> Result<(), SandboxError> {
    monitor.check()?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    let mut input = options
        .open(source)
        .map_err(|_| invalid("组件归档不可读取"))?;
    let before = input.metadata().map_err(|_| invalid("无法检查组件归档"))?;
    if !before.is_file()
        || before.len() != descriptor.archive_bytes
        || before.len() > MAX_ARCHIVE_BYTES
    {
        return Err(invalid("组件归档类型或大小不符"));
    }
    let digest = copy_bounded_observed(&mut input, destination, descriptor.archive_bytes, monitor)?;
    let after = input.metadata().map_err(|_| invalid("无法复核组件归档"))?;
    if digest != descriptor.archive_sha256
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err(invalid("组件归档内容与签名不符或在复制时改变"));
    }
    Ok(())
}

#[cfg(test)]
fn copy_bounded(
    reader: &mut impl Read,
    writer: &mut impl Write,
    expected: u64,
) -> Result<String, SandboxError> {
    copy_bounded_observed(reader, writer, expected, &Monitor::default())
}

fn copy_bounded_observed(
    reader: &mut impl Read,
    writer: &mut impl Write,
    expected: u64,
    monitor: &Monitor<'_>,
) -> Result<String, SandboxError> {
    let mut digest = Sha256::new();
    let mut remaining = expected;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        monitor.check()?;
        // Read one extra byte to detect expansion beyond the signed size,
        // including a ZIP entry whose actual decompression exceeds its header.
        let capacity = buffer.len().min(remaining.saturating_add(1) as usize);
        let count = reader
            .read(&mut buffer[..capacity])
            .map_err(|_| invalid("组件读取或 ZIP 完整性检查失败"))?;
        if count == 0 {
            break;
        }
        if count as u64 > remaining {
            return Err(invalid("组件展开超过声明字节数"));
        }
        remaining -= count as u64;
        writer
            .write_all(&buffer[..count])
            .map_err(|_| invalid("组件写入失败"))?;
        digest.update(&buffer[..count]);
        monitor.bytes(count as u64)?;
    }
    if remaining != 0 {
        return Err(invalid("组件内容不完整"));
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn safe_name(name: &str) -> Result<(), SandboxError> {
    // ASCII names also avoid Unicode normalization aliases on macOS. The
    // payload contract is intentionally stricter than a general ZIP utility.
    if name.is_empty()
        || name.len() > 240
        || name.split('/').count() > 8
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-/".contains(&byte))
        || name
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(invalid("组件包包含不安全或不支持的文件路径"));
    }
    Ok(())
}

/// Bound metadata before ZipArchive allocates its index. This release format
/// is classic single-disk ZIP without comments, ZIP64 or appended content.
fn zip_entry_count(file: &mut File, monitor: &Monitor<'_>) -> Result<usize, SandboxError> {
    monitor.check()?;
    let length = file
        .metadata()
        .map_err(|_| invalid("无法检查 ZIP 副本"))?
        .len();
    if length < 22 {
        return Err(invalid("组件 ZIP 不完整"));
    }
    file.seek(SeekFrom::End(-22))
        .map_err(|_| invalid("无法检查 ZIP 目录"))?;
    let mut end = [0u8; 22];
    file.read_exact(&mut end)
        .map_err(|_| invalid("无法读取 ZIP 目录"))?;
    let u16_at = |offset| u16::from_le_bytes([end[offset], end[offset + 1]]);
    let u32_at = |offset| u32::from_le_bytes(end[offset..offset + 4].try_into().unwrap()) as u64;
    let entries = u16_at(10) as usize;
    if &end[..4] != b"PK\x05\x06"
        || u16_at(4) != 0
        || u16_at(6) != 0
        || u16_at(8) as usize != entries
        || u16_at(20) != 0
        || entries == 0
        || entries > MAX_FILES + 1
        || u32_at(12) > MAX_CENTRAL_BYTES
        || u32_at(16) + u32_at(12) != length - 22
    {
        return Err(invalid("组件 ZIP 格式、文件数或目录大小超出限制"));
    }
    audit_zip_headers(file, u32_at(16), u32_at(12), entries, monitor)?;
    file.seek(SeekFrom::Start(0))
        .map_err(|_| invalid("无法读取 ZIP 副本"))?;
    Ok(entries)
}

fn audit_zip_headers(
    file: &mut File,
    central_start: u64,
    central_size: u64,
    count: usize,
    monitor: &Monitor<'_>,
) -> Result<(), SandboxError> {
    let error = || invalid("组件 ZIP 目录、条目计数或本地头不一致");
    file.seek(SeekFrom::Start(central_start))
        .map_err(|_| error())?;
    let mut central = vec![0u8; central_size as usize];
    file.read_exact(&mut central).map_err(|_| error())?;
    let read16 = |bytes: &[u8], pos: usize| {
        u16::from_le_bytes(bytes[pos..pos + 2].try_into().unwrap()) as usize
    };
    let read32 = |bytes: &[u8], pos: usize| {
        u32::from_le_bytes(bytes[pos..pos + 4].try_into().unwrap()) as u64
    };
    let mut position = 0usize;
    let mut spans = Vec::with_capacity(count);
    for _ in 0..count {
        monitor.check()?;
        let header = central.get(position..position + 46).ok_or_else(error)?;
        if &header[..4] != b"PK\x01\x02" || read16(header, 34) != 0 {
            return Err(error());
        }
        let name_len = read16(header, 28);
        let extra_len = read16(header, 30);
        let comment_len = read16(header, 32);
        let record_end = position + 46 + name_len + extra_len + comment_len;
        if record_end > central.len() {
            return Err(error());
        }
        let name = &central[position + 46..position + 46 + name_len];
        let local_start = read32(header, 42);
        // Only the UTF-8 flag is accepted. Streaming/data-descriptor ZIPs,
        // encryption and ZIP64 require a different reviewed package contract.
        if read16(header, 8) & !0x0800 != 0
            || read32(header, 20) == u32::MAX as u64
            || read32(header, 24) == u32::MAX as u64
            || local_start + 30 > central_start
        {
            return Err(error());
        }
        file.seek(SeekFrom::Start(local_start))
            .map_err(|_| error())?;
        let mut local = [0u8; 30];
        file.read_exact(&mut local).map_err(|_| error())?;
        if &local[..4] != b"PK\x03\x04"
            || read16(&local, 6) != read16(header, 8)
            || read16(&local, 8) != read16(header, 10)
            || read16(&local, 26) != name_len
            || local[14..26] != header[16..28]
        {
            return Err(error());
        }
        let mut local_name = vec![0u8; name_len];
        file.read_exact(&mut local_name).map_err(|_| error())?;
        if local_name != name {
            return Err(error());
        }
        let local_end =
            local_start + 30 + name_len as u64 + read16(&local, 28) as u64 + read32(header, 20);
        if local_end > central_start {
            return Err(error());
        }
        spans.push((local_start, local_end));
        position = record_end;
    }
    if position != central.len() {
        return Err(error());
    }
    spans.sort_unstable();
    let mut previous_end = 0;
    for (start, end) in spans {
        if start != previous_end {
            return Err(error());
        }
        previous_end = end;
    }
    if previous_end != central_start {
        return Err(error());
    }
    Ok(())
}

#[cfg(test)]
fn unpack(
    file: &mut File,
    descriptor: &ReleaseDescriptor,
    root: &Path,
) -> Result<ComponentManifest, SandboxError> {
    unpack_observed(file, descriptor, root, &Monitor::default())
}

fn unpack_observed(
    file: &mut File,
    descriptor: &ReleaseDescriptor,
    root: &Path,
    monitor: &Monitor<'_>,
) -> Result<ComponentManifest, SandboxError> {
    let declared_count = zip_entry_count(file, monitor)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| invalid("组件 ZIP 无效"))?;
    // zip indexes entries by name. Check the original EOCD count as well so
    // duplicate entries cannot silently replace one another in that index.
    if archive.len() != declared_count || archive.offset() != 0 {
        return Err(invalid("组件 ZIP 含重复条目或前置内容"));
    }
    let mut entries = BTreeMap::new();
    let mut names = BTreeSet::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        monitor.check()?;
        let entry = archive
            .by_index(index)
            .map_err(|_| invalid("无法读取组件 ZIP 条目"))?;
        let name =
            std::str::from_utf8(entry.name_raw()).map_err(|_| invalid("组件文件名编码无效"))?;
        safe_name(name)?;
        let mode = entry.unix_mode().unwrap_or(0o100600);
        if entry.is_dir()
            || entry.encrypted()
            || mode & 0o170000 != 0o100000
            || mode & 0o7000 != 0
            || !matches!(
                entry.compression(),
                zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated
            )
            || !names.insert(name.to_ascii_lowercase())
        {
            return Err(invalid("组件 ZIP 含链接、特殊文件、权限、加密或路径别名"));
        }
        total = total
            .checked_add(entry.size())
            .ok_or_else(|| invalid("组件展开预算溢出"))?;
        if total > MAX_ARCHIVE_BYTES + MAX_MANIFEST_BYTES {
            return Err(invalid("组件展开体积超限"));
        }
        entries.insert(name.to_owned(), entry.size());
    }
    for name in &names {
        let mut parent = name.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            if names.contains(prefix) {
                return Err(invalid("组件包包含文件与目录冲突"));
            }
            parent = prefix;
        }
    }
    let manifest_size = *entries
        .get(MANIFEST)
        .ok_or_else(|| invalid("组件包缺少内层清单"))?;
    if manifest_size > MAX_MANIFEST_BYTES {
        return Err(invalid("组件内层清单超限"));
    }
    let mut bytes = Vec::new();
    let hash = copy_bounded_observed(
        &mut archive
            .by_name(MANIFEST)
            .map_err(|_| invalid("无法读取内层清单"))?,
        &mut bytes,
        manifest_size,
        monitor,
    )?;
    if hash != descriptor.manifest_sha256 {
        return Err(invalid("内层清单与签名哈希不符"));
    }
    let manifest: ComponentManifest =
        serde_json::from_slice(&bytes).map_err(|_| invalid("组件内层清单格式无效"))?;
    if manifest.package_version != descriptor.version
        || manifest.platform != descriptor.platform
        || manifest.architecture != descriptor.architecture
        || manifest.files.len() > MAX_FILES
        || entries.len() != manifest.files.len() + 1
    {
        return Err(invalid("组件清单与已签名版本或条目集合不符"));
    }
    let mut listed = BTreeSet::new();
    let mut total = 0u64;
    monitor.check()?;
    for item in &manifest.files {
        safe_name(&item.path)?;
        if item.path == MANIFEST
            || !listed.insert(&item.path)
            || entries.get(&item.path) != Some(&item.bytes)
        {
            return Err(invalid("组件 ZIP 存在未列入清单、缺失或大小不符的文件"));
        }
        total = total
            .checked_add(item.bytes)
            .ok_or_else(|| invalid("组件清单预算溢出"))?;
        if total > MAX_ARCHIVE_BYTES {
            return Err(invalid("组件清单展开体积超限"));
        }
    }
    monitor.phase(
        PreparationPhase::ExtractingFiles,
        Some(total),
        Some(manifest.files.len() as u64),
    )?;
    for item in &manifest.files {
        monitor.check()?;
        let target = root.join(&item.path);
        let mut directory = root.to_path_buf();
        let parts: Vec<_> = item.path.split('/').collect();
        for part in &parts[..parts.len() - 1] {
            directory.push(part);
            if !directory.exists() {
                private_dir(&directory)?;
            }
            let meta = fs::symlink_metadata(&directory).map_err(|_| invalid("组件目录不可读取"))?;
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err(invalid("组件目录被替换"));
            }
        }
        let mut output = new_file(&target)?;
        let hash = copy_bounded_observed(
            &mut archive
                .by_name(&item.path)
                .map_err(|_| invalid("组件条目缺失"))?,
            &mut output,
            item.bytes,
            monitor,
        )?;
        if hash != item.sha256 {
            return Err(invalid("组件文件哈希与认证清单不符"));
        }
        let executable = item.path == manifest.tesseract
            || manifest.pdfinfo.as_ref() == Some(&item.path)
            || manifest.pdftoppm.as_ref() == Some(&item.path);
        seal(&output, executable)?;
        monitor.file_finished()?;
    }
    // Keep the authenticated manifest beside the files for the later installer.
    monitor.check()?;
    let mut output = new_file(&root.join(MANIFEST))?;
    output
        .write_all(&bytes)
        .map_err(|_| invalid("无法保存组件清单"))?;
    seal(&output, false)?;
    Ok(manifest)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::fs::sandbox_exec::{
        components::ComponentFile,
        staging::{StagedInput, StagingRoot},
    };
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;

    fn hash(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn fixture() -> (ComponentManifest, Vec<(String, Vec<u8>)>) {
        let files: Vec<(String, Vec<u8>)> = vec![
            (
                "bin/tesseract".into(),
                b"not an executable; never run".to_vec(),
            ),
            (
                "tessdata/chi_sim.traineddata".into(),
                crate::fs::sandbox_exec::components::traineddata::fixture(""),
            ),
            (
                "tessdata/eng.traineddata".into(),
                crate::fs::sandbox_exec::components::traineddata::fixture(""),
            ),
        ];
        let manifest = ComponentManifest {
            schema_version: 1,
            platform: std::env::consts::OS.into(),
            architecture: std::env::consts::ARCH.into(),
            package_version: "fixture-1".into(),
            tesseract: "bin/tesseract".into(),
            tesseract_version: "fixture".into(),
            pdfinfo: None,
            pdftoppm: None,
            poppler_version: None,
            tessdata_dir: "tessdata".into(),
            language_versions: [
                ("chi_sim".into(), "fixture".into()),
                ("eng".into(), "fixture".into()),
            ]
            .into_iter()
            .collect(),
            files: files
                .iter()
                .map(|(name, bytes)| ComponentFile {
                    path: name.clone(),
                    sha256: hash(bytes),
                    bytes: bytes.len() as u64,
                })
                .collect(),
        };
        (manifest, files)
    }

    fn archive(manifest: &ComponentManifest, files: &[(String, Vec<u8>)]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o600);
        zip.start_file(MANIFEST, options).unwrap();
        zip.write_all(&serde_json::to_vec(manifest).unwrap())
            .unwrap();
        for (name, bytes) in files {
            zip.start_file(name, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn descriptor(manifest: &ComponentManifest, bytes: &[u8]) -> ReleaseDescriptor {
        ReleaseDescriptor {
            schema_version: 1,
            component: "solidify-ocr".into(),
            platform: manifest.platform.clone(),
            architecture: manifest.architecture.clone(),
            version: manifest.package_version.clone(),
            archive_bytes: bytes.len() as u64,
            archive_sha256: hash(bytes),
            manifest_sha256: hash(&serde_json::to_vec(manifest).unwrap()),
        }
    }

    fn workspace() -> StagedInput {
        StagingRoot::create()
            .unwrap()
            .stage(b"seed", &hash(b"seed"), "png", 1024)
            .unwrap()
    }

    fn reject_archive(manifest: &ComponentManifest, bytes: &[u8], expected: &str) {
        let staged = workspace();
        let parent = staged.work.join("installer");
        private_dir(&parent).unwrap();
        let source = staged.work.join("source.zip");
        fs::write(&source, bytes).unwrap();
        let error = prepare(&source, &descriptor(manifest, bytes), &parent).unwrap_err();
        assert!(
            error.message.contains(expected),
            "unexpected rejection: {error:?}"
        );
        assert_eq!(
            fs::read_dir(parent).unwrap().count(),
            0,
            "failed preparation must remove all its files"
        );
        assert_eq!(
            fs::read(source).unwrap(),
            bytes,
            "source package must remain unchanged"
        );
    }

    #[test]
    fn prepares_only_manifest_files_and_cleans_owned_directory_without_activating() {
        let staged = workspace();
        let parent = staged.work.join("installer");
        private_dir(&parent).unwrap();
        let (manifest, files) = fixture();
        let bytes = archive(&manifest, &files);
        let source = staged.work.join("source.zip");
        fs::write(&source, &bytes).unwrap();
        let prepared = prepare(&source, &descriptor(&manifest, &bytes), &parent).unwrap();
        assert_eq!(prepared.manifest().package_version, "fixture-1");
        for (name, bytes) in &files {
            assert_eq!(fs::read(prepared.root().join(name)).unwrap(), *bytes);
        }
        assert!(!prepared.directory.join("archive.zip").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(prepared.root().join("bin/tesseract"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o500
            );
            assert_eq!(
                fs::metadata(prepared.root().join("tessdata/eng.traineddata"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o400
            );
        }
        // Another concurrent preparation must remain intact during cleanup.
        let second = prepare(&source, &descriptor(&manifest, &bytes), &parent).unwrap();
        let root = prepared.directory.clone();
        drop(prepared);
        assert!(!root.exists());
        assert!(second.root().join("bin/tesseract").is_file());
        drop(second);
        assert_eq!(fs::read_dir(parent).unwrap().count(), 0);
    }

    #[test]
    fn rejects_unlisted_missing_tampered_or_mismatched_component_files() {
        let (manifest, files) = fixture();
        let mut extra = files.clone();
        extra.push(("unlisted".into(), b"data".to_vec()));
        reject_archive(&manifest, &archive(&manifest, &extra), "条目集合");
        reject_archive(&manifest, &archive(&manifest, &files[..2]), "条目集合");
        let mut altered = files.clone();
        altered[0].1[0] ^= 1;
        reject_archive(&manifest, &archive(&manifest, &altered), "哈希");
        altered[0].1.push(0);
        reject_archive(&manifest, &archive(&manifest, &altered), "大小不符");
        let mut missing_language = manifest.clone();
        missing_language.language_versions.remove("chi_sim");
        reject_archive(
            &missing_language,
            &archive(&missing_language, &files),
            "语言包",
        );
    }

    #[test]
    fn rejects_unsafe_names_case_aliases_and_file_directory_conflicts() {
        let (manifest, files) = fixture();
        for path in [
            "../outside",
            "/outside",
            "dir/../outside",
            "dir//file",
            "dir\\file",
            "dir/./file",
            "文件",
            "drive:c",
            "dir/",
            "MANIFEST.JSON",
            "bin",
        ] {
            let mut altered = files.clone();
            altered.push((path.into(), vec![]));
            reject_archive(
                &manifest,
                &archive(&manifest, &altered),
                if path == "MANIFEST.JSON" {
                    "路径别名"
                } else if path == "bin" {
                    "目录冲突"
                } else {
                    "路径"
                },
            );
        }
    }

    #[test]
    fn rejects_zip_symlinks_special_modes_duplicates_and_metadata_overflow() {
        let (manifest, files) = fixture();
        let bytes = archive(&manifest, &files);
        // Modify central-directory file type bits. The package is rehashed to
        // exercise structural validation after archive authentication.
        let central = bytes
            .windows(4)
            .position(|value| value == b"PK\x01\x02")
            .unwrap();
        for mode in [0o120777u32, 0o010600, 0o100600 | 0o4000] {
            let mut changed = bytes.clone();
            changed[central + 38..central + 42].copy_from_slice(&(mode << 16).to_le_bytes());
            reject_archive(&manifest, &changed, "特殊文件");
        }
        let mut files = files.clone();
        files.push(("copyfile.json".into(), vec![]));
        let mut duplicate = archive(&manifest, &files);
        for index in 0..duplicate.len() - 12 {
            if &duplicate[index..index + 13] == b"copyfile.json" {
                duplicate[index..index + 13].copy_from_slice(b"manifest.json");
            }
        }
        reject_archive(&manifest, &duplicate, "重复条目");
        let mut oversized = bytes.clone();
        let end = oversized.len() - 22;
        oversized[end + 8..end + 10].copy_from_slice(&242u16.to_le_bytes());
        oversized[end + 10..end + 12].copy_from_slice(&242u16.to_le_bytes());
        reject_archive(&manifest, &oversized, "文件数");
        let mut oversized = bytes.clone();
        let oversized_length = (MAX_ARCHIVE_BYTES + MAX_MANIFEST_BYTES + 1) as u32;
        oversized[central + 24..central + 28].copy_from_slice(&oversized_length.to_le_bytes());
        oversized[22..26].copy_from_slice(&oversized_length.to_le_bytes());
        reject_archive(&manifest, &oversized, "展开体积");

        let mut undercounted = bytes.clone();
        undercounted[end + 8..end + 10].copy_from_slice(&3u16.to_le_bytes());
        undercounted[end + 10..end + 12].copy_from_slice(&3u16.to_le_bytes());
        reject_archive(&manifest, &undercounted, "条目计数");
        let mut local_alias = bytes.clone();
        local_alias[30] = b'x';
        reject_archive(&manifest, &local_alias, "本地头");
    }

    #[test]
    fn forged_zip_sizes_cannot_hide_actual_decompression_overflow() {
        let (manifest, mut files) = fixture();
        files[0].1 = vec![b'x'; 100_000];
        let mut bytes = archive(&manifest, &files);
        // Claim the original small size in both ZIP headers while the actual
        // deflate stream expands to 100 KB. The authenticated manifest and
        // metadata sizes agree; the streaming copy must still reject it.
        let name = b"bin/tesseract";
        let central = bytes
            .windows(4)
            .enumerate()
            .find_map(|(index, value)| {
                (value == b"PK\x01\x02"
                    && bytes.get(index + 46..index + 46 + name.len()) == Some(name.as_slice()))
                .then_some(index)
            })
            .unwrap();
        let local =
            u32::from_le_bytes(bytes[central + 42..central + 46].try_into().unwrap()) as usize;
        let length = (manifest.files[0].bytes as u32).to_le_bytes();
        bytes[central + 24..central + 28].copy_from_slice(&length);
        bytes[local + 22..local + 26].copy_from_slice(&length);
        reject_archive(&manifest, &bytes, "超过声明字节数");
    }

    #[test]
    fn verifies_snapshot_and_manifest_before_materializing_payload() {
        let staged = workspace();
        let parent = staged.work.join("installer");
        private_dir(&parent).unwrap();
        let (manifest, files) = fixture();
        let bytes = archive(&manifest, &files);
        let source = staged.work.join("source.zip");
        fs::write(&source, &bytes).unwrap();
        let mut release = descriptor(&manifest, &bytes);
        release.archive_sha256 = "a".repeat(64);
        assert!(prepare(&source, &release, &parent)
            .unwrap_err()
            .message
            .contains("签名"));
        release = descriptor(&manifest, &bytes);
        release.manifest_sha256 = "b".repeat(64);
        assert!(prepare(&source, &release, &parent)
            .unwrap_err()
            .message
            .contains("清单与签名"));
        release = descriptor(&manifest, &bytes);
        release.version = "wrong-version".into();
        assert!(prepare(&source, &release, &parent)
            .unwrap_err()
            .message
            .contains("版本"));
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);

        // The subsequent unpack never reopens a now-replaced source path.
        let mut snapshot = new_file(&staged.work.join("snapshot.zip")).unwrap();
        release = descriptor(&manifest, &bytes);
        snapshot_archive(&source, &release, &mut snapshot).unwrap();
        fs::write(&source, b"replacement").unwrap();
        let payload = staged.work.join("payload");
        private_dir(&payload).unwrap();
        unpack(&mut snapshot, &release, &payload).unwrap();
        assert_eq!(fs::read(payload.join(&files[0].0)).unwrap(), files[0].1);
    }

    #[test]
    fn copy_limits_actual_expansion_and_does_not_write_the_overflow_byte() {
        let mut output = Vec::new();
        assert!(copy_bounded(&mut Cursor::new(b"too long"), &mut output, 3).is_err());
        assert!(output.len() <= 3);
        assert!(copy_bounded(&mut Cursor::new(b"short"), &mut Vec::new(), 6).is_err());
    }

    #[test]
    fn cancellation_at_each_preparation_stage_preserves_source_and_other_jobs() {
        use std::cell::{Cell, RefCell};
        let staged = workspace();
        let parent = staged.work.join("installer");
        private_dir(&parent).unwrap();
        let (mut manifest, mut files) = fixture();
        let mut state = 0x12345678u32;
        files[0].1 = (0..300_000)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state as u8
            })
            .collect();
        manifest.files[0].bytes = files[0].1.len() as u64;
        manifest.files[0].sha256 = hash(&files[0].1);
        let bytes = archive(&manifest, &files);
        assert!(bytes.len() > 64 * 1024);
        let source = staged.work.join("source.zip");
        fs::write(&source, &bytes).unwrap();
        let release = descriptor(&manifest, &bytes);
        let other = prepare(&source, &release, &parent).unwrap();
        for (phase, after_bytes) in [
            (PreparationPhase::CopyingArchive, false),
            (PreparationPhase::CopyingArchive, true),
            (PreparationPhase::InspectingArchive, false),
            (PreparationPhase::ExtractingFiles, false),
            (PreparationPhase::ExtractingFiles, true),
            (PreparationPhase::VerifyingComponents, false),
        ] {
            let cancelled = Cell::new(false);
            let events = RefCell::new(Vec::new());
            let check = || {
                if cancelled.get() {
                    Err(SandboxError::new(FailureCode::Cancelled, "cancel fixture"))
                } else {
                    Ok(())
                }
            };
            let notify = |event: super::super::PreparationProgress| {
                if event.phase == phase && (!after_bytes || event.completed_bytes > 0) {
                    cancelled.set(true);
                }
                events.borrow_mut().push(event);
            };
            let error =
                prepare_observed(&source, &release, &parent, &Monitor::new(&check, &notify))
                    .unwrap_err();
            assert_eq!(error.code, FailureCode::Cancelled, "{phase:?}");
            assert!(cancelled.get());
            assert_eq!(
                events.borrow().last().unwrap().phase,
                PreparationPhase::CleaningUp
            );
            if after_bytes {
                let event = *events
                    .borrow()
                    .iter()
                    .find(|event| event.phase == phase && event.completed_bytes > 0)
                    .unwrap();
                assert!(event.completed_bytes <= 64 * 1024);
                assert!(event.completed_bytes < event.total_bytes.unwrap());
            }
            assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
            assert_eq!(fs::read(&source).unwrap(), bytes);
            assert_eq!(
                fs::read(other.root().join(&files[0].0)).unwrap(),
                files[0].1
            );
        }
        other.discard().unwrap();
        assert_eq!(fs::read_dir(parent).unwrap().count(), 0);
    }

    #[test]
    fn late_cancellation_and_deadline_reject_prepared_result_after_final_verification() {
        use std::cell::{Cell, RefCell};
        let staged = workspace();
        let parent = staged.work.join("installer");
        private_dir(&parent).unwrap();
        let (manifest, files) = fixture();
        let bytes = archive(&manifest, &files);
        let source = staged.work.join("source.zip");
        fs::write(&source, &bytes).unwrap();
        for code in [FailureCode::Cancelled, FailureCode::TimedOut] {
            let current = RefCell::new(None::<PathBuf>);
            let verifying = Cell::new(false);
            let check = || {
                if verifying.get()
                    && !current
                        .borrow()
                        .as_ref()
                        .unwrap()
                        .join("archive.zip")
                        .exists()
                {
                    Err(SandboxError::new(
                        code,
                        "stop before accepting prepared result",
                    ))
                } else {
                    Ok(())
                }
            };
            let notify = |event: super::super::PreparationProgress| {
                if event.phase == PreparationPhase::CopyingArchive {
                    *current.borrow_mut() = Some(
                        fs::read_dir(&parent)
                            .unwrap()
                            .next()
                            .unwrap()
                            .unwrap()
                            .path(),
                    );
                }
                if event.phase == PreparationPhase::VerifyingComponents {
                    verifying.set(true);
                }
            };
            let error = prepare_observed(
                &source,
                &descriptor(&manifest, &bytes),
                &parent,
                &Monitor::new(&check, &notify),
            )
            .unwrap_err();
            assert_eq!(error.code, code);
            assert!(verifying.get());
            assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
        }
    }

    #[test]
    fn failed_cleanup_is_not_reported_as_successful_cancellation() {
        use std::cell::{Cell, RefCell};
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return;
        } // Root bypasses this permission fault.
        let staged = workspace();
        let parent = staged.work.join("installer");
        private_dir(&parent).unwrap();
        let (manifest, files) = fixture();
        let bytes = archive(&manifest, &files);
        let source = staged.work.join("source.zip");
        fs::write(&source, &bytes).unwrap();
        let cancelled = Cell::new(false);
        let retained = RefCell::new(None::<PathBuf>);
        let check = || {
            if cancelled.get() {
                Err(SandboxError::new(FailureCode::Cancelled, "cancel fixture"))
            } else {
                Ok(())
            }
        };
        let notify = |event: super::super::PreparationProgress| {
            if event.phase == PreparationPhase::VerifyingComponents {
                cancelled.set(true);
            }
            if event.phase == PreparationPhase::CleaningUp {
                let directory = fs::read_dir(&parent)
                    .unwrap()
                    .next()
                    .unwrap()
                    .unwrap()
                    .path();
                fs::set_permissions(
                    directory.join("payload/bin"),
                    fs::Permissions::from_mode(0o500),
                )
                .unwrap();
                *retained.borrow_mut() = Some(directory);
            }
        };
        let error = prepare_observed(
            &source,
            &descriptor(&manifest, &bytes),
            &parent,
            &Monitor::new(&check, &notify),
        )
        .unwrap_err();
        assert_eq!(error.code, FailureCode::StopFailed);
        let retained = retained.into_inner().unwrap();
        assert!(retained.join("payload/bin/tesseract").is_file());
        assert_eq!(fs::read(&source).unwrap(), bytes);
        fs::set_permissions(
            retained.join("payload/bin"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        fs::remove_dir_all(retained).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_shared_parent_and_source_symlinks_or_fifo_without_waiting() {
        use std::os::unix::{
            ffi::OsStrExt,
            fs::{symlink, PermissionsExt},
        };
        let staged = workspace();
        let parent = staged.work.join("installer");
        private_dir(&parent).unwrap();
        let (manifest, files) = fixture();
        let bytes = archive(&manifest, &files);
        let release = descriptor(&manifest, &bytes);
        let actual = staged.work.join("actual.zip");
        fs::write(&actual, &bytes).unwrap();
        let source = staged.work.join("source.zip");
        symlink(&actual, &source).unwrap();
        assert!(prepare(&source, &release, &parent).is_err());
        let fifo = staged.work.join("fifo");
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(prepare(&fifo, &release, &parent).is_err());
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(prepare(&actual, &release, &parent)
            .unwrap_err()
            .message
            .contains("私有"));
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
    }
}
