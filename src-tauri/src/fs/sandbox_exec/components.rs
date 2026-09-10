//! Trusted installer manifest validation. This is not an IPC/model input.
//! A matching digest establishes consistency with a trusted manifest, not the
//! authenticity of a package: signature verification belongs to the installer.
use super::types::{ExtractMethod, FailureCode, SandboxError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const MAX_FILES: usize = 240;
const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;

pub(super) mod traineddata;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComponentFile {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComponentManifest {
    pub schema_version: u32,
    pub platform: String,
    pub architecture: String,
    pub package_version: String,
    pub tesseract: String,
    pub tesseract_version: String,
    pub pdfinfo: Option<String>,
    pub pdftoppm: Option<String>,
    pub poppler_version: Option<String>,
    pub tessdata_dir: String,
    pub language_versions: BTreeMap<String, String>,
    // Every executable, library and data file exposed to the converter must be
    // enumerated here; no directory-wide runtime grants are derived from PATH.
    pub files: Vec<ComponentFile>,
}

#[derive(Debug)]
pub struct VerifiedComponents {
    root: PathBuf,
    manifest: ComponentManifest,
    required_languages: Vec<String>,
}

fn invalid(message: &str) -> SandboxError {
    SandboxError::new(FailureCode::DependencyInvalid, message)
}

fn relative_path(value: &str) -> Result<&Path, SandboxError> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains('\\')
        || value.chars().any(char::is_control)
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || path.to_str() != Some(value)
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(invalid("组件清单包含无效相对路径"));
    }
    Ok(path)
}

fn checked_path(root: &Path, relative: &str) -> Result<PathBuf, SandboxError> {
    let mut path = root.to_path_buf();
    for part in relative_path(relative)?.components() {
        path.push(part.as_os_str());
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| SandboxError::new(FailureCode::DependencyMissing, "组件文件缺失"))?;
        if metadata.file_type().is_symlink() {
            return Err(invalid("组件路径不允许符号链接"));
        }
    }
    if fs::canonicalize(&path).ok().as_ref() != Some(&path) {
        return Err(invalid("组件路径不再对应已验证的安装目录"));
    }
    Ok(path)
}

impl VerifiedComponents {
    /// Must be called only with an installer-owned, authenticated manifest.
    /// Local development may explicitly supply a pinned manifest; that does
    /// not promote the package to a signed production component.
    pub fn verify(root: &Path, manifest: ComponentManifest) -> Result<Self, SandboxError> {
        Self::verify_with_check(root, manifest, || Ok(()))
    }

