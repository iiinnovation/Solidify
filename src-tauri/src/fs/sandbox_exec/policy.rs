use super::types::{FailureCode, SandboxError};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Internal parent/worker protocol, not a Tauri command or model input.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessJob {
    pub binary: PathBuf,
    pub args: Vec<String>,
    pub input: PathBuf,
    pub work: PathBuf,
    pub runtime_read: Vec<PathBuf>,
    pub wall_ms: u64,
    pub cpu_seconds: u64,
    pub max_file_bytes: u64,
    pub max_work_bytes: u64,
    pub max_output_bytes: usize,
}

impl ProcessJob {
    pub fn validate(&self) -> Result<(), SandboxError> {
        if self.wall_ms == 0
            || self.wall_ms > 120_000
            || self.cpu_seconds == 0
            || self.cpu_seconds > 60
            || self.max_file_bytes == 0
            || self.max_file_bytes > 128 * 1024 * 1024
            || self.max_work_bytes == 0
            || self.max_work_bytes > 256 * 1024 * 1024
            || self.max_output_bytes == 0
            || self.max_output_bytes > 1024 * 1024
            || self.runtime_read.len() > 256
            || self.args.len() > 100
        {
            return Err(SandboxError::new(
                FailureCode::InvalidInput,
                "隔离进程预算无效",
            ));
        }
        for path in [&self.binary, &self.input, &self.work]
            .into_iter()
            .chain(self.runtime_read.iter())
        {
            if !path.is_absolute() || std::fs::canonicalize(path).ok().as_ref() != Some(path) {
                return Err(SandboxError::new(
                    FailureCode::InvalidInput,
                    "隔离路径必须是已校验的绝对路径",
                ));
            }
        }
        if !self.binary.is_file()
            || !self.input.is_file()
            || !self.work.is_dir()
            || self.input.starts_with(&self.work)
            || self.binary.starts_with(&self.work)
            || self.work.parent().is_none()
            || self.work.components().count() < 4
        {
            return Err(SandboxError::new(
                FailureCode::InvalidInput,
                "输入、运行组件和输出目录必须隔离",
            ));
        }
        Ok(())
    }
}

fn quoted(path: &Path) -> Result<String, SandboxError> {
    let path = path
        .to_str()
        .ok_or_else(|| SandboxError::new(FailureCode::InvalidInput, "路径编码无效"))?;
    if path.chars().any(char::is_control) {
        return Err(SandboxError::new(
            FailureCode::InvalidInput,
            "隔离路径含控制字符",
        ));
    }
    Ok(format!(
        "\"{}\"",
        path.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

/// No fork or general exec grant: Phase A converters run one at a time,
/// supervised outside the sandbox. Thread creation still needs live probing.
pub fn seatbelt_profile(job: &ProcessJob) -> Result<String, SandboxError> {
    job.validate()?;
    let binary = quoted(&job.binary)?;
    let input = quoted(&job.input)?;
    let work = quoted(&job.work)?;
    let mut profile = format!(
        "(version 1)\n(deny default)\n\
         (import \"/System/Library/Sandbox/Profiles/dyld-support.sb\")\n\
         (allow syscall*)\n(allow sysctl-read)\n\
         (allow file-read* file-map-executable (subpath \"/usr/lib\") (subpath \"/System/Library\"))\n\
         (allow process-exec (literal {binary}))\n\
         (allow file-read* file-map-executable (literal {binary}))\n\
         (allow file-read* (literal {input}))\n\
         (allow file-read* file-write-data file-write-create file-write-unlink (subpath {work}))\n\
         (allow file-read* (literal \"/dev/urandom\") (literal \"/dev/random\") (literal \"/dev/zero\"))\n\
         (allow file-read* file-write* (literal \"/dev/null\"))\n"
    );
    for path in &job.runtime_read {
        let matcher = if path.is_dir() { "subpath" } else { "literal" };
        profile.push_str(&format!(
            "(allow file-read* file-map-executable ({matcher} {}))\n",
            quoted(path)?
        ));
    }
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_cannot_inject_profile_rules() {
        let text = quoted(Path::new("/tmp/\"(allow default)\\")).unwrap();
        assert_eq!(text, "\"/tmp/\\\"(allow default)\\\\\"");
        assert!(quoted(Path::new("/tmp/line\nbreak")).is_err());
    }
}
