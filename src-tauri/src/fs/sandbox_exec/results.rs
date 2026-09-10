//! Complete-or-error text assembly. A failed/omitted page is never silently
//! promoted to a complete document. Raw converter stderr is not provenance.
use super::types::{ExecutionLimits, ExtractedDocument, ExtractedPage, FailureCode, SandboxError};

pub struct PageCollector {
    expected_pages: u32,
    limits: ExecutionLimits,
    pages: Vec<ExtractedPage>,
    bytes: usize,
    characters: usize,
    failure: Option<SandboxError>,
}

impl PageCollector {
    pub fn new(expected_pages: u32, limits: ExecutionLimits) -> Result<Self, SandboxError> {
        if expected_pages == 0 || expected_pages > limits.max_pages {
            return Err(SandboxError::new(
                FailureCode::PageLimit,
                "文档页数为零或超过已确认预算",
            ));
        }
        Ok(Self {
            expected_pages,
            limits,
            pages: vec![],
            bytes: 0,
            characters: 0,
            failure: None,
        })
    }

    pub fn push(&mut self, page: u32, text: Vec<u8>) -> Result<(), SandboxError> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        let result = self.push_inner(page, text);
        if let Err(error) = &result {
            self.failure = Some(error.clone());
        }
        result
    }

    fn push_inner(&mut self, page: u32, text: Vec<u8>) -> Result<(), SandboxError> {
        if page != self.pages.len() as u32 + 1 || page > self.expected_pages {
            return Err(SandboxError::new(
                FailureCode::OcrFailed,
                "OCR 结果页码缺失、重复或顺序不一致",
            ));
        }
        let bytes = self.bytes.saturating_add(text.len());
        if bytes > self.limits.max_output_bytes {
            return Err(SandboxError::new(
                FailureCode::OutputLimit,
                "OCR 合计文本超过字节预算",
            ));
        }
        let text = String::from_utf8(text)
            .map_err(|_| SandboxError::new(FailureCode::OcrFailed, "OCR 返回无效 UTF-8 文本"))?;
        let characters = self.characters.saturating_add(text.chars().count());
        if characters > self.limits.max_characters {
            return Err(SandboxError::new(
                FailureCode::OutputLimit,
                "OCR 合计文本超过计划字符预算",
            ));
        }
        self.bytes = bytes;
        self.characters = characters;
        self.pages.push(ExtractedPage { page, text });
        Ok(())
    }

    /// Caller supplies backend-derived provenance only, and must revalidate
    /// the lease before accepting this document. Complete means all pages were
    /// processed, not that OCR is semantically accurate.
    pub fn finish(
        self,
        mut document: ExtractedDocument,
    ) -> Result<ExtractedDocument, SandboxError> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if self.pages.len() != self.expected_pages as usize {
            return Err(SandboxError::new(
                FailureCode::OcrFailed,
                "OCR 未返回全部页面，不接受不完整结果",
            ));
        }
        document
            .warnings
            .push("OCR 文本可能存在识别误差，请结合原文审阅".into());
        for page in &self.pages {
            if page.text.trim().is_empty() {
                document.warnings.push(format!(
                    "第 {} 页未识别到文本，可能为空白或无法识别",
                    page.page
                ));
            }
        }
        document.pages = self.pages;
        document.complete = true;
        Ok(document)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::sandbox_exec::types::ExtractMethod;

    fn provenance() -> ExtractedDocument {
        ExtractedDocument {
            execution_id: "test".into(),
            relative_path: "test.pdf".into(),
            source_hash: "test".into(),
            method: ExtractMethod::PdfOcr,
            parser_version: "fixture".into(),
            language_versions: vec!["fixture".into()],
            pages: vec![],
            complete: false,
            warnings: vec![],
            duration_ms: 1,
        }
    }

    #[test]
    fn missing_duplicate_and_failed_pages_cannot_be_completed() {
        let mut missing = PageCollector::new(2, ExecutionLimits::default()).unwrap();
        missing.push(1, b"first".to_vec()).unwrap();
        assert!(missing.finish(provenance()).is_err());
        let mut duplicate = PageCollector::new(1, ExecutionLimits::default()).unwrap();
        duplicate.push(1, b"first".to_vec()).unwrap();
        assert!(duplicate.push(1, b"again".to_vec()).is_err());
        assert!(duplicate.finish(provenance()).is_err());
        let mut invalid = PageCollector::new(1, ExecutionLimits::default()).unwrap();
        assert!(invalid.push(1, vec![0xff]).is_err());
        assert!(invalid.push(1, b"retry".to_vec()).is_err());
        assert!(invalid.finish(provenance()).is_err());
    }

    #[test]
    fn limits_apply_to_all_pages_and_unicode_characters() {
        let mut result = PageCollector::new(2, ExecutionLimits::for_plan(2, 3).unwrap()).unwrap();
        result.push(1, "中文".as_bytes().to_vec()).unwrap();
        assert_eq!(
            result.push(2, b"ab".to_vec()).unwrap_err().code,
            FailureCode::OutputLimit
        );
        let mut limits = ExecutionLimits::default();
        limits.max_output_bytes = 5;
        let mut result = PageCollector::new(2, limits).unwrap();
        result.push(1, b"abc".to_vec()).unwrap();
        assert_eq!(
            result.push(2, b"def".to_vec()).unwrap_err().code,
            FailureCode::OutputLimit
        );
    }

    #[test]
    fn preserves_provenance_and_marks_empty_page_warning() {
        let mut result = PageCollector::new(2, ExecutionLimits::default()).unwrap();
        result.push(1, "中文 English".as_bytes().to_vec()).unwrap();
        result.push(2, b" \n".to_vec()).unwrap();
        let document = result.finish(provenance()).unwrap();
        assert!(document.complete);
        assert_eq!(document.pages.len(), 2);
        assert_eq!(document.source_hash, "test");
        assert_eq!(document.warnings.len(), 2);
        assert!(document.warnings[1].contains('2'));
        assert!(PageCollector::new(21, ExecutionLimits::default()).is_err());
    }
}