    pub(crate) fn verify_with_check(
        root: &Path,
        manifest: ComponentManifest,
        check: impl Fn() -> Result<(), SandboxError>,
    ) -> Result<Self, SandboxError> {
        check()?;
        if !root.is_absolute()
            || fs::canonicalize(root).ok().as_deref() != Some(root)
            || !root.is_dir()
        {
            return Err(invalid("组件根目录必须是规范化的独立安装目录"));
        }
        if manifest.schema_version != 1
            || manifest.platform != std::env::consts::OS
            || manifest.architecture != std::env::consts::ARCH
            || manifest.package_version.trim().is_empty()
            || manifest.tesseract_version.trim().is_empty()
            || manifest.files.is_empty()
            || manifest.files.len() > MAX_FILES
        {
            return Err(invalid("组件版本、平台或清单范围无效"));
        }
        let mut listed = BTreeSet::new();
        let mut total = 0u64;
        for entry in &manifest.files {
            relative_path(&entry.path)?;
            if !listed.insert(entry.path.as_str())
                || entry.sha256.len() != 64
                || !entry
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(invalid("组件清单存在重复文件或无效哈希"));
            }
            total = total
                .checked_add(entry.bytes)
                .ok_or_else(|| invalid("组件体积超限"))?;
            if total > MAX_PACKAGE_BYTES {
                return Err(invalid("组件体积超限"));
            }
        }
        let mut binaries = vec![manifest.tesseract.as_str()];
        match (
            &manifest.pdfinfo,
            &manifest.pdftoppm,
            &manifest.poppler_version,
        ) {
            (Some(info), Some(render), Some(version)) if !version.trim().is_empty() => {
                binaries.extend([info.as_str(), render.as_str()]);
            }
            (None, None, None) => {}
            _ => return Err(invalid("PDF 组件必须同时包含探测器、渲染器及版本")),
        }
        for binary in &binaries {
            if !listed.contains(binary) {
                return Err(invalid("转换程序未列入完整性清单"));
            }
        }
        relative_path(&manifest.tessdata_dir)?;
        for language in ["chi_sim", "eng"] {
            if manifest
                .language_versions
                .get(language)
                .map_or(true, |version| version.trim().is_empty())
                || !listed
                    .contains(format!("{}/{language}.traineddata", manifest.tessdata_dir).as_str())
            {
                return Err(SandboxError::new(
                    FailureCode::DependencyMissing,
                    "缺少简体中文或英文 OCR 语言包",
                ));
            }
        }
        let mut model_paths = BTreeMap::new();
        for (language, version) in &manifest.language_versions {
            if !traineddata::language_name(language) || version.trim().is_empty() {
                return Err(invalid("OCR 语言名称或来源版本无效"));
            }
            let path = format!("{}/{language}.traineddata", manifest.tessdata_dir);
            if !listed.contains(path.as_str()) {
                return Err(SandboxError::new(
                    FailureCode::DependencyMissing,
                    "语言来源没有对应的模型文件",
                ));
            }
            model_paths.insert(path, language.clone());
        }
        let mut dependencies = BTreeMap::new();
        for entry in &manifest.files {
            check()?;
            let path = checked_path(root, &entry.path)?;
            if !fs::symlink_metadata(&path)
                .map(|metadata| metadata.is_file())
                .unwrap_or(false)
            {
                return Err(invalid("组件必须是普通文件"));
            }
            let mut options = fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                // A raced-in FIFO must not block the trusted verifier before
                // descriptor metadata can reject it. Regular files ignore
                // O_NONBLOCK; the installer must still prevent replacements.
                options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
            }
            let mut file = options.open(&path).map_err(|_| invalid("组件文件不可读"))?;
            let metadata = file.metadata().map_err(|_| invalid("组件文件不可检查"))?;
            if !metadata.is_file() || metadata.len() != entry.bytes {
                return Err(invalid("组件文件类型或大小与清单不符"));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if binaries.contains(&entry.path.as_str())
                    && metadata.permissions().mode() & 0o111 == 0
                {
                    return Err(invalid("组件转换程序不可执行"));
                }
            }
            if digest(&mut file, entry.bytes, &check)? != entry.sha256 {
                return Err(invalid("组件完整性校验失败"));
            }
            if let Some(language) = model_paths.get(&entry.path) {
                dependencies.insert(
                    language.clone(),
                    traineddata::dependencies(&mut file, entry.bytes)?,
                );
            } else if entry.path.ends_with(".traineddata") {
                return Err(invalid("模型文件未登记语言来源"));
            }
            checked_path(root, &entry.path)?;
        }
        // Resolve the transitive dependency closure from the fixed -l argument.
        // A visited set also terminates legitimate cyclic sublanguage configs.
        let mut required_languages = vec!["chi_sim".to_string(), "eng".to_string()];
        let mut visited: BTreeSet<_> = required_languages.iter().cloned().collect();
        let mut index = 0;
        while index < required_languages.len() {
            let language = &required_languages[index];
            let children = dependencies.get(language).ok_or_else(|| {
                SandboxError::new(
                    FailureCode::DependencyMissing,
                    "缺少模型隐式依赖的语言包及来源",
                )
            })?;
            for child in children {
                if visited.insert(child.clone()) {
                    required_languages.push(child.clone());
                }
            }
            index += 1;
        }
        check()?;
        Ok(Self {
            root: root.into(),
            manifest,
            required_languages,
        })
    }

    pub fn supports(&self, method: ExtractMethod) -> bool {
        method == ExtractMethod::ImageOcr || self.manifest.pdfinfo.is_some()
    }

    /// Call before constructing a process job; replacing/removing an installed
    /// component invalidates the previous capability projection.
    pub fn revalidate(&self) -> Result<(), SandboxError> {
        Self::verify(&self.root, self.manifest.clone()).map(|_| ())
    }

    pub fn runtime_files(&self) -> Vec<PathBuf> {
        self.manifest
            .files
            .iter()
            .map(|entry| self.root.join(&entry.path))
            .collect()
    }

    pub fn tesseract(&self) -> PathBuf {
        self.root.join(&self.manifest.tesseract)
    }
    pub fn pdf_tools(&self) -> Result<(PathBuf, PathBuf, &str), SandboxError> {
        match (
            &self.manifest.pdfinfo,
            &self.manifest.pdftoppm,
            &self.manifest.poppler_version,
        ) {
            (Some(info), Some(render), Some(version)) => {
                Ok((self.root.join(info), self.root.join(render), version))
            }
            _ => Err(SandboxError::new(
                FailureCode::DependencyMissing,
                "PDF 探测器或渲染器未安装",
            )),
        }
    }
    pub fn tessdata(&self) -> PathBuf {
        self.root.join(&self.manifest.tessdata_dir)
    }
    pub fn parser_version(&self) -> &str {
        &self.manifest.tesseract_version
    }
    pub fn language_versions(&self) -> Vec<String> {
        self.required_languages
            .iter()
            .map(|language| format!("{language}:{}", self.manifest.language_versions[language]))
            .collect()
    }
}

