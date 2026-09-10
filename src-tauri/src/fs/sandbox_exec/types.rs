use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtractMethod {
    ImageOcr,
    PdfOcr,
}

impl ExtractMethod {
    pub fn accepts_extension(self, extension: &str) -> bool {
        match self {
            Self::ImageOcr => matches!(
                extension.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg"
            ),
            Self::PdfOcr => extension.eq_ignore_ascii_case("pdf"),
        }
    }
}

/// Stable error codes cross IPC; OS details and stderr are kept out of general logs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    PlatformUnavailable,
    DependencyMissing,
    DependencyInvalid,
    IsolationUnavailable,
    InvalidInput,
    SnapshotChanged,
    LeaseInvalid,
    ExecutionBusy,
    RepeatLimit,
    Cancelled,
    TimedOut,
    OutputLimit,
    WorkspaceLimit,
    PageLimit,
    PixelLimit,
    Encrypted,
    RenderFailed,
    OcrFailed,
    StopFailed,
    Io,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SandboxError {
    pub code: FailureCode,
    pub message: String,
}

impl SandboxError {
    pub fn new(code: FailureCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for SandboxError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for SandboxError {}

/// Constructed by trusted Rust code; never deserialized from model arguments.
#[derive(Debug, Clone)]
pub struct ExecutionLimits {
    pub wall: Duration,
    pub max_input_bytes: u64,
    pub max_output_bytes: usize,
    pub max_characters: usize,
    pub max_work_bytes: u64,
    pub max_file_bytes: u64,
    pub max_pages: u32,
    pub max_page_pixels: u64,
    pub cpu_seconds: u64,
}

impl Default for ExecutionLimits {
    fn default() -> Self {
        Self {
            wall: Duration::from_secs(120),
            max_input_bytes: 25 * 1024 * 1024,
            max_output_bytes: 1024 * 1024,
            max_characters: 1024 * 1024,
            max_work_bytes: 256 * 1024 * 1024,
            max_file_bytes: 128 * 1024 * 1024,
            max_pages: 20,
            max_page_pixels: 20_000_000,
            cpu_seconds: 60,
        }
    }
}

impl ExecutionLimits {
    /// Resource knobs in the confirmed plan may tighten, never enlarge, these caps.
    pub fn for_plan(max_pdf_pages: u32, max_characters: usize) -> Result<Self, SandboxError> {
        if max_pdf_pages == 0 || max_characters == 0 {
            return Err(SandboxError::new(
                FailureCode::InvalidInput,
                "解析预算必须大于零",
            ));
        }
        let mut limits = Self::default();
        limits.max_pages = limits.max_pages.min(max_pdf_pages);
        limits.max_characters = limits.max_characters.min(max_characters);
        // UTF-8 bytes are independently bounded. Character count is enforced
        // by the extraction pipeline; multiplying is saturating, not wrapping.
        limits.max_output_bytes = limits
            .max_output_bytes
            .min(max_characters.saturating_mul(4));
        Ok(limits)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedPage {
    pub page: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedDocument {
    pub execution_id: String,
    pub relative_path: String,
    pub source_hash: String,
    pub method: ExtractMethod,
    pub parser_version: String,
    pub language_versions: Vec<String>,
    pub pages: Vec<ExtractedPage>,
    pub complete: bool,
    pub warnings: Vec<String>,
    pub duration_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_budgets_can_only_tighten_platform_caps() {
        let tight = ExecutionLimits::for_plan(2, 100).unwrap();
        assert_eq!(tight.max_pages, 2);
        assert_eq!(tight.max_output_bytes, 400);
        let generous = ExecutionLimits::for_plan(u32::MAX, usize::MAX).unwrap();
        assert_eq!(generous.max_pages, 20);
        assert_eq!(generous.max_output_bytes, 1024 * 1024);
        assert!(ExecutionLimits::for_plan(0, 100).is_err());
    }

    #[test]
    fn method_enum_does_not_accept_commands_or_future_formats() {
        assert!(serde_json::from_str::<ExtractMethod>("\"office\"").is_err());
        assert!(serde_json::from_str::<ExtractMethod>("\"pdf_ocr; echo unsafe\"").is_err());
        assert!(!ExtractMethod::ImageOcr.accepts_extension("doc"));
        assert!(ExtractMethod::ImageOcr.accepts_extension("JPEG"));
    }
}
