//! Backend-owned cooperative cancellation and stage-local preparation progress.
use super::{invalid, SandboxError};
use serde::Serialize;
use std::cell::Cell;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PreparationPhase {
    Authenticating,
    CopyingArchive,
    InspectingArchive,
    ExtractingFiles,
    VerifyingComponents,
    CleaningUp,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparationProgress {
    pub phase: PreparationPhase,
    pub completed_bytes: u64,
    pub total_bytes: Option<u64>,
    pub completed_files: u64,
    pub total_files: Option<u64>,
}

pub(super) struct Monitor<'a> {
    check: &'a dyn Fn() -> Result<(), SandboxError>,
    notify: &'a dyn Fn(PreparationProgress),
    progress: Cell<PreparationProgress>,
}

impl<'a> Monitor<'a> {
    pub(super) fn new(
        check: &'a dyn Fn() -> Result<(), SandboxError>,
        notify: &'a dyn Fn(PreparationProgress),
    ) -> Self {
        Self {
            check,
            notify,
            progress: Cell::new(PreparationProgress {
                phase: PreparationPhase::Authenticating,
                completed_bytes: 0,
                total_bytes: None,
                completed_files: 0,
                total_files: None,
            }),
        }
    }

    pub(super) fn check(&self) -> Result<(), SandboxError> {
        (self.check)()
    }

    pub(super) fn phase(
        &self,
        phase: PreparationPhase,
        total_bytes: Option<u64>,
        total_files: Option<u64>,
    ) -> Result<(), SandboxError> {
        self.check()?;
        self.progress.set(PreparationProgress {
            phase,
            total_bytes,
            total_files,
            completed_bytes: 0,
            completed_files: 0,
        });
        self.publish()
    }

    pub(super) fn bytes(&self, count: u64) -> Result<(), SandboxError> {
        let mut progress = self.progress.get();
        progress.completed_bytes = progress
            .completed_bytes
            .checked_add(count)
            .ok_or_else(|| invalid("组件准备进度超出范围"))?;
        if progress
            .total_bytes
            .is_some_and(|total| progress.completed_bytes > total)
        {
            return Err(invalid("组件准备进度超出声明范围"));
        }
        self.progress.set(progress);
        self.publish()
    }

    pub(super) fn file_finished(&self) -> Result<(), SandboxError> {
        let mut progress = self.progress.get();
        progress.completed_files += 1;
        if progress
            .total_files
            .is_some_and(|total| progress.completed_files > total)
        {
            return Err(invalid("组件准备文件进度超出声明范围"));
        }
        self.progress.set(progress);
        self.publish()
    }

    fn publish(&self) -> Result<(), SandboxError> {
        (self.notify)(self.progress.get());
        // A cancellation requested while observing progress must win before
        // another read/write or acceptance of the prepared result.
        self.check()
    }

    pub(super) fn cleaning_up(&self) {
        let mut progress = self.progress.get();
        progress.phase = PreparationPhase::CleaningUp;
        progress.completed_bytes = 0;
        progress.total_bytes = None;
        progress.completed_files = 0;
        progress.total_files = None;
        self.progress.set(progress);
        // Cleanup is mandatory even after cancellation or a failed check.
        (self.notify)(progress);
    }
}

impl Default for Monitor<'static> {
    fn default() -> Self {
        Self::new(&|| Ok(()), &|_| {})
    }
}
