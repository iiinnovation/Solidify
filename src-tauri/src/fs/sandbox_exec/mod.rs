//! Process isolation below the FolderTask tool boundary.
//!
//! This module never grants a task lease. Callers must obtain the authorized
//! snapshot from FolderTask and revalidate it before accepting an outcome.
//! Platform execution is enabled only after its provider probe succeeds.

pub mod components;
pub(crate) mod package;
pub(crate) mod installation;
pub mod execution;
pub mod ocr;
pub mod pdf;
pub mod policy;
pub mod results;
pub mod runtime;
pub mod staging;
pub mod supervisor;
pub mod types;
pub mod worker;
#[cfg(unix)]
mod task_lock;

#[cfg(all(test, target_os = "macos"))]
mod live_ocr_tests;