fn digest(
    file: &mut File,
    expected_bytes: u64,
    check: &dyn Fn() -> Result<(), SandboxError>,
) -> Result<String, SandboxError> {
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        check()?;
        let count = file
            .read(&mut buffer)
            .map_err(|_| invalid("组件读取失败"))?;
        if count == 0 {
            break;
        }
        total = total.saturating_add(count as u64);
        if total > expected_bytes {
            return Err(invalid("组件在校验期间发生变化"));
        }
        hash.update(&buffer[..count]);
    }
    if total != expected_bytes {
        return Err(invalid("组件在校验期间发生变化"));
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::fs::sandbox_exec::staging::StagingRoot;

    pub(crate) fn fixture(root: &Path) -> ComponentManifest {
        fs::create_dir(root.join("data")).unwrap();
        let files = [
            "tesseract",
            "data/chi_sim.traineddata",
            "data/eng.traineddata",
        ]
        .into_iter()
        .map(|path| {
            let data = if path.ends_with(".traineddata") {
                traineddata::fixture("")
            } else {
                b"test".to_vec()
            };
            fs::write(root.join(path), &data).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(root.join(path), fs::Permissions::from_mode(0o700)).unwrap();
            }
            ComponentFile {
                path: path.into(),
                sha256: format!("{:x}", Sha256::digest(&data)),
                bytes: data.len() as u64,
            }
        })
        .collect();
        ComponentManifest {
            schema_version: 1,
            platform: std::env::consts::OS.into(),
            architecture: std::env::consts::ARCH.into(),
            package_version: "fixture".into(),
            tesseract: "tesseract".into(),
            tesseract_version: "fixture".into(),
            pdfinfo: None,
            pdftoppm: None,
            poppler_version: None,
            tessdata_dir: "data".into(),
            language_versions: [
                ("chi_sim".into(), "fixture".into()),
                ("eng".into(), "fixture".into()),
            ]
            .into(),
            files,
        }
    }

    #[test]
    fn rejects_unsafe_manifest_paths() {
        for path in [
            "",
            "/tmp/file",
            "../file",
            "a/../b",
            "a//b",
            "./a",
            "a/",
            "a\\b",
            "a\nb",
        ] {
            assert!(relative_path(path).is_err(), "{path:?}");
        }
        assert!(relative_path("lib/libexample.dylib").is_ok());
    }

    #[test]
    fn validates_pinned_files_and_invalidates_changes() {
        let owner = StagingRoot::create().unwrap();
        let staged = owner
            .stage(b"x", &format!("{:x}", Sha256::digest(b"x")), "png", 1)
            .unwrap();
        let manifest = fixture(&staged.work);
        let verified = VerifiedComponents::verify(&staged.work, manifest.clone()).unwrap();
        assert!(verified.supports(ExtractMethod::ImageOcr));
        assert!(!verified.supports(ExtractMethod::PdfOcr));
        assert_eq!(verified.runtime_files().len(), 3);
        fs::write(staged.work.join("tesseract"), b"evil").unwrap();
        assert_eq!(
            verified.revalidate().unwrap_err().code,
            FailureCode::DependencyInvalid
        );
        let mut missing = manifest;
        missing.language_versions.remove("eng");
        assert_eq!(
            VerifiedComponents::verify(&staged.work, missing)
                .unwrap_err()
                .code,
            FailureCode::DependencyMissing
        );
    }

    #[test]
    fn component_hash_check_stops_before_reading_the_rest_of_a_large_file() {
        use std::io::{Seek, SeekFrom};
        let owner = StagingRoot::create().unwrap();
        let bytes = vec![b'x'; 200_000];
        let staged = owner
            .stage(
                &bytes,
                &format!("{:x}", Sha256::digest(&bytes)),
                "png",
                200_000,
            )
            .unwrap();
        let mut file = File::open(&staged.input).unwrap();
        let observer = std::cell::RefCell::new(file.try_clone().unwrap());
        let check = || {
            if observer.borrow_mut().stream_position().unwrap() >= 64 * 1024 {
                Err(SandboxError::new(
                    FailureCode::Cancelled,
                    "cancel while hashing",
                ))
            } else {
                Ok(())
            }
        };
        assert_eq!(
            digest(&mut file, bytes.len() as u64, &check)
                .unwrap_err()
                .code,
            FailureCode::Cancelled
        );
        assert_eq!(file.stream_position().unwrap(), 64 * 1024);
        file.seek(SeekFrom::Start(0)).unwrap();
        assert_eq!(
            digest(&mut file, bytes.len() as u64, &|| Ok(())).unwrap(),
            staged.source_hash
        );
    }

    #[test]
    fn requires_transitive_model_dependencies_and_records_their_sources() {
        let owner = StagingRoot::create().unwrap();
        let staged = owner
            .stage(b"x", &format!("{:x}", Sha256::digest(b"x")), "png", 1)
            .unwrap();
        let mut manifest = fixture(&staged.work);
        let set_model = |manifest: &mut ComponentManifest, language: &str, config: &str| {
            let path = format!("data/{language}.traineddata");
            let data = traineddata::fixture(config);
            fs::write(staged.work.join(&path), &data).unwrap();
            manifest.files.retain(|file| file.path != path);
            manifest.files.push(ComponentFile {
                path,
                bytes: data.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&data)),
            });
            manifest.language_versions.insert(
                language.into(),
                format!("sha256:{:x}", Sha256::digest(&data)),
            );
        };
        set_model(
            &mut manifest,
            "chi_sim",
            "tessedit_load_sublangs chi_sim_vert\n",
        );
        assert_eq!(
            VerifiedComponents::verify(&staged.work, manifest.clone())
                .unwrap_err()
                .code,
            FailureCode::DependencyMissing
        );
        set_model(
            &mut manifest,
            "chi_sim_vert",
            "tessedit_load_sublangs other\n",
        );
        assert!(VerifiedComponents::verify(&staged.work, manifest.clone()).is_err());
        set_model(&mut manifest, "other", "tessedit_load_sublangs chi_sim\n");
        let verified = VerifiedComponents::verify(&staged.work, manifest.clone()).unwrap();
        assert_eq!(
            verified.required_languages,
            ["chi_sim", "eng", "chi_sim_vert", "other"]
        );
        assert!(verified.language_versions()[2].starts_with("chi_sim_vert:sha256:"));
        let mut unlisted = manifest.clone();
        unlisted.language_versions.remove("chi_sim_vert");
        assert!(VerifiedComponents::verify(&staged.work, unlisted).is_err());
        fs::write(staged.work.join("data/other.traineddata"), b"tampered").unwrap();
        assert_eq!(
            verified.revalidate().unwrap_err().code,
            FailureCode::DependencyInvalid
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_duplicate_files_and_incomplete_pdf_bundle() {
        let owner = StagingRoot::create().unwrap();
        let staged = owner
            .stage(b"x", &format!("{:x}", Sha256::digest(b"x")), "png", 1)
            .unwrap();
        let manifest = fixture(&staged.work);
        let mut duplicate = manifest.clone();
        duplicate.files.push(duplicate.files[0].clone());
        assert!(VerifiedComponents::verify(&staged.work, duplicate).is_err());
        let mut pdf = manifest.clone();
        pdf.pdfinfo = Some("tesseract".into());
        assert!(VerifiedComponents::verify(&staged.work, pdf).is_err());
        fs::rename(staged.work.join("data"), staged.work.join("actual-data")).unwrap();
        std::os::unix::fs::symlink(staged.work.join("actual-data"), staged.work.join("data"))
            .unwrap();
        assert!(VerifiedComponents::verify(&staged.work, manifest).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_special_files_without_waiting_for_a_writer() {
        use std::os::unix::ffi::OsStrExt;
        let owner = StagingRoot::create().unwrap();
        let staged = owner
            .stage(b"x", &format!("{:x}", Sha256::digest(b"x")), "png", 1)
            .unwrap();
        let mut manifest = fixture(&staged.work);
        let path = staged.work.join("pipe");
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        manifest.files.push(ComponentFile {
            path: "pipe".into(),
            bytes: 0,
            sha256: format!("{:x}", Sha256::digest(b"")),
        });
        assert_eq!(
            VerifiedComponents::verify(&staged.work, manifest)
                .unwrap_err()
                .code,
            FailureCode::DependencyInvalid
        );
    }
}
