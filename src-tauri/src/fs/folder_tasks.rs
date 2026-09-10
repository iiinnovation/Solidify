use super::sandbox::resolve_in_workspace;
use ignore::gitignore::GitignoreBuilder;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::fs::File;
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;
use zip::write::SimpleFileOptions;

pub(super) mod extraction;
mod retry;
mod shutdown;

#[tauri::command]
pub async fn sandbox_extract_text(
    app: AppHandle, manager: State<'_, FolderTaskManager>,
    runtime: State<'_, super::sandbox_exec::runtime::SandboxRuntime>,
    task_id: String, run_id: String, batch_token: String, call_id: String,
    relative_path: String, method: super::sandbox_exec::types::ExtractMethod,
) -> Result<super::sandbox_exec::types::ExtractedDocument, super::sandbox_exec::types::SandboxError> {
    use super::sandbox_exec::types::{FailureCode, SandboxError};
    let components = runtime.components(method)?;
    let staging = runtime.staging()?;
    let worker = std::env::current_exe().map_err(|_| SandboxError::new(FailureCode::IsolationUnavailable, "无法定位监督进程"))?;
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let request = extraction::ExtractionRequest { task_id: &task_id, run_id: &run_id, batch_token: &batch_token,
            call_id: &call_id, relative_path: &relative_path, method };
        extraction::extract(&manager, &components, &staging, &worker, &request, || {
            let _ = app.emit("folder-task-execution-stopping", json!({ "taskId": task_id, "delayed": true }));
        })
    }).await.map_err(|_| SandboxError::new(FailureCode::StopFailed, "转换后台任务异常结束"))?
}

#[tauri::command]
pub fn sandbox_cancel_execution(
    manager: State<'_, FolderTaskManager>, task_id: String, run_id: String, batch_token: String,
    call_id: String, relative_path: String, method: super::sandbox_exec::types::ExtractMethod,
) -> Result<(), super::sandbox_exec::types::SandboxError> {
    extraction::cancel(&manager, &extraction::ExtractionRequest { task_id: &task_id, run_id: &run_id,
        batch_token: &batch_token, call_id: &call_id, relative_path: &relative_path, method })
}

#[tauri::command]
pub fn sandbox_capabilities(runtime: State<'_, super::sandbox_exec::runtime::SandboxRuntime>) -> Vec<super::sandbox_exec::runtime::MethodCapability> {
    runtime.capabilities()
}

#[tauri::command]
pub fn sandbox_execution_progress(
    manager: State<'_, FolderTaskManager>, task_id: String,
) -> Result<Vec<super::sandbox_exec::execution::DocumentProgress>, String> {
    validate_id(&task_id)?;
    manager.executions.document_progress(&task_id).map_err(|error| error.to_string())
}

const SCHEMA_VERSION: i64 = 9;
const DEFAULT_BATCH_SIZE: u32 = 8;
const MAX_BATCH_SIZE: u32 = 20;
const MAX_MODEL_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_SCAN_FILES: usize = 10_000;
const MAX_SCAN_ENTRIES: usize = 20_000;
const MAX_SCAN_DEPTH: usize = 32;
const MAX_SCAN_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_SCAN_SINGLE_FILE_BYTES: u64 = MAX_MODEL_FILE_BYTES;
const BATCH_LEASE_MS: i64 = 15 * 60 * 1000;
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub struct FolderTaskManager {
    instance_id: String,
    database_path: PathBuf,
    executions: super::sandbox_exec::execution::ExecutionManager,
}

impl FolderTaskManager {
    pub(crate) fn execution_manager(&self) -> super::sandbox_exec::execution::ExecutionManager {
        self.executions.clone()
    }
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Unable to locate app data directory: {error}"))?;
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Unable to create app data directory: {error}"))?;
        let manager = Self {
            instance_id: Uuid::new_v4().to_string(),
            database_path: directory.join("folder-tasks.sqlite3"),
            executions: super::sandbox_exec::execution::ExecutionManager::for_database(&directory.join("folder-tasks.sqlite3")).map_err(|error| error.to_string())?,
        };
        manager.connection()?;
        Ok(manager)
    }

    #[cfg(test)]
    fn for_test(database_path: PathBuf) -> Result<Self, String> {
        let executions = super::sandbox_exec::execution::ExecutionManager::for_database(&database_path).map_err(|error| error.to_string())?;
        let manager = Self { database_path, executions, instance_id: Uuid::new_v4().to_string() };
        manager.connection()?;
        Ok(manager)
    }

    fn connection(&self) -> Result<Connection, String> {
        let connection = Connection::open(&self.database_path)
            .map_err(|error| format!("Unable to open folder task database: {error}"))?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|error| error.to_string())?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| error.to_string())?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| error.to_string())?;
        migrate(&connection)?;
        Ok(connection)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FolderTaskStatus {
    AwaitingPlanConfirmation,
    Running,
    Paused,
    AwaitingDecision,
    Reviewing,
    Completed,
    Failed,
    Cancelled,
}

impl FolderTaskStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::AwaitingPlanConfirmation => "awaiting_plan_confirmation",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::AwaitingDecision => "awaiting_decision",
            Self::Reviewing => "reviewing",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "awaiting_plan_confirmation" => Ok(Self::AwaitingPlanConfirmation),
            "running" => Ok(Self::Running),
            "paused" => Ok(Self::Paused),
            "awaiting_decision" => Ok(Self::AwaitingDecision),
            "reviewing" => Ok(Self::Reviewing),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(format!("Unknown folder task status: {value}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTaskPlan {
    #[serde(default = "current_plan_schema_version")]
    pub schema_version: u32,
    pub recipe: String,
    #[serde(default)]
    pub recipe_plan: Value,
    pub batch_size: u32,
    #[serde(default = "default_completion_policy", alias = "outputMode")]
    pub completion_policy: String,
    #[serde(default = "default_snapshot_mode", alias = "baselineMode")]
    pub snapshot_mode: String,
    pub review_policy: String,
    pub include_extensions: Vec<String>,
    pub exclusions: Vec<String>,
    #[serde(default)]
    pub resource_limits: FolderTaskResourceLimits,
    #[serde(default)]
    pub output: FolderTaskOutputPlan,
}

fn current_plan_schema_version() -> u32 {
    3
}
fn default_completion_policy() -> String {
    "review_required".into()
}
fn default_snapshot_mode() -> String {
    "use_scanned_snapshot".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTaskResourceLimits {
    pub max_batch_bytes: u64,
    pub max_batch_estimated_characters: u64,
    pub max_parsed_characters_per_file: u64,
    pub max_pdf_pages: u32,
    pub max_archive_entries: u32,
    pub max_expanded_bytes: u64,
}

impl Default for FolderTaskResourceLimits {
    fn default() -> Self {
        Self {
            max_batch_bytes: 40 * 1024 * 1024,
            max_batch_estimated_characters: 80_000,
            max_parsed_characters_per_file: 200_000,
            max_pdf_pages: 100,
            max_archive_entries: 2_000,
            max_expanded_bytes: 128 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTaskOutputPlan {
    pub format: String,
    pub relative_path: String,
    pub overwrite: bool,
    pub auto_write: bool,
}

impl Default for FolderTaskOutputPlan {
    fn default() -> Self {
        Self {
            format: "json".into(),
            relative_path: ".solidify/outputs/folder-task-results.json".into(),
            overwrite: false,
            auto_write: false,
        }
    }
}

impl FolderTaskPlan {
    fn normalize_legacy(&mut self, goal: &str) -> Result<(), String> {
        if self.schema_version > current_plan_schema_version() {
            return Err(format!(
                "Folder task plan schema {} is newer than supported schema {}",
                self.schema_version,
                current_plan_schema_version()
            ));
        }
        self.schema_version = current_plan_schema_version();
        if self.recipe_plan.is_null() {
            self.recipe_plan = default_recipe_plan(&self.recipe, goal);
        }
        if self.completion_policy == "review_before_write" {
            self.completion_policy = "review_required".into();
        }
        if self.completion_policy == "export_only" {
            self.completion_policy = "complete_after_processing".into();
        }
        if self.snapshot_mode == "incremental" {
            self.snapshot_mode = "use_scanned_snapshot".into();
        }
        if self.snapshot_mode == "full_rescan" {
            self.snapshot_mode = "refresh_before_run".into();
        }
        Ok(())
    }

    fn default_for(task_id: &str, recipe: &str, goal: &str, inventory: &FolderInventory) -> Self {
        let include_extensions = inventory
            .extension_counts
            .keys()
            .filter(|extension| is_task_parseable_extension(extension))
            .cloned()
            .collect();
        Self {
            schema_version: current_plan_schema_version(),
            recipe: recipe.to_string(),
            recipe_plan: default_recipe_plan(recipe, goal),
            batch_size: DEFAULT_BATCH_SIZE,
            completion_policy: default_completion_policy(),
            snapshot_mode: default_snapshot_mode(),
            review_policy: "pause_on_ambiguity".into(),
            include_extensions,
            exclusions: vec![
                ".solidify/**".into(),
                ".git/**".into(),
                "node_modules/**".into(),
                "~$*".into(),
            ],
            resource_limits: FolderTaskResourceLimits::default(),
            output: FolderTaskOutputPlan {
                relative_path: format!(".solidify/outputs/{task_id}.json"),
                ..FolderTaskOutputPlan::default()
            },
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.batch_size == 0 || self.batch_size > MAX_BATCH_SIZE {
            return Err(format!("Batch size must be between 1 and {MAX_BATCH_SIZE}"));
        }
        if !matches!(
            self.recipe.as_str(),
            "structured-extraction" | "document-review" | "classification"
        ) {
            return Err(format!("Unsupported folder task recipe: {}", self.recipe));
        }
        if self.schema_version != current_plan_schema_version() {
            return Err(format!(
                "Unsupported folder task plan schema: {}",
                self.schema_version
            ));
        }
        validate_recipe_plan(&self.recipe, &self.recipe_plan)?;
        if !matches!(
            self.completion_policy.as_str(),
            "review_required" | "complete_after_processing"
        ) {
            return Err("Unsupported completion policy".into());
        }
        if !matches!(
            self.snapshot_mode.as_str(),
            "use_scanned_snapshot" | "refresh_before_run"
        ) {
            return Err("Unsupported snapshot mode".into());
        }
        if !matches!(
            self.review_policy.as_str(),
            "pause_on_ambiguity" | "collect_until_checkpoint"
        ) {
            return Err("Unsupported review policy".into());
        }
        for extension in &self.include_extensions {
            let value = extension.trim();
            if value.is_empty()
                || value.starts_with('.')
                || value.contains('/')
                || value.contains('\\')
            {
                return Err(format!("Invalid included extension: {extension}"));
            }
        }
        if self.exclusions.len() > 200 {
            return Err("A plan cannot contain more than 200 exclusion patterns".into());
        }
        self.resource_limits.validate()?;
        self.output.validate()?;
        Ok(())
    }
}

impl FolderTaskResourceLimits {
    fn validate(&self) -> Result<(), String> {
        if self.max_batch_bytes == 0 || self.max_batch_bytes > 200 * 1024 * 1024 {
            return Err("maxBatchBytes must be between 1 and 209715200".into());
        }
        if self.max_batch_estimated_characters < 1_000
            || self.max_batch_estimated_characters > 1_000_000
        {
            return Err("maxBatchEstimatedCharacters must be between 1000 and 1000000".into());
        }
        if self.max_parsed_characters_per_file < 1_000
            || self.max_parsed_characters_per_file > 2_000_000
        {
            return Err("maxParsedCharactersPerFile must be between 1000 and 2000000".into());
        }
        if self.max_pdf_pages == 0
            || self.max_pdf_pages > 2_000
            || self.max_archive_entries == 0
            || self.max_archive_entries > 20_000
        {
            return Err("Parser page/archive limits are outside the supported range".into());
        }
        if self.max_expanded_bytes < 1024 * 1024 || self.max_expanded_bytes > 1024 * 1024 * 1024 {
            return Err("maxExpandedBytes must be between 1 MiB and 1 GiB".into());
        }
        Ok(())
    }
}

impl FolderTaskOutputPlan {
    fn validate(&self) -> Result<(), String> {
        if !matches!(self.format.as_str(), "json" | "xlsx") {
            return Err("Output format must be json or xlsx".into());
        }
        let relative = validate_relative_path(&self.relative_path)?;
        let extension = relative
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if !extension.eq_ignore_ascii_case(&self.format) {
            return Err(format!("Output path must end with .{}", self.format));
        }
        Ok(())
    }
}

fn default_recipe_plan(recipe: &str, goal: &str) -> Value {
    match recipe {
        "structured-extraction" => json!({
            "kind": recipe,
            "schemaVersion": 1,
            "fields": [],
            "dedupeKeys": [],
        }),
        "document-review" => json!({
            "kind": recipe,
            "schemaVersion": 1,
            "rules": [{
                "id": "task_goal",
                "title": "任务目标审查",
                "description": goal,
                "severity": "medium",
                "evidenceRequired": true,
            }],
        }),
        "classification" => json!({
            "kind": recipe,
            "schemaVersion": 1,
            "categories": [
                { "id": "match", "label": "符合目标", "description": goal },
                { "id": "no_match", "label": "不符合目标", "description": "内容与任务目标不匹配" }
            ],
            "minimumConfidence": 0.65,
            "unknownCategory": "uncertain",
        }),
        _ => Value::Null,
    }
}

fn validate_recipe_plan(recipe: &str, value: &Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "recipePlan must be an object".to_string())?;
    if object.get("kind").and_then(Value::as_str) != Some(recipe) {
        return Err("recipePlan.kind must match recipe".into());
    }
    if object.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("Unsupported recipePlan schemaVersion".into());
    }
    match recipe {
        "structured-extraction" => {
            let fields = object
                .get("fields")
                .and_then(Value::as_array)
                .ok_or_else(|| "Extraction recipePlan.fields must be an array".to_string())?;
            if fields.len() > 128 {
                return Err("Extraction plan cannot exceed 128 fields".into());
            }
            let mut names = BTreeSet::new();
            let mut labels = BTreeSet::new();
            for field in fields {
                let item = field
                    .as_object()
                    .ok_or_else(|| "Extraction fields must be objects".to_string())?;
                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "Extraction field name is required".to_string())?;
                if !names.insert(name.to_ascii_lowercase()) {
                    return Err(format!("Duplicate extraction field: {name}"));
                }
                if !labels.insert(name.to_ascii_lowercase()) {
                    return Err(format!("Ambiguous extraction field or alias: {name}"));
                }
                if !item
                    .get("description")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
                {
                    return Err(format!(
                        "Description is required for extraction field {name}"
                    ));
                }
                if !matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("string" | "number" | "boolean")
                ) {
                    return Err(format!("Invalid type for extraction field {name}"));
                }
                if !item.get("required").is_some_and(Value::is_boolean) {
                    return Err(format!(
                        "required must be boolean for extraction field {name}"
                    ));
                }
                let aliases = item
                    .get("aliases")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        format!("aliases must be an array for extraction field {name}")
                    })?;
                for alias in aliases {
                    let alias = alias
                        .as_str()
                        .filter(|value| !value.trim().is_empty())
                        .ok_or_else(|| {
                            format!("aliases for extraction field {name} must be non-empty strings")
                        })?;
                    if !labels.insert(alias.to_ascii_lowercase()) {
                        return Err(format!("Ambiguous extraction field or alias: {alias}"));
                    }
                }
            }
            let dedupe = object
                .get("dedupeKeys")
                .and_then(Value::as_array)
                .ok_or_else(|| "dedupeKeys must be an array".to_string())?;
            for key in dedupe {
                let key = key
                    .as_str()
                    .ok_or_else(|| "dedupeKeys must contain strings".to_string())?;
                if !names.contains(&key.to_ascii_lowercase()) {
                    return Err(format!("Unknown dedupe field: {key}"));
                }
            }
        }
        "document-review" => {
            let rules = object
                .get("rules")
                .and_then(Value::as_array)
                .ok_or_else(|| "Review recipePlan.rules must be an array".to_string())?;
            if rules.is_empty() || rules.len() > 128 {
                return Err("Review plan must contain 1 to 128 rules".into());
            }
            let mut ids = BTreeSet::new();
            for rule in rules {
                let item = rule
                    .as_object()
                    .ok_or_else(|| "Review rules must be objects".to_string())?;
                let id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "Review rule id is required".to_string())?;
                if !ids.insert(id.to_string()) {
                    return Err(format!("Duplicate review rule: {id}"));
                }
                for field in ["title", "description"] {
                    if !item
                        .get(field)
                        .and_then(Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty())
                    {
                        return Err(format!("Review rule {id} requires {field}"));
                    }
                }
                if !matches!(
                    item.get("severity").and_then(Value::as_str),
                    Some("low" | "medium" | "high")
                ) {
                    return Err(format!("Invalid severity for review rule {id}"));
                }
                if !item.get("evidenceRequired").is_some_and(Value::is_boolean) {
                    return Err(format!(
                        "Review rule {id} requires boolean evidenceRequired"
                    ));
                }
            }
        }
        "classification" => {
            let categories = object
                .get("categories")
                .and_then(Value::as_array)
                .ok_or_else(|| "Classification categories must be an array".to_string())?;
            if categories.len() < 2 || categories.len() > 128 {
                return Err("Classification plan must contain 2 to 128 categories".into());
            }
            let mut ids = BTreeSet::new();
            for category in categories {
                let item = category
                    .as_object()
                    .ok_or_else(|| "Classification categories must be objects".to_string())?;
                let id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "Classification category id is required".to_string())?;
                if !ids.insert(id.to_string()) {
                    return Err(format!("Duplicate classification category: {id}"));
                }
                for field in ["label", "description"] {
                    if !item
                        .get(field)
                        .and_then(Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty())
                    {
                        return Err(format!("Classification category {id} requires {field}"));
                    }
                }
            }
            let unknown = object
                .get("unknownCategory")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "unknownCategory is required".to_string())?;
            if ids.contains(unknown) {
                return Err("unknownCategory must be distinct from normal categories".into());
            }
            let threshold = object
                .get("minimumConfidence")
                .and_then(Value::as_f64)
                .ok_or_else(|| "minimumConfidence must be numeric".to_string())?;
            if !(0.0..=1.0).contains(&threshold) {
                return Err("minimumConfidence must be between 0 and 1".into());
            }
        }
        _ => return Err(format!("Unsupported folder task recipe: {recipe}")),
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct FolderInventory {
    pub files: u64,
    pub directories: u64,
    pub total_bytes: u64,
    pub readable_files: u64,
    /// Format candidates, not a claim that the local OCR components are ready.
    pub external_files: u64,
    pub attention_files: u64,
    pub top_level_groups: u64,
    pub extension_counts: BTreeMap<String, u64>,
    pub fingerprint: String,
    pub truncated: bool,
    pub truncation_reasons: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTaskSummary {
    pub id: String,
    pub name: String,
    pub goal: String,
    pub root_path: String,
    pub status: FolderTaskStatus,
    pub recipe: String,
    pub inventory: FolderInventory,
    pub progress: FolderTaskProgress,
    pub pending_decisions: u64,
    pub created_at: i64,
    pub updated_at: i64,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FolderTaskProgress {
    pub pending: u64,
    pub processing: u64,
    pub completed: u64,
    pub skipped: u64,
    pub failed: u64,
    pub pending_decision: u64,
    pub manual_review: u64,
    pub awaiting_external_parser: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTaskItem {
    pub id: String,
    pub relative_path: String,
    pub size: u64,
    pub modified_at: i64,
    pub extension: String,
    pub content_hash: String,
    pub estimated_characters: u64,
    pub status: String,
    pub attempts: u32,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub provenance: FolderTaskProvenance,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTaskProvenance {
    pub relative_path: String,
    pub source_hash: String,
    pub size: u64,
    pub modified_at: i64,
    pub parser: String,
    pub parser_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extraction: Option<extraction::ExtractionReceipt>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionOption {
    pub id: String,
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTaskDecision {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub description: String,
    pub evidence: Value,
    pub options: Vec<DecisionOption>,
    pub recommended_option_id: Option<String>,
    pub affected_item_ids: Vec<String>,
    pub apply_key: Option<String>,
    pub status: String,
    pub resolution: Option<Value>,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTaskEvent {
    pub seq: u64,
    pub event_type: String,
    pub data: Value,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTaskDetail {
    #[serde(flatten)]
    pub summary: FolderTaskSummary,
    pub plan: FolderTaskPlan,
    pub decisions: Vec<FolderTaskDecision>,
    pub recent_events: Vec<FolderTaskEvent>,
    pub active_batch: Option<FolderTaskBatch>,
    pub recent_runs: Vec<FolderTaskRun>,
    pub confirmed_plan_hash: Option<String>,
    pub latest_output: Option<FolderTaskOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTaskOutput {
    pub format: String,
    pub relative_path: String,
    pub content_hash: String,
    pub item_count: u64,
    pub created_at: i64,
    pub result_revision: i64,
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTaskPlanPreview {
    pub confirmation_token: String,
    pub inventory_fingerprint: String,
    pub selected_files: u64,
    pub selected_bytes: u64,
    pub excluded_files: u64,
    pub excluded_by_extension: u64,
    pub excluded_by_pattern: u64,
    pub warnings: Vec<String>,
    pub plan: FolderTaskPlan,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTaskBatch {
    pub id: String,
    pub task_id: String,
    pub run_id: String,
    pub lease_token: String,
    pub status: String,
    pub item_ids: Vec<String>,
    pub lease_expires_at: i64,
    pub created_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTaskRun {
    pub run_id: String,
    pub task_id: String,
    pub status: String,
    pub error: Option<String>,
    pub started_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTaskBatchClaim {
    pub batch: Option<FolderTaskBatch>,
    pub items: Vec<FolderTaskItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTaskItemUpdate {
    pub item_id: String,
    pub status: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTaskReviewUpdate {
    pub item_id: String,
    pub action: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewDecisionRequest {
    pub kind: String,
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub evidence: Value,
    pub options: Vec<DecisionOption>,
    pub recommended_option_id: Option<String>,
    #[serde(default)]
    pub affected_item_ids: Vec<String>,
    pub apply_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTaskFileBytes {
    pub name: String,
    pub bytes: Vec<u8>,
    pub size: u64,
    pub content_hash: String,
}

#[tauri::command]
pub async fn create_folder_task(
    app: AppHandle,
    name: String,
    goal: String,
    recipe: String,
    source_mode: Option<String>,
    manager: State<'_, FolderTaskManager>,
) -> Result<Option<FolderTaskDetail>, String> {
    let (root, source_paths) = if source_mode.as_deref() == Some("documents") {
        let Some(selected) = app.dialog().file().blocking_pick_files() else {
            return Ok(None);
        };
        let selected = selected
            .into_iter()
            .map(|path| {
                path.into_path()
                    .map_err(|error| format!("Unable to use selected document: {error}"))
                    .and_then(|path| {
                        fs::canonicalize(path).map_err(|error| {
                            format!("Selected document is not accessible: {error}")
                        })
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let root = selected
            .first()
            .and_then(|path| path.parent())
            .ok_or_else(|| "Select at least one document".to_string())?
            .to_path_buf();
        if selected
            .iter()
            .any(|path| !path.is_file() || path.parent() != Some(root.as_path()))
        {
            return Err("Selected documents must be regular files in the same folder".into());
        }
        let source_paths = selected
            .iter()
            .map(|path| {
                path.strip_prefix(&root)
                    .map(Path::to_path_buf)
                    .map_err(|error| error.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        (root, source_paths)
    } else {
        let Some(selected) = app.dialog().file().blocking_pick_folder() else {
            return Ok(None);
        };
        let root = selected
            .into_path()
            .map_err(|error| format!("Unable to use selected folder: {error}"))?;
        (root, Vec::new())
    };
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        create_folder_task_with_sources_impl(&manager, root, source_paths, name, goal, recipe)
            .map(Some)
    })
    .await
    .map_err(|error| format!("Folder inventory worker failed: {error}"))?
}

#[tauri::command]
pub fn list_folder_tasks(
    manager: State<'_, FolderTaskManager>,
) -> Result<Vec<FolderTaskSummary>, String> {
    list_folder_tasks_impl(&manager)
}

#[tauri::command]
pub fn get_folder_task(
    task_id: String,
    manager: State<'_, FolderTaskManager>,
) -> Result<FolderTaskDetail, String> {
    get_folder_task_impl(&manager, &task_id)
}

#[tauri::command]
pub fn list_folder_task_items(
    task_id: String,
    status: Option<String>,
    offset: u32,
    limit: u32,
    manager: State<'_, FolderTaskManager>,
) -> Result<Vec<FolderTaskItem>, String> {
    list_folder_task_items_impl(&manager, &task_id, status.as_deref(), offset, limit)
}

#[tauri::command]
pub fn preview_folder_task_plan(
    task_id: String,
    plan: FolderTaskPlan,
    expected_revision: u64,
    manager: State<'_, FolderTaskManager>,
) -> Result<FolderTaskPlanPreview, String> {
    preview_folder_task_plan_impl(&manager, &task_id, plan, expected_revision)
}

#[tauri::command]
pub async fn confirm_folder_task_plan(
    task_id: String,
    confirmation_token: String,
    expected_revision: u64,
    manager: State<'_, FolderTaskManager>,
) -> Result<FolderTaskDetail, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        confirm_previewed_folder_task_plan_impl(
            &manager,
            &task_id,
            &confirmation_token,
            expected_revision,
        )
    })
    .await
    .map_err(|error| format!("Folder inventory worker failed: {error}"))?
}

fn preview_folder_task_plan_impl(
    manager: &FolderTaskManager,
    task_id: &str,
    plan: FolderTaskPlan,
    expected_revision: u64,
) -> Result<FolderTaskPlanPreview, String> {
    plan.validate()?;
    let mut connection = manager.connection()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    require_status_and_revision(
        &transaction,
        task_id,
        &[FolderTaskStatus::AwaitingPlanConfirmation],
        expected_revision,
    )?;
    if count_pending_decisions(&transaction, task_id)? > 0 {
        return Err("Resolve all planning decisions before previewing the plan".into());
    }
    let inventory_json: String = transaction
        .query_row(
            "SELECT inventory_json FROM folder_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| map_not_found(error, "Folder task"))?;
    let inventory: FolderInventory = from_json(&inventory_json, "folder inventory")?;
    let scope = plan_scope_preview(&transaction, task_id, &plan)?;
    let plan_json = to_json(&plan)?;
    let confirmation_token = plan_confirmation_token(task_id, &inventory.fingerprint, &plan_json);
    let mut warnings = Vec::new();
    if scope.0 == 0 {
        warnings.push("The plan selects no files".into());
    }
    if inventory.external_files > 0 && plan.include_extensions.iter().any(|extension| is_external_image_extension(extension)) {
        warnings.push("计划包含 OCR 图片格式；读取需要本机转换组件，缺失时保留为待转换。固定转换总时限最多 120 秒、PDF 最多 20 页，且受计划中更严格的限制约束。".into());
    }
    if inventory.truncated {
        warnings.extend(
            inventory
                .truncation_reasons
                .iter()
                .map(|reason| format!("Inventory is incomplete: {reason}")),
        );
    }
    let now = now_ms()?;
    transaction.execute(
        "INSERT INTO folder_task_plan_previews(task_id, confirmation_token, inventory_fingerprint, plan_json, selected_files, selected_bytes, excluded_files, excluded_by_extension, excluded_by_pattern, warnings_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(task_id) DO UPDATE SET confirmation_token = excluded.confirmation_token, inventory_fingerprint = excluded.inventory_fingerprint, plan_json = excluded.plan_json, selected_files = excluded.selected_files, selected_bytes = excluded.selected_bytes, excluded_files = excluded.excluded_files, excluded_by_extension = excluded.excluded_by_extension, excluded_by_pattern = excluded.excluded_by_pattern, warnings_json = excluded.warnings_json, created_at = excluded.created_at",
        params![task_id, confirmation_token, inventory.fingerprint, plan_json, scope.0, scope.1, scope.2, scope.3, scope.4, to_json(&warnings)?, now],
    ).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(FolderTaskPlanPreview {
        confirmation_token,
        inventory_fingerprint: inventory.fingerprint,
        selected_files: scope.0,
        selected_bytes: scope.1,
        excluded_files: scope.2,
        excluded_by_extension: scope.3,
        excluded_by_pattern: scope.4,
        warnings,
        plan,
    })
}

fn confirm_previewed_folder_task_plan_impl(
    manager: &FolderTaskManager,
    task_id: &str,
    confirmation_token: &str,
    expected_revision: u64,
) -> Result<FolderTaskDetail, String> {
    validate_id(confirmation_token)?;
    let connection = manager.connection()?;
    let (plan_json, fingerprint): (String, String) = connection.query_row(
        "SELECT plan_json, inventory_fingerprint FROM folder_task_plan_previews WHERE task_id = ?1 AND confirmation_token = ?2",
        params![task_id, confirmation_token],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|error| map_not_found(error, "Folder task plan preview"))?;
    let plan: FolderTaskPlan = from_json(&plan_json, "folder task plan preview")?;
    confirm_folder_task_plan_with_preview(
        manager,
        task_id,
        plan,
        expected_revision,
        Some((&fingerprint, confirmation_token)),
    )
}

#[cfg_attr(not(test), allow(dead_code))]
fn confirm_folder_task_plan_impl(
    manager: &FolderTaskManager,
    task_id: &str,
    plan: FolderTaskPlan,
    expected_revision: u64,
) -> Result<FolderTaskDetail, String> {
    confirm_folder_task_plan_with_preview(manager, task_id, plan, expected_revision, None)
}

fn confirm_folder_task_plan_with_preview(
    manager: &FolderTaskManager,
    task_id: &str,
    plan: FolderTaskPlan,
    expected_revision: u64,
    preview: Option<(&str, &str)>,
) -> Result<FolderTaskDetail, String> {
    let _mutation = manager.executions.mutation_when_idle(task_id).map_err(|error| error.to_string())?;
    plan.validate()?;
    let refreshed = if plan.snapshot_mode == "refresh_before_run" {
        let connection = manager.connection()?;
        let (root, source_paths_json): (String, String) = connection
            .query_row(
                "SELECT root_path, source_paths_json FROM folder_tasks WHERE id = ?1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| map_not_found(error, "Folder task"))?;
        let source_paths: Vec<PathBuf> = from_json(&source_paths_json, "folder task source paths")?;
        Some(if source_paths.is_empty() {
            scan_inventory(task_id, Path::new(&root))?
        } else {
            scan_selected_inventory(task_id, Path::new(&root), &source_paths)?
        })
    } else {
        None
    };
    let mut connection = manager.connection()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    require_status_and_revision(
        &transaction,
        task_id,
        &[FolderTaskStatus::AwaitingPlanConfirmation],
        expected_revision,
    )?;
    let pending_decisions: u64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM folder_task_decisions WHERE task_id = ?1 AND status = 'pending'",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if pending_decisions > 0 {
        return Err("Resolve all planning decisions before confirming the plan".into());
    }
    let now = now_ms()?;
    if let Some((inventory, items)) = refreshed {
        let preview_became_stale =
            preview.is_some_and(|(fingerprint, _)| fingerprint != inventory.fingerprint);
        transaction
            .execute(
                "DELETE FROM folder_task_items WHERE task_id = ?1",
                [task_id],
            )
            .map_err(|error| error.to_string())?;
        insert_inventory_items(&transaction, task_id, &items)?;
        transaction
            .execute(
                "UPDATE folder_tasks SET inventory_json = ?1 WHERE id = ?2",
                params![to_json(&inventory)?, task_id],
            )
            .map_err(|error| error.to_string())?;
        append_event(
            &transaction,
            task_id,
            "inventory.refreshed",
            json!({ "inventory": inventory }),
            now,
        )?;
        if preview_became_stale {
            seed_or_apply_inventory_policy(&transaction, task_id, &inventory, now)?;
            transaction
                .execute(
                    "DELETE FROM folder_task_plan_previews WHERE task_id = ?1",
                    [task_id],
                )
                .map_err(|error| error.to_string())?;
            transaction.execute(
                "UPDATE folder_tasks SET plan_json = ?1, updated_at = ?2, revision = revision + 1 WHERE id = ?3",
                params![to_json(&plan)?, now, task_id],
            ).map_err(|error| error.to_string())?;
            append_event(
                &transaction,
                task_id,
                "plan.preview_stale",
                json!({ "reason": "inventory_changed", "inventoryFingerprint": inventory.fingerprint }),
                now,
            )?;
            transaction.commit().map_err(|error| error.to_string())?;
            return Err("Inventory changed during refresh; review the refreshed inventory and preview the plan again".into());
        }
        if inventory.attention_files > 0 {
            let resolved_policy = resolved_unsupported_policy(&transaction, task_id)?;
            if let Some(option_id) = resolved_policy {
                apply_unsupported_format_policy(&transaction, task_id, &option_id)?;
            } else {
                seed_inventory_decisions(&transaction, task_id, &inventory, now)?;
                transaction
                    .execute(
                        "UPDATE folder_tasks SET plan_json = ?1, updated_at = ?2, revision = revision + 1 WHERE id = ?3",
                        params![to_json(&plan)?, now, task_id],
                    )
                    .map_err(|error| error.to_string())?;
                transaction.commit().map_err(|error| error.to_string())?;
                return get_folder_task_impl(manager, task_id);
            }
        }
    }
    let inventory_json: String = transaction
        .query_row(
            "SELECT inventory_json FROM folder_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| map_not_found(error, "Folder task"))?;
    let inventory: FolderInventory = from_json(&inventory_json, "folder inventory")?;
    let plan_json = to_json(&plan)?;
    let confirmed_plan_hash = preview
        .map(|(_, token)| token.to_string())
        .unwrap_or_else(|| plan_confirmation_token(task_id, &inventory.fingerprint, &plan_json));
    if let Some((fingerprint, token)) = preview {
        let expected = plan_confirmation_token(task_id, fingerprint, &plan_json);
        if fingerprint != inventory.fingerprint || token != expected {
            return Err("Folder task plan preview no longer matches the inventory or plan".into());
        }
    }
    if plan_scope_preview(&transaction, task_id, &plan)?.0 == 0 {
        return Err(
            "The confirmed plan selects no files; adjust its extensions or exclusions".into(),
        );
    }
    apply_plan_scope(&transaction, task_id, &plan)?;
    transaction
        .execute(
            "UPDATE folder_tasks SET status = 'running', recipe = ?1, plan_json = ?2, confirmed_plan_hash = ?3, updated_at = ?4, revision = revision + 1 WHERE id = ?5",
            params![&plan.recipe, plan_json, confirmed_plan_hash, now, task_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM folder_task_plan_previews WHERE task_id = ?1",
            [task_id],
        )
        .map_err(|error| error.to_string())?;
    append_event(
        &transaction,
        task_id,
        "plan.confirmed",
        json!({ "plan": plan, "confirmedPlanHash": confirmed_plan_hash, "inventoryFingerprint": inventory.fingerprint }),
        now,
    )?;
    transaction.commit().map_err(|error| error.to_string())?;
    get_folder_task_impl(manager, task_id)
}

#[tauri::command]
pub fn claim_folder_task_batch(
    task_id: String,
    run_id: String,
    limit: Option<u32>,
    manager: State<'_, FolderTaskManager>,
) -> Result<FolderTaskBatchClaim, String> {
    let connection = manager.connection()?;
    let plan_json: String = connection
        .query_row(
            "SELECT plan_json FROM folder_tasks WHERE id = ?1",
            [&task_id],
            |row| row.get(0),
        )
        .map_err(|error| map_not_found(error, "Folder task"))?;
    let plan: FolderTaskPlan = from_json(&plan_json, "folder task plan")?;
    let batch_limit = limit.unwrap_or(plan.batch_size);
    if batch_limit > plan.batch_size {
        return Err(format!(
            "Requested batch exceeds the confirmed plan limit of {}",
            plan.batch_size
        ));
    }
    claim_folder_task_batch_impl(&manager, &task_id, &run_id, batch_limit)
}

#[tauri::command]
pub fn update_folder_task_batch(
    task_id: String,
    run_id: String,
    batch_token: String,
    updates: Vec<FolderTaskItemUpdate>,
    checkpoint_note: Option<String>,
    checkpoint_mode: Option<String>,
    manager: State<'_, FolderTaskManager>,
) -> Result<FolderTaskDetail, String> {
    update_folder_task_batch_impl(
        &manager,
        &task_id,
        &run_id,
        &batch_token,
        updates,
        checkpoint_note,
        checkpoint_mode.as_deref().unwrap_or("complete"),
    )
}

#[tauri::command]
pub fn request_folder_task_decision(
    task_id: String,
    run_id: String,
    batch_token: String,
    request: NewDecisionRequest,
    manager: State<'_, FolderTaskManager>,
) -> Result<FolderTaskDecision, String> {
    request_folder_task_decision_impl(
        &manager,
        &task_id,
        Some(&run_id),
        Some(&batch_token),
        request,
    )
}

#[tauri::command]
pub fn resolve_folder_task_decision(
    task_id: String,
    decision_id: String,
    option_id: String,
    note: Option<String>,
    apply_to_similar: bool,
    expected_revision: u64,
    manager: State<'_, FolderTaskManager>,
) -> Result<FolderTaskDetail, String> {
    resolve_folder_task_decision_impl(
        &manager,
        &task_id,
        &decision_id,
        &option_id,
        note,
        apply_to_similar,
        expected_revision,
    )
}

#[tauri::command]
pub async fn set_folder_task_status(
    app: AppHandle,
    task_id: String,
    action: String,
    expected_revision: u64,
    manager: State<'_, FolderTaskManager>,
) -> Result<FolderTaskDetail, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        set_folder_task_status_with_progress(&manager, &task_id, &action, expected_revision, |delayed| {
            let _ = app.emit("folder-task-execution-stopping", json!({ "taskId": task_id, "delayed": delayed }));
        })
    }).await.map_err(|error| format!("Folder task stop worker failed: {error}"))?
}

#[tauri::command]
pub fn read_folder_task_file_bytes(
    task_id: String,
    run_id: String,
    batch_token: String,
    relative_path: String,
    manager: State<'_, FolderTaskManager>,
) -> Result<FolderTaskFileBytes, String> {
    read_folder_task_file_bytes_impl(&manager, &task_id, &run_id, &batch_token, &relative_path)
}

#[tauri::command]
pub async fn finish_folder_task_run(
    app: AppHandle,
    task_id: String,
    run_id: String,
    outcome: String,
    error: Option<String>,
    manager: State<'_, FolderTaskManager>,
) -> Result<FolderTaskDetail, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        finish_folder_task_run_with_progress(&manager, &task_id, &run_id, &outcome, error, |delayed| {
            let _ = app.emit("folder-task-execution-stopping", json!({ "taskId": task_id, "delayed": delayed }));
        })
    }).await.map_err(|error| format!("Folder task run cleanup worker failed: {error}"))?
}

#[tauri::command]
pub async fn review_folder_task_items(
    app: AppHandle,
    task_id: String,
    updates: Vec<FolderTaskReviewUpdate>,
    expected_revision: u64,
    manager: State<'_, FolderTaskManager>,
) -> Result<FolderTaskDetail, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<super::sandbox_exec::runtime::SandboxRuntime>();
        review_folder_task_items_with_capability(&manager, &task_id, updates, expected_revision,
            |method| runtime.components(method).map(|_| ()).map_err(|error| error.to_string()))
    }).await.map_err(|error| format!("Folder task review worker failed: {error}"))?
}

#[tauri::command]
pub fn write_folder_task_output(
    task_id: String,
    expected_revision: u64,
    manager: State<'_, FolderTaskManager>,
) -> Result<FolderTaskDetail, String> {
    write_folder_task_output_impl(&manager, &task_id, expected_revision)
}

#[tauri::command]
pub fn delete_folder_task(
    task_id: String,
    expected_revision: u64,
    manager: State<'_, FolderTaskManager>,
) -> Result<(), String> {
    delete_folder_task_impl(&manager, &task_id, expected_revision)
}

fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS folder_task_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )
        .map_err(|error| format!("Unable to initialize folder task database: {error}"))?;
    let existing_version = connection
        .query_row(
            "SELECT value FROM folder_task_meta WHERE key = 'schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to read folder task schema version: {error}"))?
        .map(|value| {
            value
                .parse::<i64>()
                .map_err(|_| format!("Invalid folder task schema version: {value}"))
        })
        .transpose()?
        .unwrap_or(0);
    if existing_version > SCHEMA_VERSION {
        return Err(format!(
            "Folder task database schema {existing_version} is newer than supported schema {SCHEMA_VERSION}"
        ));
    }
    connection
        .execute_batch(&format!(
            "
            CREATE TABLE IF NOT EXISTS folder_task_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS folder_tasks (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                goal TEXT NOT NULL,
                root_path TEXT NOT NULL,
                status TEXT NOT NULL,
                recipe TEXT NOT NULL,
                plan_json TEXT NOT NULL,
                inventory_json TEXT NOT NULL,
                source_paths_json TEXT NOT NULL DEFAULT '[]',
                confirmed_plan_hash TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                result_revision INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS folder_task_items (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES folder_tasks(id) ON DELETE CASCADE,
                relative_path TEXT NOT NULL,
                size INTEGER NOT NULL,
                modified_at INTEGER NOT NULL,
                extension TEXT NOT NULL,
                content_hash TEXT NOT NULL DEFAULT '',
                estimated_characters INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                result_json TEXT,
                error TEXT,
                UNIQUE(task_id, relative_path)
            );
            CREATE INDEX IF NOT EXISTS idx_folder_task_items_status
                ON folder_task_items(task_id, status, relative_path);
            CREATE TABLE IF NOT EXISTS folder_task_decisions (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES folder_tasks(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                evidence_json TEXT NOT NULL,
                options_json TEXT NOT NULL,
                recommended_option_id TEXT,
                affected_item_ids_json TEXT NOT NULL,
                apply_key TEXT,
                status TEXT NOT NULL,
                resolution_json TEXT,
                created_at INTEGER NOT NULL,
                resolved_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_folder_task_decisions_status
                ON folder_task_decisions(task_id, status, created_at);
            CREATE TABLE IF NOT EXISTS folder_task_events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL REFERENCES folder_tasks(id) ON DELETE CASCADE,
                event_type TEXT NOT NULL,
                data_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS folder_task_runs (
                run_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES folder_tasks(id) ON DELETE CASCADE,
                status TEXT NOT NULL,
                error TEXT,
                started_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                completed_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_folder_task_runs_task
                ON folder_task_runs(task_id, started_at DESC);
            CREATE TABLE IF NOT EXISTS folder_task_batches (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES folder_tasks(id) ON DELETE CASCADE,
                run_id TEXT NOT NULL REFERENCES folder_task_runs(run_id) ON DELETE CASCADE,
                lease_token TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL,
                item_ids_json TEXT NOT NULL,
                lease_expires_at INTEGER NOT NULL,
                checkpoint_note TEXT,
                created_at INTEGER NOT NULL,
                completed_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_folder_task_batches_active
                ON folder_task_batches(task_id, status, lease_expires_at);
            CREATE TABLE IF NOT EXISTS folder_task_batch_items (
                batch_id TEXT NOT NULL REFERENCES folder_task_batches(id) ON DELETE CASCADE,
                item_id TEXT NOT NULL REFERENCES folder_task_items(id) ON DELETE CASCADE,
                ordinal INTEGER NOT NULL,
                PRIMARY KEY(batch_id, item_id)
            );
            CREATE TABLE IF NOT EXISTS folder_task_plan_previews (
                task_id TEXT PRIMARY KEY REFERENCES folder_tasks(id) ON DELETE CASCADE,
                confirmation_token TEXT NOT NULL UNIQUE,
                inventory_fingerprint TEXT NOT NULL,
                plan_json TEXT NOT NULL,
                selected_files INTEGER NOT NULL,
                selected_bytes INTEGER NOT NULL,
                excluded_files INTEGER NOT NULL,
                excluded_by_extension INTEGER NOT NULL,
                excluded_by_pattern INTEGER NOT NULL,
                warnings_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS folder_task_outputs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL REFERENCES folder_tasks(id) ON DELETE CASCADE,
                format TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                item_count INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                result_revision INTEGER NOT NULL DEFAULT -1
            );
            CREATE INDEX IF NOT EXISTS idx_folder_task_outputs_task
                ON folder_task_outputs(task_id, created_at DESC);
            UPDATE folder_task_items
               SET status = 'manual_review'
             WHERE status = 'pending_decision'
               AND result_json LIKE '%manual_review_queue%';
            UPDATE folder_task_items
               SET status = 'awaiting_external_parser'
             WHERE status = 'pending_decision'
               AND result_json LIKE '%external_parser_required%';
            UPDATE folder_task_items
               SET status = 'awaiting_external_parser',
                   result_json = replace(result_json, 'manual_review_queue', 'external_parser_required')
             WHERE status = 'manual_review'
               AND result_json LIKE '%manual_review_queue%';
            UPDATE folder_task_items
               SET status = 'pending'
             WHERE status = 'processing'
               AND NOT EXISTS (
                   SELECT 1 FROM folder_task_batch_items bi
                   JOIN folder_task_batches b ON b.id = bi.batch_id
                   WHERE bi.item_id = folder_task_items.id AND b.status = 'active'
               );
            INSERT INTO folder_task_meta(key, value) VALUES ('schema_version', '{SCHEMA_VERSION}')
                ON CONFLICT(key) DO UPDATE SET value = excluded.value;
            "
        ))
        .map_err(|error| format!("Unable to migrate folder task database: {error}"))?;
    ensure_column(connection, "folder_tasks", "confirmed_plan_hash", "TEXT")?;
    ensure_column(connection, "folder_task_batches", "owner_instance_id", "TEXT")?;
    ensure_column(connection, "folder_task_items", "extraction_json", "TEXT")?;
    ensure_column(
        connection,
        "folder_tasks",
        "source_paths_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    ensure_column(
        connection,
        "folder_tasks",
        "result_revision",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        connection,
        "folder_task_outputs",
        "result_revision",
        "INTEGER NOT NULL DEFAULT -1",
    )?;
    ensure_column(
        connection,
        "folder_task_items",
        "content_hash",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        connection,
        "folder_task_items",
        "estimated_characters",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    upgrade_legacy_plans(connection)?;
    Ok(())
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if !names.iter().any(|name| name == column) {
        connection
            .execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition}"
            ))
            .map_err(|error| format!("Unable to add {table}.{column}: {error}"))?;
    }
    Ok(())
}

fn upgrade_legacy_plans(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("SELECT id, goal, plan_json FROM folder_tasks")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    for (task_id, goal, original) in rows {
        let original_value: Value = from_json(&original, "folder task plan")?;
        let had_output_plan = original_value.get("output").is_some();
        let mut plan: FolderTaskPlan = from_json(&original, "folder task plan")?;
        plan.normalize_legacy(&goal)?;
        if !had_output_plan {
            plan.output.relative_path = format!(".solidify/outputs/{task_id}.json");
        }
        let upgraded = to_json(&plan)?;
        if upgraded != original {
            connection
                .execute(
                    "UPDATE folder_tasks SET plan_json = ?1 WHERE id = ?2",
                    params![upgraded, task_id],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg_attr(not(test), allow(dead_code))]
fn create_folder_task_impl(
    manager: &FolderTaskManager,
    root: PathBuf,
    name: String,
    goal: String,
    recipe: String,
) -> Result<FolderTaskDetail, String> {
    create_folder_task_with_sources_impl(manager, root, Vec::new(), name, goal, recipe)
}

fn create_folder_task_with_sources_impl(
    manager: &FolderTaskManager,
    root: PathBuf,
    source_paths: Vec<PathBuf>,
    name: String,
    goal: String,
    recipe: String,
) -> Result<FolderTaskDetail, String> {
    let name = name.trim();
    let goal = goal.trim();
    let recipe = recipe.trim();
    if name.is_empty() || goal.is_empty() || recipe.is_empty() {
        return Err("Task name, goal, and recipe are required".into());
    }
    let root = fs::canonicalize(root)
        .map_err(|error| format!("Selected folder is not accessible: {error}"))?;
    if !root.is_dir() {
        return Err("Folder task root must be a directory".into());
    }

    let task_id = new_id("ftask")?;
    let (inventory, items) = if source_paths.is_empty() {
        scan_inventory(&task_id, &root)?
    } else {
        scan_selected_inventory(&task_id, &root, &source_paths)?
    };
    let source_paths = source_paths
        .iter()
        .map(|path| portable_path(path))
        .collect::<Vec<_>>();
    let plan = FolderTaskPlan::default_for(&task_id, recipe, goal, &inventory);
    plan.validate()?;
    let now = now_ms()?;
    let mut connection = manager.connection()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO folder_tasks(id, name, goal, root_path, status, recipe, plan_json, inventory_json, source_paths_json, created_at, updated_at, revision)
             VALUES (?1, ?2, ?3, ?4, 'awaiting_plan_confirmation', ?5, ?6, ?7, ?8, ?9, ?9, 1)",
            params![
                task_id,
                name,
                goal,
                root.to_string_lossy(),
                recipe,
                to_json(&plan)?,
                to_json(&inventory)?,
                to_json(&source_paths)?,
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
    insert_inventory_items(&transaction, &task_id, &items)?;
    append_event(
        &transaction,
        &task_id,
        "inventory.completed",
        json!({ "inventory": inventory, "rootPath": root.to_string_lossy() }),
        now,
    )?;
    seed_inventory_decisions(&transaction, &task_id, &inventory, now)?;
    transaction.commit().map_err(|error| error.to_string())?;
    get_folder_task_impl(manager, &task_id)
}

fn insert_inventory_items(
    transaction: &Transaction<'_>,
    task_id: &str,
    items: &[FolderTaskItem],
) -> Result<(), String> {
    let mut statement = transaction
        .prepare(
            "INSERT INTO folder_task_items(id, task_id, relative_path, size, modified_at, extension, content_hash, estimated_characters, status, attempts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0)",
        )
        .map_err(|error| error.to_string())?;
    for item in items {
        statement
            .execute(params![
                item.id,
                task_id,
                item.relative_path,
                item.size,
                item.modified_at,
                item.extension,
                item.content_hash,
                item.estimated_characters,
                item.status,
            ])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn apply_plan_scope(
    transaction: &Transaction<'_>,
    task_id: &str,
    plan: &FolderTaskPlan,
) -> Result<(), String> {
    let included = plan
        .include_extensions
        .iter()
        .map(|extension| extension.trim().to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    let mut builder = GitignoreBuilder::new("");
    for pattern in &plan.exclusions {
        let pattern = pattern.trim();
        if pattern.is_empty() {
            continue;
        }
        builder
            .add_line(None, pattern)
            .map_err(|error| format!("Invalid exclusion pattern '{pattern}': {error}"))?;
    }
    let exclusions = builder
        .build()
        .map_err(|error| format!("Unable to build plan exclusions: {error}"))?;
    let mut statement = transaction
        .prepare(
            "SELECT id, relative_path, extension FROM folder_task_items
             WHERE task_id = ?1 AND status = 'pending'",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    for (item_id, relative_path, extension) in rows {
        let extension_included = included.contains(&extension.to_ascii_lowercase());
        let path_excluded = exclusions
            .matched_path_or_any_parents(Path::new(&relative_path), false)
            .is_ignore();
        if extension_included && !path_excluded {
            continue;
        }
        transaction
            .execute(
                "UPDATE folder_task_items SET status = 'skipped', result_json = ?1
                 WHERE task_id = ?2 AND id = ?3 AND status = 'pending'",
                params![
                    json!({
                        "reason": "plan_scope",
                        "extensionIncluded": extension_included,
                        "pathExcluded": path_excluded,
                    })
                    .to_string(),
                    task_id,
                    item_id,
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn plan_scope_preview(
    connection: &Connection,
    task_id: &str,
    plan: &FolderTaskPlan,
) -> Result<(u64, u64, u64, u64, u64), String> {
    let included = plan
        .include_extensions
        .iter()
        .map(|extension| extension.trim().to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    let mut builder = GitignoreBuilder::new("");
    for pattern in &plan.exclusions {
        let pattern = pattern.trim();
        if !pattern.is_empty() {
            builder
                .add_line(None, pattern)
                .map_err(|error| format!("Invalid exclusion pattern '{pattern}': {error}"))?;
        }
    }
    let exclusions = builder
        .build()
        .map_err(|error| format!("Unable to build plan exclusions: {error}"))?;
    let mut statement = connection
        .prepare(
            "SELECT relative_path, extension, size FROM folder_task_items WHERE task_id = ?1 AND status = 'pending'",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u64>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let (mut selected, mut selected_bytes, mut excluded, mut by_extension, mut by_pattern) =
        (0, 0, 0, 0, 0);
    for row in rows {
        let (relative_path, extension, size) = row.map_err(|error| error.to_string())?;
        let extension_included = included.contains(&extension.to_ascii_lowercase());
        let path_excluded = exclusions
            .matched_path_or_any_parents(Path::new(&relative_path), false)
            .is_ignore();
        if extension_included && !path_excluded {
            selected += 1;
            selected_bytes += size;
        } else {
            excluded += 1;
            if !extension_included {
                by_extension += 1;
            }
            if path_excluded {
                by_pattern += 1;
            }
        }
    }
    Ok((selected, selected_bytes, excluded, by_extension, by_pattern))
}

fn plan_confirmation_token(task_id: &str, inventory_fingerprint: &str, plan_json: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(task_id.as_bytes());
    digest.update([0]);
    digest.update(inventory_fingerprint.as_bytes());
    digest.update([0]);
    digest.update(plan_json.as_bytes());
    let hash = format!("{:x}", digest.finalize());
    format!("confirm-{}", &hash[..32])
}

fn scan_inventory(
    task_id: &str,
    root: &Path,
) -> Result<(FolderInventory, Vec<FolderTaskItem>), String> {
    let mut inventory = FolderInventory::default();
    let mut items = Vec::new();
    let mut groups = BTreeSet::new();
    let mut visited_entries = 0_usize;
    let mut visited_files = 0_usize;
    let excluded_root = root.to_path_buf();
    let depth_was_truncated = Arc::new(AtomicBool::new(false));
    let depth_flag = Arc::clone(&depth_was_truncated);
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .follow_links(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .filter_entry(move |entry| {
            let depth = entry
                .path()
                .strip_prefix(&excluded_root)
                .map(|path| path.components().count())
                .unwrap_or(0);
            if depth > MAX_SCAN_DEPTH {
                depth_flag.store(true, Ordering::Relaxed);
                return false;
            }
            !is_excluded_entry(&excluded_root, entry.path())
        })
        .build();

    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                inventory.warnings.push(error.to_string());
                continue;
            }
        };
        let path = entry.path();
        if path == root {
            continue;
        }
        visited_entries += 1;
        if visited_entries > MAX_SCAN_ENTRIES {
            inventory.truncated = true;
            inventory
                .truncation_reasons
                .push(format!("Directory entries exceeded {MAX_SCAN_ENTRIES}"));
            break;
        }
        let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
        let relative_path = portable_path(relative);
        if let Some(first) = relative.components().next() {
            groups.insert(first.as_os_str().to_string_lossy().to_string());
        }
        let file_type = match entry.file_type() {
            Some(value) => value,
            None => continue,
        };
        if file_type.is_dir() {
            inventory.directories += 1;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        visited_files += 1;
        if visited_files > MAX_SCAN_FILES {
            inventory.truncated = true;
            inventory
                .truncation_reasons
                .push(format!("File count exceeded {MAX_SCAN_FILES}"));
            break;
        }
        let metadata = match entry.metadata() {
            Ok(value) => value,
            Err(error) => {
                inventory.warnings.push(format!("{relative_path}: {error}"));
                continue;
            }
        };
        if metadata.len() > MAX_SCAN_SINGLE_FILE_BYTES {
            inventory.truncated = true;
            inventory.truncation_reasons.push(format!(
                "Skipped {relative_path}: file exceeds {MAX_SCAN_SINGLE_FILE_BYTES} bytes"
            ));
            continue;
        }
        if inventory.total_bytes.saturating_add(metadata.len()) > MAX_SCAN_TOTAL_BYTES {
            inventory.truncated = true;
            inventory.truncation_reasons.push(format!(
                "Total scanned bytes exceeded {MAX_SCAN_TOTAL_BYTES}"
            ));
            break;
        }
        let extension = normalized_extension(path);
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);
        let content_hash = match sha256_file(path) {
            Ok(value) => value,
            Err(error) => {
                inventory
                    .warnings
                    .push(format!("Unable to hash {relative_path}: {error}"));
                continue;
            }
        };
        let metadata_after_hash = match fs::metadata(path) {
            Ok(value) => value,
            Err(error) => {
                inventory
                    .warnings
                    .push(format!("Unable to recheck {relative_path}: {error}"));
                continue;
            }
        };
        let modified_after_hash = metadata_after_hash
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);
        if metadata_after_hash.len() != metadata.len() || modified_after_hash != modified_at {
            inventory.warnings.push(format!(
                "Skipped {relative_path}: file changed while the inventory was being hashed"
            ));
            continue;
        }
        inventory.files += 1;
        inventory.total_bytes = inventory.total_bytes.saturating_add(metadata.len());
        *inventory
            .extension_counts
            .entry(extension.clone())
            .or_insert(0) += 1;
        if is_model_readable_extension(&extension) {
            inventory.readable_files += 1;
        } else if is_external_image_extension(&extension) {
            inventory.external_files += 1;
        } else {
            inventory.attention_files += 1;
        }
        let estimated_characters = estimate_characters(&extension, metadata.len());
        items.push(FolderTaskItem {
            id: format!("{task_id}:{}", items.len() + 1),
            relative_path,
            size: metadata.len(),
            modified_at,
            extension,
            content_hash: content_hash.clone(),
            estimated_characters,
            status: "pending".into(),
            attempts: 0,
            result: None,
            error: None,
            provenance: FolderTaskProvenance {
                relative_path: String::new(),
                source_hash: content_hash,
                size: metadata.len(),
                modified_at,
                parser: parser_name_for_extension(&normalized_extension(path)).into(),
                parser_version: "folder-task-v3".into(),
                extraction: None,
            },
        });
    }
    items.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    for item in &mut items {
        item.provenance.relative_path = item.relative_path.clone();
    }
    let mut fingerprint = Sha256::new();
    for item in &items {
        fingerprint.update(item.relative_path.as_bytes());
        fingerprint.update([0]);
        fingerprint.update(item.content_hash.as_bytes());
        fingerprint.update(item.size.to_le_bytes());
        fingerprint.update(item.modified_at.to_le_bytes());
    }
    inventory.top_level_groups = groups.len() as u64;
    inventory.fingerprint = format!("sha256-{:x}", fingerprint.finalize());
    if depth_was_truncated.load(Ordering::Relaxed) {
        inventory.truncated = true;
        inventory
            .truncation_reasons
            .push(format!("Folder depth exceeded {MAX_SCAN_DEPTH}"));
    }
    if inventory.files == 0 {
        inventory
            .warnings
            .push("The selected folder contains no processable files".into());
    }
    if inventory.warnings.len() > 100 {
        let omitted = inventory.warnings.len() - 100;
        inventory.warnings.truncate(100);
        inventory
            .warnings
            .push(format!("{omitted} additional scan warnings omitted"));
    }
    Ok((inventory, items))
}

fn scan_selected_inventory(
    task_id: &str,
    root: &Path,
    source_paths: &[PathBuf],
) -> Result<(FolderInventory, Vec<FolderTaskItem>), String> {
    if source_paths.len() > MAX_SCAN_FILES {
        return Err(format!(
            "Document selection cannot exceed {MAX_SCAN_FILES} files"
        ));
    }
    let root = fs::canonicalize(root)
        .map_err(|error| format!("Selected document folder is not accessible: {error}"))?;
    let root_text = root.to_string_lossy();
    let mut inventory = FolderInventory::default();
    let mut items = Vec::new();
    let mut groups = BTreeSet::new();
    let mut seen = BTreeSet::new();
    for source in source_paths {
        let relative = validate_relative_path(&portable_path(source))?;
        let relative_path = portable_path(&relative);
        if !seen.insert(relative_path.clone()) {
            continue;
        }
        let path = resolve_in_workspace(&relative_path, &root_text, false)?;
        if !path.is_file() {
            inventory.warnings.push(format!(
                "Selected document is not a regular file: {relative_path}"
            ));
            continue;
        }
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Unable to inspect {relative_path}: {error}"))?;
        if metadata.len() > MAX_SCAN_SINGLE_FILE_BYTES {
            inventory.truncated = true;
            inventory.truncation_reasons.push(format!(
                "Skipped {relative_path}: file exceeds {MAX_SCAN_SINGLE_FILE_BYTES} bytes"
            ));
            continue;
        }
        if inventory.total_bytes.saturating_add(metadata.len()) > MAX_SCAN_TOTAL_BYTES {
            inventory.truncated = true;
            inventory.truncation_reasons.push(format!(
                "Total selected bytes exceeded {MAX_SCAN_TOTAL_BYTES}"
            ));
            break;
        }
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);
        let content_hash = sha256_file(&path)
            .map_err(|error| format!("Unable to hash {relative_path}: {error}"))?;
        let metadata_after_hash = fs::metadata(&path)
            .map_err(|error| format!("Unable to recheck {relative_path}: {error}"))?;
        let modified_after_hash = metadata_after_hash
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);
        if metadata_after_hash.len() != metadata.len() || modified_after_hash != modified_at {
            inventory.warnings.push(format!(
                "Skipped {relative_path}: file changed while the inventory was being hashed"
            ));
            continue;
        }
        let extension = normalized_extension(&path);
        inventory.files += 1;
        inventory.total_bytes = inventory.total_bytes.saturating_add(metadata.len());
        *inventory
            .extension_counts
            .entry(extension.clone())
            .or_insert(0) += 1;
        if is_model_readable_extension(&extension) {
            inventory.readable_files += 1;
        } else if is_external_image_extension(&extension) {
            inventory.external_files += 1;
        } else {
            inventory.attention_files += 1;
        }
        if let Some(group) = relative.components().next() {
            groups.insert(group.as_os_str().to_string_lossy().to_string());
        }
        items.push(FolderTaskItem {
            id: format!("{task_id}:{}", items.len() + 1),
            relative_path: relative_path.clone(),
            size: metadata.len(),
            modified_at,
            extension: extension.clone(),
            content_hash: content_hash.clone(),
            estimated_characters: estimate_characters(&extension, metadata.len()),
            status: "pending".into(),
            attempts: 0,
            result: None,
            error: None,
            provenance: FolderTaskProvenance {
                relative_path,
                source_hash: content_hash,
                size: metadata.len(),
                modified_at,
                parser: parser_name_for_extension(&extension).into(),
                parser_version: "folder-task-v3".into(),
                extraction: None,
            },
        });
    }
    items.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    let mut fingerprint = Sha256::new();
    for item in &items {
        fingerprint.update(item.relative_path.as_bytes());
        fingerprint.update([0]);
        fingerprint.update(item.content_hash.as_bytes());
        fingerprint.update(item.size.to_le_bytes());
        fingerprint.update(item.modified_at.to_le_bytes());
    }
    inventory.top_level_groups = groups.len() as u64;
    inventory.fingerprint = format!("sha256-{:x}", fingerprint.finalize());
    if inventory.files == 0 {
        inventory
            .warnings
            .push("The selected documents contain no processable files".into());
    }
    Ok((inventory, items))
}

fn is_excluded_entry(root: &Path, path: &Path) -> bool {
    if path == root {
        return false;
    }
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    if matches!(
        name,
        ".solidify" | ".git" | "node_modules" | "$RECYCLE.BIN" | "System Volume Information"
    ) {
        return true;
    }
    name.starts_with("~$") || name.starts_with("._") || matches!(name, ".DS_Store" | "Thumbs.db")
}

fn normalized_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| "(none)".into())
}

fn sha256_file(path: &Path) -> Result<String, std::io::Error> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn estimate_characters(extension: &str, bytes: u64) -> u64 {
    match extension {
        "txt" | "md" | "markdown" | "csv" | "json" | "yaml" | "yml" | "xml" | "html" | "htm"
        | "log" => bytes,
        "docx" | "xlsx" | "pdf" => bytes.saturating_mul(2).min(500_000),
        _ => 0,
    }
}

fn parser_name_for_extension(extension: &str) -> &'static str {
    match extension {
        "docx" => "mammoth",
        "xlsx" => "openxml-xlsx",
        "pdf" => "pdfjs",
        "txt" | "md" | "markdown" | "csv" | "json" | "yaml" | "yml" | "xml" | "html" | "htm"
        | "log" => "browser-text",
        _ => "none",
    }
}

fn is_external_image_extension(extension: &str) -> bool {
    matches!(extension, "png" | "jpg" | "jpeg")
}

fn is_task_parseable_extension(extension: &str) -> bool {
    is_model_readable_extension(extension) || is_external_image_extension(extension)
}

fn is_model_readable_extension(extension: &str) -> bool {
    matches!(
        extension,
        "txt"
            | "md"
            | "markdown"
            | "csv"
            | "json"
            | "yaml"
            | "yml"
            | "xml"
            | "html"
            | "htm"
            | "log"
            | "docx"
            | "xlsx"
            | "pdf"
    )
}

fn portable_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn seed_inventory_decisions(
    transaction: &Transaction<'_>,
    task_id: &str,
    inventory: &FolderInventory,
    now: i64,
) -> Result<(), String> {
    if inventory.attention_files == 0 {
        return Ok(());
    }
    let extensions: Vec<Value> = inventory
        .extension_counts
        .iter()
        .filter(|(extension, _)| !is_task_parseable_extension(extension))
        .map(|(extension, count)| json!({ "extension": extension, "count": count }))
        .collect();
    insert_decision(
        transaction,
        task_id,
        NewDecisionRequest {
            kind: "unsupported_formats".into(),
            title: format!("{} 个文件需要特殊处理", inventory.attention_files),
            description: "这些格式不能由当前内置文本提取器可靠读取。请选择本任务的统一处理方式。"
                .into(),
            evidence: json!({ "extensions": extensions }),
            options: vec![
                DecisionOption {
                    id: "skip".into(),
                    label: "跳过并继续".into(),
                    description: "记录不支持的文件清单，其余文档继续由 AI 处理。".into(),
                },
                DecisionOption {
                    id: "attempt_external".into(),
                    label: "等待格式转换".into(),
                    description: "保留为技术待处理项，配置转换或解析能力后再让 AI 读取。".into(),
                },
            ],
            recommended_option_id: Some("skip".into()),
            affected_item_ids: Vec::new(),
            apply_key: Some("unsupported_format_policy".into()),
        },
        now,
    )?;
    Ok(())
}

fn list_folder_tasks_impl(manager: &FolderTaskManager) -> Result<Vec<FolderTaskSummary>, String> {
    let connection = manager.connection()?;
    let mut statement = connection
        .prepare("SELECT id FROM folder_tasks ORDER BY updated_at DESC")
        .map_err(|error| error.to_string())?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    ids.iter().map(|id| get_summary(&connection, id)).collect()
}

fn get_folder_task_impl(
    manager: &FolderTaskManager,
    task_id: &str,
) -> Result<FolderTaskDetail, String> {
    validate_id(task_id)?;
    let connection = manager.connection()?;
    let summary = get_summary(&connection, task_id)?;
    let (plan_json, confirmed_plan_hash, result_revision): (String, Option<String>, i64) = connection
        .query_row(
            "SELECT plan_json, confirmed_plan_hash, result_revision FROM folder_tasks WHERE id = ?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| map_not_found(error, "Folder task"))?;
    let mut plan: FolderTaskPlan = from_json(&plan_json, "folder task plan")?;
    plan.normalize_legacy(&summary.goal)?;
    let decisions = list_decisions(&connection, task_id)?;
    let recent_events = list_events(&connection, task_id, 100)?;
    let active_batch = get_active_batch(&connection, task_id)?;
    let recent_runs = list_runs(&connection, task_id, 20)?;
    let latest_output = connection.query_row(
        "SELECT format, relative_path, content_hash, item_count, created_at, result_revision FROM folder_task_outputs WHERE task_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1",
        [task_id],
        |row| {
            let output_revision = row.get(5)?;
            Ok(FolderTaskOutput {
                format: row.get(0)?,
                relative_path: row.get(1)?,
                content_hash: row.get(2)?,
                item_count: row.get(3)?,
                created_at: row.get(4)?,
                result_revision: output_revision,
                is_current: output_revision == result_revision,
            })
        },
    ).optional().map_err(|error| error.to_string())?;
    Ok(FolderTaskDetail {
        summary,
        plan,
        decisions,
        recent_events,
        active_batch,
        recent_runs,
        confirmed_plan_hash,
        latest_output,
    })
}

fn list_folder_task_items_impl(
    manager: &FolderTaskManager,
    task_id: &str,
    status: Option<&str>,
    offset: u32,
    limit: u32,
) -> Result<Vec<FolderTaskItem>, String> {
    validate_id(task_id)?;
    if limit == 0 || limit > 200 {
        return Err("Item page limit must be between 1 and 200".into());
    }
    if let Some(status) = status {
        validate_item_status_filter(status)?;
    }
    let connection = manager.connection()?;
    let ids = if let Some(status) = status {
        let mut statement = connection
            .prepare(
                "SELECT id FROM folder_task_items WHERE task_id = ?1 AND status = ?2
                 ORDER BY relative_path LIMIT ?3 OFFSET ?4",
            )
            .map_err(|error| error.to_string())?;
        let ids = statement
            .query_map(params![task_id, status, limit, offset], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        ids
    } else {
        let mut statement = connection
            .prepare(
                "SELECT id FROM folder_task_items WHERE task_id = ?1
                 ORDER BY CASE status WHEN 'failed' THEN 0 WHEN 'pending_decision' THEN 1 WHEN 'manual_review' THEN 2 WHEN 'awaiting_external_parser' THEN 3 WHEN 'processing' THEN 4 ELSE 5 END,
                 relative_path LIMIT ?2 OFFSET ?3",
            )
            .map_err(|error| error.to_string())?;
        let ids = statement
            .query_map(params![task_id, limit, offset], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        ids
    };
    ids.iter()
        .map(|item_id| get_item(&connection, task_id, item_id))
        .collect()
}

fn validate_item_status_filter(status: &str) -> Result<(), String> {
    if matches!(
        status,
        "pending"
            | "processing"
            | "completed"
            | "skipped"
            | "failed"
            | "pending_decision"
            | "manual_review"
            | "awaiting_external_parser"
    ) {
        Ok(())
    } else {
        Err("Unsupported folder task item status".into())
    }
}

fn get_summary(connection: &Connection, task_id: &str) -> Result<FolderTaskSummary, String> {
    let row = connection
        .query_row(
            "SELECT name, goal, root_path, status, recipe, inventory_json, created_at, updated_at, revision
             FROM folder_tasks WHERE id = ?1",
            [task_id],
            |row| Ok((
                row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?, row.get::<_, i64>(7)?, row.get::<_, u64>(8)?,
            )),
        )
        .map_err(|error| map_not_found(error, "Folder task"))?;
    let progress = progress(connection, task_id)?;
    let pending_decisions = connection
        .query_row(
            "SELECT COUNT(*) FROM folder_task_decisions WHERE task_id = ?1 AND status = 'pending'",
            [task_id],
            |value| value.get::<_, u64>(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(FolderTaskSummary {
        id: task_id.to_string(),
        name: row.0,
        goal: row.1,
        root_path: row.2,
        status: FolderTaskStatus::parse(&row.3)?,
        recipe: row.4,
        inventory: from_json(&row.5, "folder inventory")?,
        progress,
        pending_decisions,
        created_at: row.6,
        updated_at: row.7,
        revision: row.8,
    })
}

fn progress(connection: &Connection, task_id: &str) -> Result<FolderTaskProgress, String> {
    let mut result = FolderTaskProgress::default();
    let mut statement = connection
        .prepare(
            "SELECT status, COUNT(*) FROM folder_task_items WHERE task_id = ?1 GROUP BY status",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([task_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (status, count) = row.map_err(|error| error.to_string())?;
        match status.as_str() {
            "pending" => result.pending = count,
            "processing" => result.processing = count,
            "completed" => result.completed = count,
            "skipped" => result.skipped = count,
            "failed" => result.failed = count,
            "pending_decision" => result.pending_decision = count,
            "manual_review" => result.manual_review = count,
            "awaiting_external_parser" => result.awaiting_external_parser = count,
            _ => {}
        }
    }
    Ok(result)
}

fn claim_folder_task_batch_impl(
    manager: &FolderTaskManager,
    task_id: &str,
    run_id: &str,
    limit: u32,
) -> Result<FolderTaskBatchClaim, String> {
    let _mutation = manager.executions.mutation_when_idle(task_id).map_err(|error| error.to_string())?;
    validate_id(task_id)?;
    validate_id(run_id)?;
    if limit == 0 || limit > MAX_BATCH_SIZE {
        return Err(format!(
            "Batch limit must be between 1 and {MAX_BATCH_SIZE}"
        ));
    }
    let mut connection = manager.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let now = now_ms()?;
    release_expired_batches(&transaction, task_id, now)?;
    let (status, _) = current_status_and_revision(&transaction, task_id)?;
    if status != FolderTaskStatus::Running {
        return Err(format!("Folder task is {}, not running", status.as_str()));
    }
    if let Some(batch) = get_active_batch(&transaction, task_id)? {
        if batch.run_id != run_id {
            return Err("Another Agent run owns the active folder-task batch".into());
        }
        let owner: Option<String> = transaction.query_row("SELECT owner_instance_id FROM folder_task_batches WHERE id = ?1", [&batch.id], |row| row.get(0)).map_err(|error| error.to_string())?;
        if owner.as_deref() != Some(manager.instance_id.as_str()) {
            return Err("Active batch belongs to another or previous application instance; wait for lease recovery".into());
        }
        transaction
            .execute(
                "UPDATE folder_task_batches SET lease_expires_at = ?1 WHERE id = ?2 AND status = 'active'",
                params![now + BATCH_LEASE_MS, batch.id],
            )
            .map_err(|error| error.to_string())?;
        let refreshed = get_batch(&transaction, &batch.id)?;
        let items = refreshed
            .item_ids
            .iter()
            .map(|id| get_item(&transaction, task_id, id))
            .collect::<Result<Vec<_>, _>>()?;
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(FolderTaskBatchClaim {
            batch: Some(refreshed),
            items,
        });
    }
    let plan_json: String = transaction
        .query_row(
            "SELECT plan_json FROM folder_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| map_not_found(error, "Folder task"))?;
    let plan: FolderTaskPlan = from_json(&plan_json, "folder task plan")?;
    let mut statement = transaction
        .prepare(
            "SELECT id, size, estimated_characters FROM folder_task_items WHERE task_id = ?1 AND status = 'pending'
             ORDER BY relative_path LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let candidates = statement
        .query_map(params![task_id, limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u64>(1)?,
                row.get::<_, u64>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    let mut ids = Vec::new();
    let mut batch_bytes = 0_u64;
    let mut batch_characters = 0_u64;
    for (id, size, estimated_characters) in candidates {
        let would_exceed = batch_bytes.saturating_add(size) > plan.resource_limits.max_batch_bytes
            || batch_characters.saturating_add(estimated_characters)
                > plan.resource_limits.max_batch_estimated_characters;
        if would_exceed && !ids.is_empty() {
            break;
        }
        ids.push(id);
        batch_bytes = batch_bytes.saturating_add(size);
        batch_characters = batch_characters.saturating_add(estimated_characters);
    }
    if ids.is_empty() {
        let processing: u64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM folder_task_items WHERE task_id = ?1 AND status = 'processing'",
                [task_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if processing == 0 {
            let pending_decisions = count_pending_decisions(&transaction, task_id)?;
            if pending_decisions > 0 {
                transition_task_status(
                    &transaction,
                    task_id,
                    FolderTaskStatus::AwaitingDecision,
                    "task.awaiting_decision",
                    now,
                )?;
            } else {
                let orphaned: u64 = transaction
                    .query_row(
                        "SELECT COUNT(*) FROM folder_task_items WHERE task_id = ?1 AND status = 'pending_decision'",
                        [task_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                if orphaned > 0 {
                    return Err(
                        "Task contains decision-bound items without a pending decision".into(),
                    );
                }
                transition_task_after_processing(&transaction, task_id, now)?;
            }
        }
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(FolderTaskBatchClaim {
            batch: None,
            items: Vec::new(),
        });
    }

    let batch_id = new_id("fbatch")?;
    let lease_token = format!("flease-{}", Uuid::new_v4());
    let run_changed = transaction
        .execute(
            "INSERT INTO folder_task_runs(run_id, task_id, status, started_at, updated_at)
             VALUES (?1, ?2, 'active', ?3, ?3)
             ON CONFLICT(run_id) DO UPDATE SET status = 'active', error = NULL, updated_at = excluded.updated_at, completed_at = NULL
             WHERE folder_task_runs.task_id = excluded.task_id",
            params![run_id, task_id, now],
        )
        .map_err(|error| error.to_string())?;
    if run_changed != 1 {
        return Err("Run ID belongs to another folder task".into());
    }
    transaction
        .execute(
            "INSERT INTO folder_task_batches(id, task_id, run_id, lease_token, status, item_ids_json, lease_expires_at, created_at, owner_instance_id)
             VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, ?7, ?8)",
            params![batch_id, task_id, run_id, lease_token, to_json(&ids)?, now + BATCH_LEASE_MS, now, manager.instance_id],
        )
        .map_err(|error| error.to_string())?;
    for id in &ids {
        transaction
            .execute(
                "UPDATE folder_task_items SET status = 'processing', attempts = attempts + 1, extraction_json = NULL WHERE id = ?1 AND task_id = ?2 AND status = 'pending'",
                params![id, task_id],
            )
            .map_err(|error| error.to_string())?;
    }
    for (ordinal, id) in ids.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO folder_task_batch_items(batch_id, item_id, ordinal) VALUES (?1, ?2, ?3)",
                params![batch_id, id, ordinal as u32],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction
        .execute(
            "UPDATE folder_tasks SET updated_at = ?1, revision = revision + 1 WHERE id = ?2",
            params![now, task_id],
        )
        .map_err(|error| error.to_string())?;
    append_event(
        &transaction,
        task_id,
        "batch.claimed",
        json!({ "batchId": batch_id, "runId": run_id, "itemIds": ids, "batchBytes": batch_bytes, "estimatedCharacters": batch_characters, "leaseExpiresAt": now + BATCH_LEASE_MS }),
        now,
    )?;
    let items = ids
        .iter()
        .map(|id| get_item(&transaction, task_id, id))
        .collect::<Result<Vec<_>, _>>()?;
    let batch = get_batch(&transaction, &batch_id)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(FolderTaskBatchClaim {
        batch: Some(batch),
        items,
    })
}

fn update_folder_task_batch_impl(
    manager: &FolderTaskManager,
    task_id: &str,
    run_id: &str,
    batch_token: &str,
    updates: Vec<FolderTaskItemUpdate>,
    checkpoint_note: Option<String>,
    checkpoint_mode: &str,
) -> Result<FolderTaskDetail, String> {
    let _mutation = manager.executions.mutation_when_idle(task_id).map_err(|error| error.to_string())?;
    validate_id(task_id)?;
    validate_id(run_id)?;
    validate_id(batch_token)?;
    if !matches!(checkpoint_mode, "complete" | "interrupted") {
        return Err("Checkpoint mode must be complete or interrupted".into());
    }
    if updates.is_empty() || updates.len() > MAX_BATCH_SIZE as usize {
        return Err(format!(
            "A batch update must contain 1 to {MAX_BATCH_SIZE} items"
        ));
    }
    let mut seen = BTreeSet::new();
    for update in &updates {
        if !seen.insert(update.item_id.clone()) {
            return Err(format!("Duplicate item update: {}", update.item_id));
        }
        if !matches!(update.status.as_str(), "completed" | "skipped" | "failed" | "awaiting_external_parser") {
            return Err(format!("Unsupported item status: {}", update.status));
        }
        if update.status == "awaiting_external_parser" && update.error.as_ref().map_or(true, |error| error.trim().is_empty()) {
            return Err("Items awaiting an external parser require an explicit error/reason".into());
        }
    }
    let mut connection = manager.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let now = now_ms()?;
    release_expired_batches(&transaction, task_id, now)?;
    let (status, _) = current_status_and_revision(&transaction, task_id)?;
    if status != FolderTaskStatus::Running && status != FolderTaskStatus::AwaitingDecision {
        return Err(format!(
            "Folder task cannot accept item updates while {}",
            status.as_str()
        ));
    }
    let batch = require_active_batch(&transaction, &manager.instance_id, task_id, run_id, batch_token, now)?;
    let batch_ids = batch.item_ids.iter().cloned().collect::<BTreeSet<_>>();
    let mut processing_ids = BTreeSet::new();
    for item_id in &batch.item_ids {
        let status = transaction
            .query_row(
                "SELECT status FROM folder_task_items WHERE task_id = ?1 AND id = ?2",
                params![task_id, item_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| map_not_found(error, "Folder task item"))?;
        if status == "processing" {
            processing_ids.insert(item_id.clone());
        }
    }
    if checkpoint_mode == "complete" && seen != processing_ids {
        return Err(
            "A complete checkpoint must update every item in the claimed batch exactly once".into(),
        );
    }
    if !seen.is_subset(&batch_ids) {
        return Err("Checkpoint contains an item outside the active batch".into());
    }
    let plan_json: String = transaction
        .query_row(
            "SELECT plan_json FROM folder_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| map_not_found(error, "Folder task"))?;
    let plan: FolderTaskPlan = from_json(&plan_json, "folder task plan")?;
    for update in &updates {
        if update.status == "completed" {
            let result = update.result.as_ref().ok_or_else(|| {
                format!(
                    "Completed item {} requires a structured result",
                    update.item_id
                )
            })?;
            validate_recipe_result(&plan.recipe, &plan.recipe_plan, result)?;
        }
        let changed = transaction
            .execute(
                "UPDATE folder_task_items SET status = ?1, result_json = ?2, error = ?3
                 WHERE id = ?4 AND task_id = ?5 AND status = 'processing'",
                params![
                    update.status,
                    update.result.as_ref().map(Value::to_string),
                    update.error,
                    update.item_id,
                    task_id,
                ],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err(format!(
                "Item {} is not claimed by the current task",
                update.item_id
            ));
        }
    }
    if checkpoint_mode == "interrupted" {
        for item_id in batch_ids.difference(&seen) {
            transaction
                .execute(
                    "UPDATE folder_task_items SET status = 'pending' WHERE id = ?1 AND task_id = ?2 AND status = 'processing'",
                    params![item_id, task_id],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    let batch_status = if checkpoint_mode == "complete" {
        "completed"
    } else {
        "interrupted"
    };
    transaction
        .execute(
            "UPDATE folder_task_batches SET status = ?1, checkpoint_note = ?2, completed_at = ?3
             WHERE id = ?4 AND status = 'active'",
            params![batch_status, checkpoint_note, now, batch.id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE folder_task_runs SET status = ?1, updated_at = ?2, completed_at = ?2 WHERE run_id = ?3 AND task_id = ?4",
            params![batch_status, now, run_id, task_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE folder_tasks SET updated_at = ?1, revision = revision + 1, result_revision = result_revision + 1 WHERE id = ?2",
            params![now, task_id],
        )
        .map_err(|error| error.to_string())?;
    append_event(
        &transaction,
        task_id,
        "batch.checkpointed",
        json!({
            "batchId": batch.id,
            "runId": run_id,
            "mode": checkpoint_mode,
            "updates": updates.iter().map(|item| json!({ "itemId": item.item_id, "status": item.status })).collect::<Vec<_>>(),
            "note": checkpoint_note,
        }),
        now,
    )?;
    let unfinished: u64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM folder_task_items WHERE task_id = ?1 AND status IN ('pending', 'processing', 'pending_decision')",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let pending_decisions = count_pending_decisions(&transaction, task_id)?;
    if pending_decisions > 0 {
        transition_task_status(
            &transaction,
            task_id,
            FolderTaskStatus::AwaitingDecision,
            "task.awaiting_decision",
            now,
        )?;
    } else if unfinished == 0 {
        transition_task_after_processing(&transaction, task_id, now)?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    get_folder_task_impl(manager, task_id)
}

fn get_batch(connection: &Connection, batch_id: &str) -> Result<FolderTaskBatch, String> {
    connection
        .query_row(
            "SELECT id, task_id, run_id, lease_token, status, item_ids_json, lease_expires_at, created_at, completed_at
             FROM folder_task_batches WHERE id = ?1",
            [batch_id],
            |row| Ok((
                row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?, row.get::<_, i64>(7)?, row.get::<_, Option<i64>>(8)?,
            )),
        )
        .map_err(|error| map_not_found(error, "Folder task batch"))
        .and_then(|row| Ok(FolderTaskBatch {
            id: row.0,
            task_id: row.1,
            run_id: row.2,
            lease_token: row.3,
            status: row.4,
            item_ids: from_json(&row.5, "folder task batch item IDs")?,
            lease_expires_at: row.6,
            created_at: row.7,
            completed_at: row.8,
        }))
}

fn get_active_batch(
    connection: &Connection,
    task_id: &str,
) -> Result<Option<FolderTaskBatch>, String> {
    let id = connection
        .query_row(
            "SELECT id FROM folder_task_batches WHERE task_id = ?1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
            [task_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    id.map(|value| get_batch(connection, &value)).transpose()
}

fn list_runs(
    connection: &Connection,
    task_id: &str,
    limit: u32,
) -> Result<Vec<FolderTaskRun>, String> {
    let mut statement = connection
        .prepare(
            "SELECT run_id, task_id, status, error, started_at, updated_at, completed_at
             FROM folder_task_runs WHERE task_id = ?1 ORDER BY started_at DESC LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let runs = statement
        .query_map(params![task_id, limit], |row| {
            Ok(FolderTaskRun {
                run_id: row.get(0)?,
                task_id: row.get(1)?,
                status: row.get(2)?,
                error: row.get(3)?,
                started_at: row.get(4)?,
                updated_at: row.get(5)?,
                completed_at: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(runs)
}

fn require_active_batch(
    connection: &Connection,
    instance_id: &str,
    task_id: &str,
    run_id: &str,
    lease_token: &str,
    now: i64,
) -> Result<FolderTaskBatch, String> {
    let batch = get_active_batch(connection, task_id)?
        .ok_or_else(|| "No active batch is leased for this folder task".to_string())?;
    let owner: Option<String> = connection.query_row("SELECT owner_instance_id FROM folder_task_batches WHERE id = ?1", [&batch.id], |row| row.get(0)).map_err(|error| error.to_string())?;
    if owner.as_deref() != Some(instance_id) { return Err("Batch lease belongs to another application instance".into()); }
    if batch.run_id != run_id || batch.lease_token != lease_token {
        return Err("The batch lease does not belong to this Agent run".into());
    }
    if batch.lease_expires_at <= now {
        return Err("The batch lease expired; claim a fresh batch before continuing".into());
    }
    Ok(batch)
}

fn release_expired_batches(
    transaction: &Transaction<'_>,
    task_id: &str,
    now: i64,
) -> Result<(), String> {
    let mut statement = transaction
        .prepare(
            "SELECT id, run_id FROM folder_task_batches
             WHERE task_id = ?1 AND status = 'active' AND lease_expires_at <= ?2",
        )
        .map_err(|error| error.to_string())?;
    let expired = statement
        .query_map(params![task_id, now], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    for (batch_id, run_id) in expired {
        transaction
            .execute(
                "UPDATE folder_task_items SET status = 'pending'
                 WHERE task_id = ?1 AND status = 'processing' AND id IN (
                    SELECT item_id FROM folder_task_batch_items WHERE batch_id = ?2
                 )",
                params![task_id, batch_id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE folder_task_batches SET status = 'expired', completed_at = ?1 WHERE id = ?2 AND status = 'active'",
                params![now, batch_id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE folder_task_runs SET status = 'expired', error = 'Batch lease expired', updated_at = ?1, completed_at = ?1 WHERE run_id = ?2",
                params![now, run_id],
            )
            .map_err(|error| error.to_string())?;
        append_event(
            transaction,
            task_id,
            "batch.expired",
            json!({ "batchId": batch_id, "runId": run_id }),
            now,
        )?;
    }
    Ok(())
}

fn release_active_batch(
    transaction: &Transaction<'_>,
    task_id: &str,
    batch_status: &str,
    reason: &str,
) -> Result<(), String> {
    let Some(batch) = get_active_batch(transaction, task_id)? else {
        return Ok(());
    };
    let now = now_ms()?;
    transaction.execute(
        "UPDATE folder_task_items SET status = 'pending' WHERE task_id = ?1 AND status = 'processing' AND id IN (
            SELECT item_id FROM folder_task_batch_items WHERE batch_id = ?2
         )",
        params![task_id, batch.id],
    ).map_err(|error| error.to_string())?;
    transaction.execute(
        "UPDATE folder_task_batches SET status = ?1, completed_at = ?2 WHERE id = ?3 AND status = 'active'",
        params![batch_status, now, batch.id],
    ).map_err(|error| error.to_string())?;
    transaction.execute(
        "UPDATE folder_task_runs SET status = ?1, error = ?2, updated_at = ?3, completed_at = ?3 WHERE run_id = ?4",
        params![batch_status, reason, now, batch.run_id],
    ).map_err(|error| error.to_string())?;
    append_event(
        transaction,
        task_id,
        "batch.released",
        json!({
            "batchId": batch.id, "runId": batch.run_id, "reason": reason
        }),
        now,
    )
}

fn validate_recipe_result(recipe: &str, recipe_plan: &Value, value: &Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Recipe result must be a JSON object".to_string())?;
    let required_string = |field: &str| -> Result<(), String> {
        if object
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
        {
            Ok(())
        } else {
            Err(format!(
                "Recipe '{recipe}' result requires non-empty string field '{field}'"
            ))
        }
    };
    match recipe {
        "structured-extraction" => {
            required_string("summary")?;
            let facts = object
                .get("facts")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    "Structured extraction result requires array field 'facts'".to_string()
                })?;
            let fields = recipe_plan
                .get("fields")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut labels = BTreeSet::new();
            for (index, fact) in facts.iter().enumerate() {
                let item = fact
                    .as_object()
                    .ok_or_else(|| format!("facts[{index}] must be an object"))?;
                let label = item
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| format!("facts[{index}].label is required"))?;
                let value = item
                    .get("value")
                    .ok_or_else(|| format!("facts[{index}].value is required"))?;
                if !matches!(value, Value::Bool(_) | Value::Number(_))
                    && !value.as_str().is_some_and(|text| !text.trim().is_empty())
                {
                    return Err(format!(
                        "facts[{index}].value must be a non-empty string, number, or boolean"
                    ));
                }
                if item.get("evidence").is_some_and(|value| {
                    !value.as_str().is_some_and(|text| !text.trim().is_empty())
                }) {
                    return Err(format!(
                        "facts[{index}].evidence must be a non-empty string"
                    ));
                }
                let matched = fields.iter().find(|field| {
                    field
                        .get("name")
                        .and_then(Value::as_str)
                        .is_some_and(|name| name.eq_ignore_ascii_case(label))
                        || field
                            .get("aliases")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .any(|alias| alias.eq_ignore_ascii_case(label))
                });
                if !fields.is_empty() && matched.is_none() {
                    return Err(format!(
                        "facts[{index}].label is outside the confirmed plan"
                    ));
                }
                if let Some(field) = matched {
                    let name = field.get("name").and_then(Value::as_str).unwrap_or(label);
                    if !labels.insert(name.to_string()) {
                        return Err(format!("Extraction field '{name}' appears more than once"));
                    }
                    let valid_type = match field.get("type").and_then(Value::as_str) {
                        Some("string") => {
                            value.as_str().is_some_and(|text| !text.trim().is_empty())
                        }
                        Some("number") => value.is_number(),
                        Some("boolean") => value.is_boolean(),
                        _ => false,
                    };
                    if !valid_type {
                        return Err(format!(
                            "Extraction field '{name}' has the wrong value type"
                        ));
                    }
                } else {
                    labels.insert(label.to_string());
                }
            }
            for field in fields
                .iter()
                .filter(|field| field.get("required").and_then(Value::as_bool) == Some(true))
            {
                let name = field
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !labels.contains(name) {
                    return Err(format!("Missing required extraction field '{name}'"));
                }
            }
        }
        "document-review" => {
            required_string("summary")?;
            required_string("recommendation")?;
            let findings = object
                .get("findings")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    "Document review result requires array field 'findings'".to_string()
                })?;
            let rules = recipe_plan
                .get("rules")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for (index, finding) in findings.iter().enumerate() {
                let item = finding
                    .as_object()
                    .ok_or_else(|| format!("findings[{index}] must be an object"))?;
                if !matches!(
                    item.get("severity").and_then(Value::as_str),
                    Some("low" | "medium" | "high")
                ) {
                    return Err(format!("findings[{index}].severity is invalid"));
                }
                for field in ["title", "description"] {
                    if !item
                        .get(field)
                        .and_then(Value::as_str)
                        .is_some_and(|text| !text.trim().is_empty())
                    {
                        return Err(format!("findings[{index}].{field} is required"));
                    }
                }
                let rule_id = item
                    .get("ruleId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| format!("findings[{index}].ruleId is required"))?;
                let rule = rules
                    .iter()
                    .find(|rule| rule.get("id").and_then(Value::as_str) == Some(rule_id))
                    .ok_or_else(|| {
                        format!("findings[{index}].ruleId is not in the confirmed plan")
                    })?;
                if rule.get("evidenceRequired").and_then(Value::as_bool) == Some(true)
                    && !item
                        .get("evidence")
                        .and_then(Value::as_str)
                        .is_some_and(|text| !text.trim().is_empty())
                {
                    return Err(format!("findings[{index}] requires evidence"));
                }
            }
        }
        "classification" => {
            required_string("summary")?;
            required_string("category")?;
            required_string("rationale")?;
            let confidence = object
                .get("confidence")
                .and_then(Value::as_f64)
                .ok_or_else(|| {
                    "Classification result requires numeric field 'confidence'".to_string()
                })?;
            if !(0.0..=1.0).contains(&confidence) {
                return Err("Classification confidence must be between 0 and 1".into());
            }
            let category = object
                .get("category")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let allowed = recipe_plan
                .get("categories")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|value| value.get("id").and_then(Value::as_str))
                .collect::<BTreeSet<_>>();
            let unknown = recipe_plan
                .get("unknownCategory")
                .and_then(Value::as_str)
                .unwrap_or("uncertain");
            if !allowed.contains(category) && category != unknown {
                return Err(format!(
                    "Classification category '{category}' is outside the confirmed plan"
                ));
            }
            let threshold = recipe_plan
                .get("minimumConfidence")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            if confidence < threshold && category != unknown {
                return Err(format!(
                    "Classification confidence below {threshold} must use category '{unknown}'"
                ));
            }
        }
        _ => return Err(format!("Unsupported folder task recipe: {recipe}")),
    }
    Ok(())
}

#[cfg(test)]
fn finish_folder_task_run_impl(
    manager: &FolderTaskManager,
    task_id: &str,
    run_id: &str,
    outcome: &str,
    error: Option<String>,
) -> Result<FolderTaskDetail, String> {
    finish_folder_task_run_with_progress(manager, task_id, run_id, outcome, error, |_| {})
}

fn finish_folder_task_run_with_progress(
    manager: &FolderTaskManager,
    task_id: &str,
    run_id: &str,
    outcome: &str,
    error: Option<String>,
    on_stopping: impl Fn(bool),
) -> Result<FolderTaskDetail, String> {
    validate_id(task_id)?;
    validate_id(run_id)?;
    if !matches!(outcome, "completed" | "failed" | "aborted") {
        return Err("Run outcome must be completed, failed, or aborted".into());
    }
    let mutation = if outcome == "completed" {
        manager.executions.mutation_when_idle(task_id)
    } else {
        manager.executions.mutation_for_stop(task_id)
    }.map_err(|error| error.to_string())?;
    // Validate identity before recording cancellation. Close this connection
    // before waiting: never hold a SQLite transaction while reaping processes.
    {
        let connection = manager.connection()?;
        current_status_and_revision(&connection, task_id)?;
        let owner: Option<String> = connection.query_row(
            "SELECT task_id FROM folder_task_runs WHERE run_id = ?1", [run_id], |row| row.get(0),
        ).optional().map_err(|error| error.to_string())?;
        if owner.is_some_and(|owner| owner != task_id) {
            return Err("Run ID belongs to another folder task".into());
        }
    }
    if outcome != "completed" {
        mutation.cancel_run_and_wait(run_id, on_stopping).map_err(|error| error.to_string())?;
    }
    let mut connection = manager.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let now = now_ms()?;
    let (task_status, _) = current_status_and_revision(&transaction, task_id)?;
    let existing_run_task = transaction
        .query_row(
            "SELECT task_id FROM folder_task_runs WHERE run_id = ?1",
            [run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if existing_run_task.is_some_and(|owner| owner != task_id) {
        return Err("Run ID belongs to another folder task".into());
    }
    let mut effective_outcome = outcome.to_string();
    let mut effective_error = error;
    let active_batch = get_active_batch(&transaction, task_id)?;
    let had_active_batch = active_batch.is_some();
    let completed_batch_for_run = transaction
        .query_row(
            "SELECT 1 FROM folder_task_batches WHERE task_id = ?1 AND run_id = ?2 AND status = 'completed' LIMIT 1",
            params![task_id, run_id],
            |_| Ok(true),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or(false);
    let may_transition_task = active_batch
        .as_ref()
        .map_or(true, |batch| batch.run_id == run_id);
    if let Some(batch) = active_batch {
        if batch.run_id == run_id {
            let paused_for_decision =
                outcome == "completed" && task_status == FolderTaskStatus::AwaitingDecision;
            if outcome == "completed" && !paused_for_decision {
                effective_outcome = "failed".into();
                effective_error =
                    Some("Agent run ended before checkpointing its active batch".into());
            }
            transaction.execute(
                "UPDATE folder_task_items SET status = 'pending' WHERE task_id = ?1 AND status = 'processing' AND id IN (
                    SELECT item_id FROM folder_task_batch_items WHERE batch_id = ?2
                 )",
                params![task_id, batch.id],
            ).map_err(|error| error.to_string())?;
            transaction.execute(
                "UPDATE folder_task_batches SET status = ?1, completed_at = ?2 WHERE id = ?3 AND status = 'active'",
                params![if paused_for_decision || effective_outcome == "aborted" { "interrupted" } else { "failed" }, now, batch.id],
            ).map_err(|error| error.to_string())?;
            append_event(
                &transaction,
                task_id,
                "batch.released",
                json!({
                    "batchId": batch.id,
                    "runId": run_id,
                    "outcome": if paused_for_decision { "decision_pause" } else { effective_outcome.as_str() }
                }),
                now,
            )?;
        }
    }
    // A run can reach this boundary without an active lease (for example when
    // a model stops after reading context or after a failed claim). Do not let
    // that text-only stop be recorded as a successful FolderTask run while the
    // durable task is still waiting for its plan or has runnable work. A run
    // that already checkpointed its one allowed batch is valid even when a
    // later batch remains for the automatic runner. The active-batch case
    // above already applies the stricter checkpoint rule; this closes only
    // the complementary no-claim/no-batch gap.
    if outcome == "completed"
        && !had_active_batch
        && !completed_batch_for_run
        && may_transition_task
    {
        let progress = progress(&transaction, task_id)?;
        let incomplete_stage = match task_status {
            FolderTaskStatus::AwaitingPlanConfirmation => {
                Some("Agent run ended before confirming the FolderTask plan".to_string())
            }
            FolderTaskStatus::Running
                if progress.pending > 0
                    || progress.processing > 0
                    || progress.pending_decision > 0 =>
            {
                Some(
                    "Agent run ended before claiming or checkpointing all FolderTask work"
                        .to_string(),
                )
            }
            _ => None,
        };
        if let Some(message) = incomplete_stage {
            effective_outcome = "failed".into();
            effective_error = Some(message);
        }
    }
    let run_changed = transaction.execute(
        "INSERT INTO folder_task_runs(run_id, task_id, status, error, started_at, updated_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5)
         ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, error = excluded.error, updated_at = excluded.updated_at, completed_at = excluded.completed_at
         WHERE folder_task_runs.task_id = excluded.task_id",
        params![run_id, task_id, effective_outcome, effective_error, now],
    ).map_err(|error| error.to_string())?;
    if run_changed != 1 {
        return Err("Run ID belongs to another folder task".into());
    }
    if effective_outcome == "failed" && may_transition_task {
        transaction.execute(
            "UPDATE folder_tasks SET status = 'failed', updated_at = ?1, revision = revision + 1 WHERE id = ?2 AND status = 'running'",
            params![now, task_id],
        ).map_err(|error| error.to_string())?;
        append_event(
            &transaction,
            task_id,
            "task.failed",
            json!({ "runId": run_id, "error": effective_error }),
            now,
        )?;
    } else if effective_outcome == "aborted" && may_transition_task {
        transaction.execute(
            "UPDATE folder_tasks SET status = 'paused', updated_at = ?1, revision = revision + 1 WHERE id = ?2 AND status = 'running'",
            params![now, task_id],
        ).map_err(|error| error.to_string())?;
        append_event(
            &transaction,
            task_id,
            "task.paused",
            json!({ "runId": run_id, "reason": "run_aborted" }),
            now,
        )?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    get_folder_task_impl(manager, task_id)
}

#[cfg(test)]
fn review_folder_task_items_impl(
    manager: &FolderTaskManager,
    task_id: &str,
    updates: Vec<FolderTaskReviewUpdate>,
    expected_revision: u64,
) -> Result<FolderTaskDetail, String> {
    review_folder_task_items_with_capability(manager, task_id, updates, expected_revision,
        |_| Err("OCR 组件未安装或尚未完成平台验证".into()))
}

fn review_folder_task_items_with_capability(
    manager: &FolderTaskManager,
    task_id: &str,
    updates: Vec<FolderTaskReviewUpdate>,
    expected_revision: u64,
    check_method: impl Fn(super::sandbox_exec::types::ExtractMethod) -> Result<(), String>,
) -> Result<FolderTaskDetail, String> {
    validate_id(task_id)?;
    if updates.is_empty() || updates.len() > 100 {
        return Err("Review must contain between 1 and 100 item updates".into());
    }
    let _mutation = manager.executions.mutation_when_idle(task_id).map_err(|error| error.to_string())?;
    // Filesystem reads and component hashing happen before the write transaction.
    // The fence prevents in-process task mutation/claim during this preflight;
    // revision/status are checked again in the transaction below.
    retry::validate(manager, task_id, &updates, expected_revision, check_method)?;
    let mut connection = manager.connection()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    require_status_and_revision(
        &transaction,
        task_id,
        &[
            FolderTaskStatus::Reviewing,
            FolderTaskStatus::Paused,
            FolderTaskStatus::Failed,
            FolderTaskStatus::Completed,
        ],
        expected_revision,
    )?;
    let plan_json: String = transaction
        .query_row(
            "SELECT plan_json FROM folder_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| map_not_found(error, "Folder task"))?;
    let plan: FolderTaskPlan = from_json(&plan_json, "folder task plan")?;
    let mut seen = BTreeSet::new();
    let mut retrying = false;
    for update in &updates {
        validate_id(&update.item_id)?;
        if !seen.insert(&update.item_id) {
            return Err(format!("Duplicate review item: {}", update.item_id));
        }
        match update.action.as_str() {
            "accept" => {
                let result = update
                    .result
                    .as_ref()
                    .ok_or_else(|| "Accepted review item requires a result".to_string())?;
                validate_recipe_result(&plan.recipe, &plan.recipe_plan, result)?;
                let changed = transaction.execute(
                    "UPDATE folder_task_items SET status = 'completed', result_json = ?1, error = NULL WHERE task_id = ?2 AND id = ?3 AND status IN ('completed','failed','manual_review','awaiting_external_parser')",
                    params![result.to_string(), task_id, update.item_id],
                ).map_err(|error| error.to_string())?;
                if changed != 1 {
                    return Err(format!(
                        "Item {} cannot be accepted from its current state",
                        update.item_id
                    ));
                }
            }
            "retry" => {
                retrying = true;
                let (previous_status, previous_error): (String, Option<String>) = transaction.query_row(
                    "SELECT status, error FROM folder_task_items WHERE task_id = ?1 AND id = ?2",
                    params![task_id, update.item_id], |row| Ok((row.get(0)?, row.get(1)?)),
                ).map_err(|error| error.to_string())?;
                let changed = transaction.execute(
                    "UPDATE folder_task_items SET status = 'pending', result_json = NULL, error = NULL, extraction_json = NULL WHERE task_id = ?1 AND id = ?2 AND status IN ('completed','failed','skipped','manual_review','awaiting_external_parser')",
                    params![task_id, update.item_id],
                ).map_err(|error| error.to_string())?;
                if changed != 1 {
                    return Err(format!(
                        "Item {} cannot be retried from its current state",
                        update.item_id
                    ));
                }
                append_event(&transaction, task_id, "item.retry_requested", json!({
                    "itemId": update.item_id, "previousStatus": previous_status, "previousError": previous_error,
                }), now_ms()?)?;
            }
            "skip" => {
                let changed = transaction.execute(
                    "UPDATE folder_task_items SET status = 'skipped', result_json = ?1, error = ?2 WHERE task_id = ?3 AND id = ?4 AND status != 'processing'",
                    params![json!({ "reason": "user_review" }).to_string(), update.error, task_id, update.item_id],
                ).map_err(|error| error.to_string())?;
                if changed != 1 {
                    return Err(format!(
                        "Item {} cannot be skipped from its current state",
                        update.item_id
                    ));
                }
            }
            _ => return Err(format!("Unsupported review action: {}", update.action)),
        }
    }
    let now = now_ms()?;
    transaction.execute(
        "UPDATE folder_tasks SET status = ?1, updated_at = ?2, revision = revision + 1, result_revision = result_revision + 1 WHERE id = ?3",
        params![if retrying { "running" } else { "reviewing" }, now, task_id],
    ).map_err(|error| error.to_string())?;
    append_event(
        &transaction,
        task_id,
        "items.reviewed",
        json!({
            "updates": updates.iter().map(|update| json!({ "itemId": update.item_id, "action": update.action })).collect::<Vec<_>>()
        }),
        now,
    )?;
    if !retrying && plan.output.auto_write {
        let task_progress = progress(&transaction, task_id)?;
        let unresolved = task_progress.failed
            + task_progress.manual_review
            + task_progress.awaiting_external_parser;
        if unresolved == 0 {
            match materialize_folder_task_output(&transaction, task_id, &plan, now) {
                Ok(output) => append_event(
                    &transaction,
                    task_id,
                    "output.written",
                    json!({ "output": output, "automatic": true, "afterReview": true }),
                    now,
                )?,
                Err(error) => append_event(
                    &transaction,
                    task_id,
                    "output.failed",
                    json!({ "error": error, "automatic": true, "afterReview": true }),
                    now,
                )?,
            }
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    get_folder_task_impl(manager, task_id)
}

fn write_folder_task_output_impl(
    manager: &FolderTaskManager,
    task_id: &str,
    expected_revision: u64,
) -> Result<FolderTaskDetail, String> {
    let _mutation = manager.executions.mutation_when_idle(task_id).map_err(|error| error.to_string())?;
    validate_id(task_id)?;
    let mut connection = manager.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let (status, revision) = current_status_and_revision(&transaction, task_id)?;
    if revision != expected_revision {
        return Err("Folder task changed; refresh before writing output".into());
    }
    if matches!(
        status,
        FolderTaskStatus::AwaitingPlanConfirmation | FolderTaskStatus::Running
    ) || get_active_batch(&transaction, task_id)?.is_some()
    {
        return Err("Pause or finish active processing before writing task output".into());
    }
    let plan_json: String = transaction
        .query_row(
            "SELECT plan_json FROM folder_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| map_not_found(error, "Folder task"))?;
    let plan: FolderTaskPlan = from_json(&plan_json, "folder task plan")?;
    let now = now_ms()?;
    let output = materialize_folder_task_output(&transaction, task_id, &plan, now)?;
    transaction
        .execute(
            "UPDATE folder_tasks SET updated_at = ?1, revision = revision + 1 WHERE id = ?2",
            params![now, task_id],
        )
        .map_err(|error| error.to_string())?;
    append_event(
        &transaction,
        task_id,
        "output.written",
        json!({ "output": output }),
        now,
    )?;
    transaction.commit().map_err(|error| error.to_string())?;
    get_folder_task_impl(manager, task_id)
}

fn materialize_folder_task_output(
    connection: &Connection,
    task_id: &str,
    plan: &FolderTaskPlan,
    now: i64,
) -> Result<FolderTaskOutput, String> {
    let (name, goal, root_path, inventory_json, confirmed_plan_hash, result_revision): (String, String, String, String, Option<String>, i64) = connection.query_row(
        "SELECT name, goal, root_path, inventory_json, confirmed_plan_hash, result_revision FROM folder_tasks WHERE id = ?1",
        [task_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
    ).map_err(|error| map_not_found(error, "Folder task"))?;
    let inventory: FolderInventory = from_json(&inventory_json, "folder inventory")?;
    let mut statement = connection
        .prepare("SELECT id FROM folder_task_items WHERE task_id = ?1 ORDER BY relative_path")
        .map_err(|error| error.to_string())?;
    let ids = statement
        .query_map([task_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    let items = ids
        .iter()
        .map(|id| get_item(connection, task_id, id))
        .collect::<Result<Vec<_>, _>>()?;
    let payload = build_output_payload(
        task_id,
        &name,
        &goal,
        plan,
        &inventory,
        confirmed_plan_hash.as_deref(),
        &items,
    );
    let bytes = match plan.output.format.as_str() {
        "json" => serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?,
        "xlsx" => build_xlsx_output(&payload, &items)?,
        _ => return Err("Unsupported output format".into()),
    };
    let content_hash = sha256_bytes(&bytes);
    let previous_output_hash = connection
        .query_row(
            "SELECT content_hash FROM folder_task_outputs
             WHERE task_id = ?1 AND relative_path = ?2
             ORDER BY created_at DESC, id DESC LIMIT 1",
            params![task_id, plan.output.relative_path],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    write_output_bytes(
        &root_path,
        &plan.output,
        &items,
        &bytes,
        &content_hash,
        previous_output_hash.as_deref(),
    )?;
    let output = FolderTaskOutput {
        format: plan.output.format.clone(),
        relative_path: plan.output.relative_path.clone(),
        content_hash,
        item_count: items.len() as u64,
        created_at: now,
        result_revision,
        is_current: true,
    };
    connection.execute(
        "INSERT INTO folder_task_outputs(task_id, format, relative_path, content_hash, item_count, created_at, result_revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![task_id, output.format, output.relative_path, output.content_hash, output.item_count, output.created_at, output.result_revision],
    ).map_err(|error| error.to_string())?;
    Ok(output)
}

fn build_output_payload(
    task_id: &str,
    name: &str,
    goal: &str,
    plan: &FolderTaskPlan,
    inventory: &FolderInventory,
    confirmed_plan_hash: Option<&str>,
    items: &[FolderTaskItem],
) -> Value {
    let mut status_counts = BTreeMap::<String, u64>::new();
    let mut category_counts = BTreeMap::<String, u64>::new();
    let mut severity_counts = BTreeMap::<String, u64>::new();
    for item in items {
        *status_counts.entry(item.status.clone()).or_default() += 1;
        if let Some(category) = item
            .result
            .as_ref()
            .and_then(|value| value.get("category"))
            .and_then(Value::as_str)
        {
            *category_counts.entry(category.into()).or_default() += 1;
        }
        if let Some(findings) = item
            .result
            .as_ref()
            .and_then(|value| value.get("findings"))
            .and_then(Value::as_array)
        {
            for finding in findings {
                if let Some(severity) = finding.get("severity").and_then(Value::as_str) {
                    *severity_counts.entry(severity.into()).or_default() += 1;
                }
            }
        }
    }
    let records = deterministic_records(plan, items);
    json!({
        "schemaVersion": 3,
        "task": { "id": task_id, "name": name, "goal": goal, "confirmedPlanHash": confirmed_plan_hash },
        "inventory": inventory,
        "plan": plan,
        "summary": { "total": items.len(), "statuses": status_counts, "categories": category_counts, "severities": severity_counts, "records": records.len() },
        "records": records,
        "items": items,
    })
}

fn deterministic_records(plan: &FolderTaskPlan, items: &[FolderTaskItem]) -> Vec<Value> {
    let dedupe_keys = plan
        .recipe_plan
        .get("dedupeKeys")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let canonical_labels = plan
        .recipe_plan
        .get("fields")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|field| {
            let name = field.get("name")?.as_str()?.trim().to_lowercase();
            Some((name, field))
        })
        .fold(
            BTreeMap::<String, String>::new(),
            |mut labels, (name, field)| {
                labels.insert(name.clone(), name.clone());
                for alias in field
                    .get("aliases")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    labels.insert(alias.trim().to_lowercase(), name.clone());
                }
                labels
            },
        );
    let mut positions = BTreeMap::<String, usize>::new();
    let mut records = Vec::<Value>::new();
    for item in items.iter().filter(|item| item.status == "completed") {
        let Some(result) = item.result.as_ref() else {
            continue;
        };
        let mut record = json!({ "relativePath": item.relative_path, "sourceHash": item.content_hash, "result": result, "provenance": [item.provenance] });
        if plan.recipe == "structured-extraction" && !dedupe_keys.is_empty() {
            let facts = result
                .get("facts")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let fields = facts
                .into_iter()
                .filter_map(|fact| {
                    let label = fact.get("label")?.as_str()?.trim().to_lowercase();
                    Some((
                        canonical_labels.get(&label).cloned().unwrap_or(label),
                        scalar_key(fact.get("value")?)?,
                    ))
                })
                .collect::<BTreeMap<_, _>>();
            let key = dedupe_keys
                .iter()
                .filter_map(Value::as_str)
                .map(|name| {
                    fields
                        .get(&name.trim().to_lowercase())
                        .cloned()
                        .unwrap_or_default()
                        .trim()
                        .to_lowercase()
                })
                .collect::<Vec<_>>()
                .join("\u{1f}");
            if !key.is_empty() && key.split('\u{1f}').all(|part| !part.is_empty()) {
                if let Some(position) = positions.get(&key).copied() {
                    if let Some(provenance) = records[position]
                        .get_mut("provenance")
                        .and_then(Value::as_array_mut)
                    {
                        provenance.push(json!(item.provenance));
                    }
                    continue;
                }
                positions.insert(key, records.len());
            }
        }
        records.push(record.take());
    }
    records
}

fn scalar_key(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.trim().to_lowercase()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn write_output_bytes(
    root_path: &str,
    output: &FolderTaskOutputPlan,
    items: &[FolderTaskItem],
    bytes: &[u8],
    content_hash: &str,
    previous_output_hash: Option<&str>,
) -> Result<(), String> {
    let relative = validate_relative_path(&output.relative_path)?;
    let portable = portable_path(&relative);
    if items
        .iter()
        .any(|item| item.relative_path.eq_ignore_ascii_case(&portable))
    {
        return Err("Output path must not overwrite an inventoried source file".into());
    }
    let mut target = resolve_in_workspace(&portable, root_path, true)?;
    for item in items {
        if resolve_in_workspace(&item.relative_path, root_path, false)
            .is_ok_and(|source| source == target)
        {
            return Err("Output path must not overwrite an inventoried source file".into());
        }
    }
    let parent = target
        .parent()
        .ok_or_else(|| "Output path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    target = resolve_in_workspace(&portable, root_path, true)?;
    let parent = target
        .parent()
        .ok_or_else(|| "Output path has no parent".to_string())?;
    if target.exists() {
        if !target.is_file() {
            return Err("Output path is not a regular file".into());
        }
        let existing_hash = sha256_file(&target).map_err(|error| error.to_string())?;
        if existing_hash == content_hash {
            return Ok(());
        }
        let task_owns_existing_output = previous_output_hash == Some(existing_hash.as_str());
        if !output.overwrite && !task_owns_existing_output {
            return Err("Output already exists and overwrite was not confirmed".into());
        }
    }
    let temp = parent.join(format!(".folder-task-output-{}.tmp", Uuid::new_v4()));
    let write_result = (|| -> Result<(), std::io::Error> {
        let mut file = File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp);
        return Err(error.to_string());
    }
    if target.exists() {
        let backup = parent.join(format!(".folder-task-output-{}.backup", Uuid::new_v4()));
        if let Err(error) = fs::rename(&target, &backup) {
            let _ = fs::remove_file(&temp);
            return Err(error.to_string());
        }
        if let Err(error) = fs::rename(&temp, &target) {
            let restore = fs::rename(&backup, &target);
            let _ = fs::remove_file(&temp);
            return Err(match restore {
                Ok(()) => format!("Unable to replace output; original restored: {error}"),
                Err(restore_error) => format!("Unable to replace output ({error}) and restore original ({restore_error}); backup remains at {}", backup.display()),
            });
        }
        let _ = fs::remove_file(backup);
    } else {
        fs::rename(&temp, &target).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    format!("{:x}", digest.finalize())
}

fn build_xlsx_output(payload: &Value, items: &[FolderTaskItem]) -> Result<Vec<u8>, String> {
    let summary = payload.get("summary").cloned().unwrap_or(Value::Null);
    let mut summary_rows: Vec<Vec<Value>> = vec![
        vec!["key".into(), "value".into()],
        vec!["summary".into(), summary.to_string().into()],
        vec![
            "task".into(),
            payload
                .get("task")
                .cloned()
                .unwrap_or(Value::Null)
                .to_string().into(),
        ],
    ];
    if let Some(values) = summary.as_object() {
        summary_rows = vec![vec!["指标".into(), "值".into()]];
        for (key, value) in values {
            if let Some(counts) = value.as_object() {
                for (label, count) in counts {
                    summary_rows.push(vec![format!("{key} / {label}").into(), count.clone()]);
                }
            } else {
                summary_rows.push(vec![key.clone().into(), value.clone()]);
            }
        }
    }
    let mut fields = BTreeSet::new();
    for item in items {
        if let Some(facts) = item.result.as_ref().and_then(|result| result.get("facts")).and_then(Value::as_array) {
            for fact in facts {
                if let Some(label) = fact.get("label").and_then(Value::as_str) { fields.insert(label.to_string()); }
            }
        }
    }
    let mut result_rows: Vec<Vec<Value>> = vec![vec![
        "relative_path".into(),
        "status".into(),
        "source_hash".into(),
        "摘要".into(),
        "error".into(),
        "分类".into(), "置信度".into(), "分类理由".into(), "审查发现".into(), "建议".into(),
    ]];
    for field in &fields {
        result_rows[0].push(field.clone().into());
        result_rows[0].push(format!("{field} · 原文依据").into());
    }
    result_rows[0].push("解析来源（含 OCR 页码、版本与告警）".into());
    let mut failure_rows = result_rows.clone();
    for item in items {
        let result = item.result.as_ref().unwrap_or(&Value::Null);
        let cell = |key: &str| -> Value { result.get(key).cloned().unwrap_or(Value::Null) };
        let findings = result.get("findings").and_then(Value::as_array).map(|values| values.iter().map(|finding| {
            ["severity", "title", "description", "evidence"].iter().filter_map(|key| finding.get(key).and_then(Value::as_str)).collect::<Vec<_>>().join(" · ")
        }).collect::<Vec<_>>().join("\n")).unwrap_or_default();
        let mut row = vec![
            item.relative_path.clone().into(),
            item.status.clone().into(),
            item.content_hash.clone().into(),
            cell("summary"),
            item.error.clone().unwrap_or_default().into(),
            cell("category"), cell("confidence"), cell("rationale"), findings.into(), cell("recommendation"),
        ];
        for field in &fields {
            let fact = result.get("facts").and_then(Value::as_array).and_then(|facts| facts.iter().find(|fact| fact.get("label").and_then(Value::as_str) == Some(field.as_str())));
            for key in ["value", "evidence"] {
                row.push(fact.and_then(|fact| fact.get(key)).cloned().unwrap_or(Value::Null));
            }
        }
        row.push(serde_json::to_value(&item.provenance).map_err(|error| error.to_string())?);
        result_rows.push(row.clone());
        if matches!(
            item.status.as_str(),
            "failed" | "manual_review" | "awaiting_external_parser"
        ) {
            failure_rows.push(row);
        }
    }
    let sheets = [
        ("Summary", summary_rows),
        ("Results", result_rows),
        ("Failures", failure_rows),
    ];
    let cursor = Cursor::new(Vec::<u8>::new());
    let mut archive = zip::ZipWriter::new(cursor);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let content_types = format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>{}</Types>"#, (1..=sheets.len()).map(|index| format!(r#"<Override PartName="/xl/worksheets/sheet{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>"#)).collect::<String>());
    write_zip_entry(&mut archive, "[Content_Types].xml", &content_types, options)?;
    write_zip_entry(
        &mut archive,
        "_rels/.rels",
        r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
        options,
    )?;
    let workbook = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>{}</sheets></workbook>"#,
        sheets
            .iter()
            .enumerate()
            .map(|(index, (name, _))| format!(
                r#"<sheet name="{}" sheetId="{}" r:id="rId{}"/>"#,
                xml_escape(name),
                index + 1,
                index + 1
            ))
            .collect::<String>()
    );
    write_zip_entry(&mut archive, "xl/workbook.xml", &workbook, options)?;
    let relationships = format!(r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{}</Relationships>"#, (1..=sheets.len()).map(|index| format!(r#"<Relationship Id="rId{index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{index}.xml"/>"#)).collect::<String>());
    write_zip_entry(
        &mut archive,
        "xl/_rels/workbook.xml.rels",
        &relationships,
        options,
    )?;
    for (index, (_, rows)) in sheets.iter().enumerate() {
        let xml = worksheet_xml(rows);
        write_zip_entry(
            &mut archive,
            &format!("xl/worksheets/sheet{}.xml", index + 1),
            &xml,
            options,
        )?;
    }
    archive
        .finish()
        .map(|cursor| cursor.into_inner())
        .map_err(|error| error.to_string())
}

fn write_zip_entry(
    archive: &mut zip::ZipWriter<Cursor<Vec<u8>>>,
    path: &str,
    content: &str,
    options: SimpleFileOptions,
) -> Result<(), String> {
    archive
        .start_file(path, options)
        .map_err(|error| error.to_string())?;
    archive
        .write_all(content.as_bytes())
        .map_err(|error| error.to_string())
}

fn worksheet_xml(rows: &[Vec<Value>]) -> String {
    let body = rows.iter().enumerate().map(|(row_index, row)| {
        let cells = row.iter().enumerate().map(|(column, value)| {
            let reference = format!("{}{}", excel_column(column), row_index + 1);
            match value {
                Value::Number(number) => return format!(r#"<c r="{reference}" t="n"><v>{number}</v></c>"#),
                Value::Bool(boolean) => return format!(r#"<c r="{reference}" t="b"><v>{}</v></c>"#, u8::from(*boolean)),
                _ => {}
            }
            let text = match value {
                Value::String(text) => text.clone(),
                Value::Null => String::new(),
                _ => value.to_string(),
            };
            let bounded: String = text.chars().take(32_767).collect();
            format!(r#"<c r="{reference}" t="inlineStr"><is><t xml:space="preserve">{}</t></is></c>"#, xml_escape(&bounded))
        }).collect::<String>();
        format!(r#"<row r="{}">{cells}</row>"#, row_index + 1)
    }).collect::<String>();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{body}</sheetData></worksheet>"#
    )
}

fn excel_column(mut index: usize) -> String {
    let mut result = String::new();
    loop {
        result.insert(0, (b'A' + (index % 26) as u8) as char);
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    result
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn delete_folder_task_impl(
    manager: &FolderTaskManager,
    task_id: &str,
    expected_revision: u64,
) -> Result<(), String> {
    let _mutation = manager.executions.mutation_when_idle(task_id).map_err(|error| error.to_string())?;
    validate_id(task_id)?;
    let connection = manager.connection()?;
    let (status, revision) = current_status_and_revision(&connection, task_id)?;
    if revision != expected_revision {
        return Err("Folder task changed; refresh before deleting it".into());
    }
    if status == FolderTaskStatus::Running || get_active_batch(&connection, task_id)?.is_some() {
        return Err("Pause or cancel the folder task before deleting it".into());
    }
    let changed = connection
        .execute(
            "DELETE FROM folder_tasks WHERE id = ?1 AND revision = ?2",
            params![task_id, expected_revision],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err("Folder task changed before it could be deleted".into());
    }
    Ok(())
}

fn count_pending_decisions(connection: &Connection, task_id: &str) -> Result<u64, String> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM folder_task_decisions WHERE task_id = ?1 AND status = 'pending'",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn transition_task_status(
    transaction: &Transaction<'_>,
    task_id: &str,
    status: FolderTaskStatus,
    event_type: &str,
    now: i64,
) -> Result<(), String> {
    let changed = transaction
        .execute(
            "UPDATE folder_tasks SET status = ?1, updated_at = ?2, revision = revision + 1
             WHERE id = ?3 AND status = 'running'",
            params![status.as_str(), now, task_id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 1 {
        append_event(transaction, task_id, event_type, json!({}), now)?;
    }
    Ok(())
}

fn transition_task_after_processing(
    transaction: &Transaction<'_>,
    task_id: &str,
    now: i64,
) -> Result<(), String> {
    let plan_json: String = transaction
        .query_row(
            "SELECT plan_json FROM folder_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| map_not_found(error, "Folder task"))?;
    let plan: FolderTaskPlan = from_json(&plan_json, "folder task plan")?;
    let task_progress = progress(transaction, task_id)?;
    let unresolved =
        task_progress.failed + task_progress.manual_review + task_progress.awaiting_external_parser;
    let mut output_failed = false;
    if plan.output.auto_write && unresolved == 0 {
        match materialize_folder_task_output(transaction, task_id, &plan, now) {
            Ok(output) => append_event(
                transaction,
                task_id,
                "output.written",
                json!({ "output": output, "automatic": true }),
                now,
            )?,
            Err(error) => {
                output_failed = true;
                append_event(
                    transaction,
                    task_id,
                    "output.failed",
                    json!({ "error": error, "automatic": true }),
                    now,
                )?;
            }
        }
    }
    if plan.completion_policy == "complete_after_processing" && unresolved == 0 && !output_failed {
        transition_task_status(
            transaction,
            task_id,
            FolderTaskStatus::Completed,
            "task.completed",
            now,
        )
    } else {
        transition_task_status(
            transaction,
            task_id,
            FolderTaskStatus::Reviewing,
            "task.reviewing",
            now,
        )
    }
}

fn request_folder_task_decision_impl(
    manager: &FolderTaskManager,
    task_id: &str,
    run_id: Option<&str>,
    batch_token: Option<&str>,
    request: NewDecisionRequest,
) -> Result<FolderTaskDecision, String> {
    let _mutation = manager.executions.mutation_when_idle(task_id).map_err(|error| error.to_string())?;
    validate_decision_request(&request)?;
    let mut connection = manager.connection()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let (status, _) = current_status_and_revision(&transaction, task_id)?;
    if status != FolderTaskStatus::Running {
        return Err(format!(
            "Decisions can only be requested while running, not {}",
            status.as_str()
        ));
    }
    if let (Some(run_id), Some(batch_token)) = (run_id, batch_token) {
        let batch = require_active_batch(&transaction, &manager.instance_id, task_id, run_id, batch_token, now_ms()?)?;
        let batch_ids = batch.item_ids.into_iter().collect::<BTreeSet<_>>();
        if !request
            .affected_item_ids
            .iter()
            .all(|item_id| batch_ids.contains(item_id))
        {
            return Err("Decision contains an item outside the active batch".into());
        }
    } else if run_id.is_some() || batch_token.is_some() {
        return Err("Both run ID and batch token are required for an Agent decision".into());
    }
    let plan_json: String = transaction
        .query_row(
            "SELECT plan_json FROM folder_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| map_not_found(error, "Folder task"))?;
    let plan: FolderTaskPlan = from_json(&plan_json, "folder task plan")?;
    let now = now_ms()?;
    let decision = insert_decision(&transaction, task_id, request, now)?;
    for item_id in &decision.affected_item_ids {
        let changed = transaction
            .execute(
                "UPDATE folder_task_items SET status = 'pending_decision' WHERE task_id = ?1 AND id = ?2 AND status = 'processing'",
                params![task_id, item_id],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err(format!(
                "Decision item {item_id} is not in the active batch"
            ));
        }
    }
    let remaining_processing: u64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM folder_task_items WHERE task_id = ?1 AND status = 'processing'",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let next_status = if plan.review_policy == "pause_on_ambiguity" || remaining_processing == 0 {
        FolderTaskStatus::AwaitingDecision
    } else {
        FolderTaskStatus::Running
    };
    transaction
        .execute(
            "UPDATE folder_tasks SET status = ?1, updated_at = ?2, revision = revision + 1 WHERE id = ?3",
            params![next_status.as_str(), now, task_id],
        )
        .map_err(|error| error.to_string())?;
    append_event(
        &transaction,
        task_id,
        "decision.requested",
        json!({
            "decisionId": decision.id,
            "kind": decision.kind,
            "deferredUntilCheckpoint": next_status == FolderTaskStatus::Running,
        }),
        now,
    )?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(decision)
}

fn insert_decision(
    transaction: &Transaction<'_>,
    task_id: &str,
    request: NewDecisionRequest,
    now: i64,
) -> Result<FolderTaskDecision, String> {
    validate_decision_request(&request)?;
    let id = new_id("fdecision")?;
    transaction
        .execute(
            "INSERT INTO folder_task_decisions(
                id, task_id, kind, title, description, evidence_json, options_json,
                recommended_option_id, affected_item_ids_json, apply_key, status, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11)",
            params![
                id,
                task_id,
                request.kind,
                request.title,
                request.description,
                request.evidence.to_string(),
                to_json(&request.options)?,
                request.recommended_option_id,
                to_json(&request.affected_item_ids)?,
                request.apply_key,
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
    get_decision(transaction, task_id, &id)
}

fn validate_decision_request(request: &NewDecisionRequest) -> Result<(), String> {
    if request.kind.trim().is_empty()
        || request.title.trim().is_empty()
        || request.description.trim().is_empty()
    {
        return Err("Decision kind, title, and description are required".into());
    }
    if request.options.len() < 2 || request.options.len() > 6 {
        return Err("A decision must provide between 2 and 6 options".into());
    }
    let mut ids = BTreeSet::new();
    for option in &request.options {
        if option.id.trim().is_empty() || option.label.trim().is_empty() || !ids.insert(&option.id)
        {
            return Err("Decision option IDs and labels must be non-empty and unique".into());
        }
    }
    if let Some(recommended) = &request.recommended_option_id {
        if !ids.contains(recommended) {
            return Err("Recommended option must exist in options".into());
        }
    }
    Ok(())
}

fn resolve_folder_task_decision_impl(
    manager: &FolderTaskManager,
    task_id: &str,
    decision_id: &str,
    option_id: &str,
    note: Option<String>,
    apply_to_similar: bool,
    expected_revision: u64,
) -> Result<FolderTaskDetail, String> {
    validate_id(task_id)?;
    validate_id(decision_id)?;
    let mut connection = manager.connection()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let (task_status, _) = require_status_and_revision(
        &transaction,
        task_id,
        &[
            FolderTaskStatus::AwaitingPlanConfirmation,
            FolderTaskStatus::AwaitingDecision,
        ],
        expected_revision,
    )?;
    let decision = get_decision(&transaction, task_id, decision_id)?;
    if decision.status != "pending" {
        return Err("Decision was already resolved".into());
    }
    if !decision.options.iter().any(|option| option.id == option_id) {
        return Err("Selected option does not exist".into());
    }
    let resolution = json!({
        "optionId": option_id,
        "note": note,
        "applyToSimilar": apply_to_similar,
        "applyKey": if apply_to_similar { decision.apply_key.clone() } else { None },
    });
    let now = now_ms()?;
    transaction
        .execute(
            "UPDATE folder_task_decisions SET status = 'resolved', resolution_json = ?1, resolved_at = ?2
             WHERE id = ?3 AND task_id = ?4 AND status = 'pending'",
            params![resolution.to_string(), now, decision_id, task_id],
        )
        .map_err(|error| error.to_string())?;
    apply_planning_decision(&transaction, task_id, &decision, option_id)?;
    for item_id in &decision.affected_item_ids {
        transaction
            .execute(
                "UPDATE folder_task_items SET status = 'pending' WHERE task_id = ?1 AND id = ?2 AND status = 'pending_decision'",
                params![task_id, item_id],
            )
            .map_err(|error| error.to_string())?;
    }
    let pending: u64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM folder_task_decisions WHERE task_id = ?1 AND status = 'pending'",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let next_status = if task_status == FolderTaskStatus::AwaitingDecision && pending == 0 {
        FolderTaskStatus::Running
    } else {
        task_status
    };
    transaction
        .execute(
            "UPDATE folder_tasks SET status = ?1, updated_at = ?2, revision = revision + 1 WHERE id = ?3",
            params![next_status.as_str(), now, task_id],
        )
        .map_err(|error| error.to_string())?;
    append_event(
        &transaction,
        task_id,
        "decision.resolved",
        json!({ "decisionId": decision_id, "optionId": option_id, "applyToSimilar": apply_to_similar }),
        now,
    )?;
    transaction.commit().map_err(|error| error.to_string())?;
    get_folder_task_impl(manager, task_id)
}

fn apply_planning_decision(
    transaction: &Transaction<'_>,
    task_id: &str,
    decision: &FolderTaskDecision,
    option_id: &str,
) -> Result<(), String> {
    if decision.kind != "unsupported_formats" {
        return Ok(());
    }
    apply_unsupported_format_policy(transaction, task_id, option_id)
}

fn apply_unsupported_format_policy(
    transaction: &Transaction<'_>,
    task_id: &str,
    option_id: &str,
) -> Result<(), String> {
    match option_id {
        "skip" => {
            transaction
                .execute(
                    "UPDATE folder_task_items SET status = 'skipped', result_json = ?1
                     WHERE task_id = ?2 AND status = 'pending' AND extension NOT IN ('txt','md','markdown','csv','json','yaml','yml','xml','html','htm','log','docx','xlsx','pdf','png','jpg','jpeg')",
                    params![json!({ "reason": "unsupported_format_policy" }).to_string(), task_id],
                )
                .map_err(|error| error.to_string())?;
        }
        "queue_manual_review" | "attempt_external" => {
            transaction
                .execute(
                    "UPDATE folder_task_items SET status = 'awaiting_external_parser', result_json = ?1
                     WHERE task_id = ?2 AND status = 'pending' AND extension NOT IN ('txt','md','markdown','csv','json','yaml','yml','xml','html','htm','log','docx','xlsx','pdf','png','jpg','jpeg')",
                    params![json!({ "reason": "external_parser_required" }).to_string(), task_id],
                )
                .map_err(|error| error.to_string())?;
        }
        _ => return Err("Unsupported format decision option".into()),
    }
    Ok(())
}

fn resolved_unsupported_policy(
    connection: &Connection,
    task_id: &str,
) -> Result<Option<String>, String> {
    let resolution = connection
        .query_row(
            "SELECT resolution_json FROM folder_task_decisions
             WHERE task_id = ?1 AND kind = 'unsupported_formats' AND status = 'resolved'
             ORDER BY resolved_at DESC LIMIT 1",
            [task_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten();
    let Some(value) = resolution else {
        return Ok(None);
    };
    let parsed: Value = from_json(&value, "unsupported format resolution")?;
    if parsed.get("applyToSimilar").and_then(Value::as_bool) != Some(true) {
        return Ok(None);
    }
    parsed
        .get("optionId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .map(Some)
        .ok_or_else(|| "Unsupported format resolution has no optionId".into())
}

fn seed_or_apply_inventory_policy(
    transaction: &Transaction<'_>,
    task_id: &str,
    inventory: &FolderInventory,
    now: i64,
) -> Result<(), String> {
    if inventory.attention_files == 0 {
        return Ok(());
    }
    if let Some(option_id) = resolved_unsupported_policy(transaction, task_id)? {
        apply_unsupported_format_policy(transaction, task_id, &option_id)
    } else {
        seed_inventory_decisions(transaction, task_id, inventory, now)
    }
}

fn set_folder_task_status_impl(
    manager: &FolderTaskManager,
    task_id: &str,
    action: &str,
    expected_revision: u64,
) -> Result<FolderTaskDetail, String> {
    set_folder_task_status_with_progress(manager, task_id, action, expected_revision, |_| {})
}

fn set_folder_task_status_with_progress(
    manager: &FolderTaskManager, task_id: &str, action: &str, expected_revision: u64,
    on_stopping: impl Fn(bool),
) -> Result<FolderTaskDetail, String> {
    let stopping = matches!(action, "pause" | "cancel");
    let mutation = if stopping { manager.executions.mutation_for_stop(task_id) } else { manager.executions.mutation_when_idle(task_id) }
        .map_err(|error| error.to_string())?;
    if stopping {
        // Validate the action while fenced, before signaling any converter.
        // Close this read connection before waiting; no DB write lock is held.
        {
            let connection = manager.connection()?;
            let (status, revision) = current_status_and_revision(&connection, task_id)?;
            if revision != expected_revision { return Err("Folder task changed; refresh before applying this action".into()); }
            let valid = if action == "pause" { status == FolderTaskStatus::Running } else {
                matches!(status, FolderTaskStatus::AwaitingPlanConfirmation | FolderTaskStatus::Running | FolderTaskStatus::Paused |
                    FolderTaskStatus::AwaitingDecision | FolderTaskStatus::Reviewing | FolderTaskStatus::Failed)
            };
            if !valid { return Err(format!("Action '{action}' is invalid while task is {}", status.as_str())); }
        }
        mutation.cancel_and_wait(on_stopping).map_err(|error| error.to_string())?;
    }
    let mut connection = manager.connection()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let (current, revision) = current_status_and_revision(&transaction, task_id)?;
    if revision != expected_revision {
        return Err("Folder task changed; refresh before applying this action".into());
    }
    let next = match (current.clone(), action) {
        (FolderTaskStatus::Running, "pause") => FolderTaskStatus::Paused,
        (FolderTaskStatus::Paused, "resume") | (FolderTaskStatus::Failed, "resume") => {
            let confirmed: Option<String> = transaction.query_row(
                "SELECT confirmed_plan_hash FROM folder_tasks WHERE id = ?1",
                [task_id],
                |row| row.get(0),
            ).map_err(|error| error.to_string())?;
            if confirmed.is_some() {
                FolderTaskStatus::Running
            } else {
                FolderTaskStatus::AwaitingPlanConfirmation
            }
        }
        (FolderTaskStatus::Reviewing, "complete") => FolderTaskStatus::Completed,
        (FolderTaskStatus::AwaitingPlanConfirmation, "cancel")
        | (FolderTaskStatus::Running, "cancel")
        | (FolderTaskStatus::Paused, "cancel")
        | (FolderTaskStatus::AwaitingDecision, "cancel")
        | (FolderTaskStatus::Reviewing, "cancel")
        | (FolderTaskStatus::Failed, "cancel") => FolderTaskStatus::Cancelled,
        _ => {
            return Err(format!(
                "Action '{action}' is invalid while task is {}",
                current.as_str()
            ))
        }
    };
    if matches!(action, "pause" | "resume" | "cancel") {
        release_active_batch(&transaction, task_id, "interrupted", action)?;
    }
    if action == "resume" {
        transaction
            .execute(
                "UPDATE folder_task_items SET status = 'pending' WHERE task_id = ?1 AND status = 'processing'",
                [task_id],
            )
            .map_err(|error| error.to_string())?;
    }
    if action == "complete" {
        let progress = progress(&transaction, task_id)?;
        if progress.pending
            + progress.processing
            + progress.pending_decision
            + progress.failed
            + progress.manual_review
            + progress.awaiting_external_parser
            > 0
        {
            return Err(
                "Task still has unresolved, failed, manual-review, or external-parser items".into(),
            );
        }
        let (plan_json, result_revision): (String, i64) = transaction
            .query_row(
                "SELECT plan_json, result_revision FROM folder_tasks WHERE id = ?1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| map_not_found(error, "Folder task"))?;
        let plan: FolderTaskPlan = from_json(&plan_json, "folder task plan")?;
        if plan.output.auto_write {
            let has_current_output: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM folder_task_outputs WHERE task_id = ?1 AND result_revision = ?2)",
                    params![task_id, result_revision],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if !has_current_output {
                return Err(
                    "Planned automatic output is missing or stale; write the output before completing the task"
                        .into(),
                );
            }
        }
    }
    let now = now_ms()?;
    transaction
        .execute(
            "UPDATE folder_tasks SET status = ?1, updated_at = ?2, revision = revision + 1 WHERE id = ?3",
            params![next.as_str(), now, task_id],
        )
        .map_err(|error| error.to_string())?;
    append_event(
        &transaction,
        task_id,
        &format!("task.{action}"),
        json!({ "from": current.as_str(), "to": next.as_str() }),
        now,
    )?;
    transaction.commit().map_err(|error| error.to_string())?;
    get_folder_task_impl(manager, task_id)
}

fn read_folder_task_file_bytes_impl(
    manager: &FolderTaskManager,
    task_id: &str,
    run_id: &str,
    batch_token: &str,
    relative_path: &str,
) -> Result<FolderTaskFileBytes, String> {
    read_folder_task_snapshot_impl(manager, task_id, run_id, batch_token, relative_path, true)
}

fn read_folder_task_snapshot_impl(
    manager: &FolderTaskManager, task_id: &str, run_id: &str, batch_token: &str,
    relative_path: &str, renew_lease: bool,
) -> Result<FolderTaskFileBytes, String> {
    validate_id(task_id)?;
    validate_id(run_id)?;
    validate_id(batch_token)?;
    let relative = validate_relative_path(relative_path)?;
    let connection = manager.connection()?;
    let (root, status): (String, String) = connection
        .query_row(
            "SELECT root_path, status FROM folder_tasks WHERE id = ?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| map_not_found(error, "Folder task"))?;
    if FolderTaskStatus::parse(&status)? != FolderTaskStatus::Running {
        return Err("Folder task files can only be read while the task is running".into());
    }
    let now = now_ms()?;
    let batch = require_active_batch(&connection, &manager.instance_id, task_id, run_id, batch_token, now)?;
    let inventory_entry: Option<(u64, i64, String)> = connection.query_row(
        "SELECT item.size, item.modified_at, item.content_hash FROM folder_task_items item
            JOIN folder_task_batch_items bi ON bi.item_id = item.id
            WHERE item.task_id = ?1 AND item.relative_path = ?2 AND item.status = 'processing' AND bi.batch_id = ?3
            LIMIT 1",
        params![task_id, portable_path(&relative), batch.id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(|error| error.to_string())?;
    let Some((inventory_size, inventory_modified_at, inventory_hash)) = inventory_entry else {
        return Err("File is not part of the currently claimed batch".into());
    };
    let canonical_root = fs::canonicalize(&root).map_err(|error| error.to_string())?;
    let path = canonical_root.join(&relative);
    let canonical =
        fs::canonicalize(&path).map_err(|error| format!("Task file is not accessible: {error}"))?;
    if !canonical.starts_with(&canonical_root) || !canonical.is_file() {
        return Err("Task file escaped the authorized folder".into());
    }
    let mut file = open_task_snapshot(&canonical_root, &relative)?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Task snapshot must be a regular file".into());
    }
    let current_modified_at = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as i64;
    if metadata.len() != inventory_size || current_modified_at != inventory_modified_at {
        return Err(
            "Task file changed after inventory scan; rescan the task before processing it".into(),
        );
    }
    if metadata.len() > MAX_MODEL_FILE_BYTES {
        return Err(format!(
            "File is {} bytes; the built-in reader limit is {MAX_MODEL_FILE_BYTES} bytes. Queue it for a specialized parser.",
            metadata.len()
        ));
    }
    // Hash the exact bytes returned to the parser. Hashing the path and then
    // reading it would leave a TOCTOU window where the two snapshots differ.
    let mut bytes = Vec::new();
    (&mut file).take(MAX_MODEL_FILE_BYTES + 1).read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let after = file.metadata().map_err(|error| error.to_string())?;
    if metadata.len() != after.len() || metadata.modified().ok() != after.modified().ok() {
        return Err("Task file changed while reading its snapshot; rescan before processing it".into());
    }
    if bytes.len() as u64 != inventory_size {
        return Err(
            "Task file changed while it was being read; rescan before processing it".into(),
        );
    }
    let current_hash = sha256_bytes(&bytes);
    if inventory_hash.is_empty() {
        connection.execute(
            "UPDATE folder_task_items SET content_hash = ?1, estimated_characters = ?2 WHERE task_id = ?3 AND relative_path = ?4 AND content_hash = ''",
            params![current_hash, estimate_characters(&normalized_extension(&canonical), metadata.len()), task_id, portable_path(&relative)],
        ).map_err(|error| error.to_string())?;
    } else if current_hash != inventory_hash {
        return Err("Task file content no longer matches the confirmed SHA-256 snapshot; rescan before processing it".into());
    }
    // Do not renew an old lease or return bytes if a pause/expiry happened
    // during filesystem I/O. Conversion performs additional launch/accept checks.
    if current_status_and_revision(&connection, task_id)?.0 != FolderTaskStatus::Running {
        return Err("Folder task stopped while reading the file snapshot".into());
    }
    let renewed_at = now_ms()?;
    require_active_batch(&connection, &manager.instance_id, task_id, run_id, batch_token, renewed_at)?;
    if renew_lease { connection.execute(
        "UPDATE folder_task_batches SET lease_expires_at = ?1 WHERE id = ?2 AND status = 'active'",
        params![renewed_at + BATCH_LEASE_MS, batch.id],
    ).map_err(|error| error.to_string())?; }
    Ok(FolderTaskFileBytes {
        name: canonical
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("file")
            .to_string(),
        bytes,
        size: metadata.len(),
        content_hash: current_hash,
    })
}

/// Resolve every source component relative to an opened directory, never by
/// reopening a canonicalized path that could have changed since validation.
#[cfg(unix)]
fn open_task_snapshot(root: &Path, relative: &Path) -> Result<File, String> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::{ffi::OsStrExt, fs::OpenOptionsExt};
    let mut directory = fs::OpenOptions::new().read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC).open(root)
        .map_err(|error| format!("Unable to open task snapshot root: {error}"))?;
    let parts: Vec<_> = relative.components().collect();
    for (index, part) in parts.iter().enumerate() {
        if !matches!(part, Component::Normal(_)) { return Err("Invalid snapshot path component".into()); }
        let name = std::ffi::CString::new(part.as_os_str().as_bytes()).map_err(|_| "Invalid snapshot path")?;
        let mut flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
        if index + 1 < parts.len() { flags |= libc::O_DIRECTORY; }
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 { return Err(format!("Task snapshot path is inaccessible or contains a symbolic link: {}", std::io::Error::last_os_error())); }
        directory = unsafe { File::from_raw_fd(fd) };
    }
    if !directory.metadata().map_err(|error| error.to_string())?.is_file() {
        return Err("Task snapshot must be a regular file".into());
    }
    Ok(directory)
}

#[cfg(not(unix))]
fn open_task_snapshot(root: &Path, relative: &Path) -> Result<File, String> {
    let mut path = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) { return Err("Invalid snapshot path component".into()); }
        path.push(component);
        if fs::symlink_metadata(&path).map_err(|error| error.to_string())?.file_type().is_symlink() {
            return Err("Task snapshot paths cannot contain symbolic links".into());
        }
    }
    // Windows external conversion remains disabled; this is native reading only.
    File::open(path).map_err(|error| error.to_string())
}

fn validate_relative_path(value: &str) -> Result<PathBuf, String> {
    if value.trim().is_empty() {
        return Err("Relative path is required".into());
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Path must be a normalized relative path".into());
    }
    Ok(path.to_path_buf())
}

fn current_status_and_revision(
    connection: &Connection,
    task_id: &str,
) -> Result<(FolderTaskStatus, u64), String> {
    validate_id(task_id)?;
    let (status, revision) = connection
        .query_row(
            "SELECT status, revision FROM folder_tasks WHERE id = ?1",
            [task_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?)),
        )
        .map_err(|error| map_not_found(error, "Folder task"))?;
    Ok((FolderTaskStatus::parse(&status)?, revision))
}

fn require_status_and_revision(
    connection: &Connection,
    task_id: &str,
    statuses: &[FolderTaskStatus],
    expected_revision: u64,
) -> Result<(FolderTaskStatus, u64), String> {
    let (status, revision) = current_status_and_revision(connection, task_id)?;
    if revision != expected_revision {
        return Err("Folder task changed; refresh before applying this action".into());
    }
    if !statuses.contains(&status) {
        return Err(format!(
            "Folder task is {}, so this action is not allowed",
            status.as_str()
        ));
    }
    Ok((status, revision))
}

fn get_item(
    connection: &Connection,
    task_id: &str,
    item_id: &str,
) -> Result<FolderTaskItem, String> {
    connection
        .query_row(
            "SELECT id, relative_path, size, modified_at, extension, content_hash, estimated_characters, status, attempts, result_json, error, extraction_json
             FROM folder_task_items WHERE task_id = ?1 AND id = ?2",
            params![task_id, item_id],
            |row| Ok((
                row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, u64>(2)?,
                row.get::<_, i64>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                row.get::<_, u64>(6)?, row.get::<_, String>(7)?, row.get::<_, u32>(8)?,
                row.get::<_, Option<String>>(9)?, row.get::<_, Option<String>>(10)?,
                row.get::<_, Option<String>>(11)?,
            )),
        )
        .map_err(|error| map_not_found(error, "Folder task item"))
        .and_then(|row| {
            let extraction: Option<extraction::ExtractionReceipt> = row.11.map(|value| from_json(&value, "extraction receipt")).transpose()?;
            Ok(FolderTaskItem {
            id: row.0,
            relative_path: row.1.clone(),
            size: row.2,
            modified_at: row.3,
            extension: row.4.clone(),
            content_hash: row.5.clone(),
            estimated_characters: row.6,
            status: row.7,
            attempts: row.8,
            result: row.9.map(|value| from_json(&value, "item result")).transpose()?,
            error: row.10,
            provenance: FolderTaskProvenance {
                relative_path: row.1,
                source_hash: row.5,
                size: row.2,
                modified_at: row.3,
                parser: extraction.as_ref().map(|receipt| receipt.parser().to_owned()).unwrap_or_else(|| parser_name_for_extension(&row.4).into()),
                parser_version: extraction.as_ref().map(|receipt| receipt.parser_version.clone()).unwrap_or_else(|| "folder-task-v3".into()),
                extraction,
            },
        })})
}

fn list_decisions(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<FolderTaskDecision>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id FROM folder_task_decisions WHERE task_id = ?1
             ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let ids = statement
        .query_map([task_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    ids.iter()
        .map(|id| get_decision(connection, task_id, id))
        .collect()
}

fn get_decision(
    connection: &Connection,
    task_id: &str,
    decision_id: &str,
) -> Result<FolderTaskDecision, String> {
    let row = connection
        .query_row(
            "SELECT id, kind, title, description, evidence_json, options_json, recommended_option_id,
                    affected_item_ids_json, apply_key, status, resolution_json, created_at, resolved_at
             FROM folder_task_decisions WHERE task_id = ?1 AND id = ?2",
            params![task_id, decision_id],
            |row| Ok((
                row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?, row.get::<_, String>(7)?, row.get::<_, Option<String>>(8)?,
                row.get::<_, String>(9)?, row.get::<_, Option<String>>(10)?, row.get::<_, i64>(11)?,
                row.get::<_, Option<i64>>(12)?,
            )),
        )
        .map_err(|error| map_not_found(error, "Folder task decision"))?;
    Ok(FolderTaskDecision {
        id: row.0,
        kind: row.1,
        title: row.2,
        description: row.3,
        evidence: from_json(&row.4, "decision evidence")?,
        options: from_json(&row.5, "decision options")?,
        recommended_option_id: row.6,
        affected_item_ids: from_json(&row.7, "decision item IDs")?,
        apply_key: row.8,
        status: row.9,
        resolution: row
            .10
            .map(|value| from_json(&value, "decision resolution"))
            .transpose()?,
        created_at: row.11,
        resolved_at: row.12,
    })
}

fn list_events(
    connection: &Connection,
    task_id: &str,
    limit: u32,
) -> Result<Vec<FolderTaskEvent>, String> {
    let mut statement = connection
        .prepare(
            "SELECT seq, event_type, data_json, created_at FROM folder_task_events
             WHERE task_id = ?1 ORDER BY seq DESC LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![task_id, limit], |row| {
            Ok((
                row.get::<_, u64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut events = Vec::new();
    for row in rows {
        let (seq, event_type, data, created_at) = row.map_err(|error| error.to_string())?;
        events.push(FolderTaskEvent {
            seq,
            event_type,
            data: from_json(&data, "folder task event")?,
            created_at,
        });
    }
    Ok(events)
}

fn append_event(
    transaction: &Transaction<'_>,
    task_id: &str,
    event_type: &str,
    data: Value,
    now: i64,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO folder_task_events(task_id, event_type, data_json, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![task_id, event_type, data.to_string(), now],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.')
        })
    {
        return Err("Invalid folder task identifier".into());
    }
    Ok(())
}

fn to_json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| error.to_string())
}

fn from_json<T: for<'de> Deserialize<'de>>(value: &str, label: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(|error| format!("Invalid {label}: {error}"))
}

fn map_not_found(error: rusqlite::Error, label: &str) -> String {
    if matches!(error, rusqlite::Error::QueryReturnedNoRows) {
        format!("{label} was not found")
    } else {
        error.to_string()
    }
}

fn new_id(prefix: &str) -> Result<String, String> {
    Ok(format!(
        "{prefix}-{:x}-{:x}-{:x}",
        now_ms()?,
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    ))
}

fn now_ms() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "solidify-folder-task-{label}-{}",
            new_id("test").unwrap()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_reader_rejects_leaf_and_parent_links_and_special_files() {
        use std::os::unix::{ffi::OsStrExt, fs::symlink};
        let root = tempdir("snapshot-links");
        fs::create_dir(root.join("real")).unwrap();
        fs::write(root.join("real/file.txt"), b"snapshot").unwrap();
        let mut file = open_task_snapshot(&root, Path::new("real/file.txt")).unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"snapshot");
        symlink(root.join("real/file.txt"), root.join("linked.txt")).unwrap();
        symlink(root.join("real"), root.join("linked-dir")).unwrap();
        assert!(open_task_snapshot(&root, Path::new("linked.txt")).is_err());
        assert!(open_task_snapshot(&root, Path::new("linked-dir/file.txt")).is_err());
        assert!(open_task_snapshot(&root, Path::new("real")).is_err());
        let pipe = std::ffi::CString::new(root.join("pipe").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(pipe.as_ptr(), 0o600) }, 0);
        assert!(open_task_snapshot(&root, Path::new("pipe")).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    fn manager(root: &Path) -> FolderTaskManager {
        FolderTaskManager::for_test(root.join("tasks.sqlite3")).unwrap()
    }

    fn extraction_result(summary: &str) -> Value {
        json!({ "summary": summary, "facts": [] })
    }

    fn completed_extraction_item(
        id: &str,
        path: &str,
        label: &str,
        value: Value,
    ) -> FolderTaskItem {
        FolderTaskItem {
            id: id.into(),
            relative_path: path.into(),
            size: 1,
            modified_at: 1,
            extension: "txt".into(),
            content_hash: format!("hash-{id}"),
            estimated_characters: 1,
            status: "completed".into(),
            attempts: 1,
            result: Some(json!({
                "summary": "ok",
                "facts": [{ "label": label, "value": value }],
            })),
            error: None,
            provenance: FolderTaskProvenance {
                relative_path: path.into(),
                source_hash: format!("hash-{id}"),
                size: 1,
                modified_at: 1,
                parser: "plain-text".into(),
                parser_version: "1".into(),
                extraction: None,
            },
        }
    }

    fn claim(manager: &FolderTaskManager, task_id: &str, run_id: &str) -> FolderTaskBatchClaim {
        claim_folder_task_batch_impl(manager, task_id, run_id, 8).unwrap()
    }

    #[test]
    fn inventory_reports_depth_truncation_instead_of_silently_omitting_files() {
        let root = tempdir("depth-limit");
        let mut directory = root.clone();
        for index in 0..=MAX_SCAN_DEPTH {
            directory = directory.join(format!("level-{index}"));
            fs::create_dir(&directory).unwrap();
        }
        fs::write(directory.join("hidden.txt"), "hidden by scan budget").unwrap();
        let (inventory, items) = scan_inventory("task-depth", &root).unwrap();
        assert!(inventory.truncated);
        assert!(inventory
            .truncation_reasons
            .iter()
            .any(|reason| reason.contains("depth")));
        assert!(items.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selected_document_task_never_expands_to_unselected_siblings() {
        let root = tempdir("selected-documents");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("selected.txt"), "selected").unwrap();
        fs::write(input.join("unselected.txt"), "unselected").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_with_sources_impl(
            &manager,
            input,
            vec![PathBuf::from("selected.txt")],
            "Selected".into(),
            "Only selected files".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        assert_eq!(detail.summary.inventory.files, 1);
        assert_eq!(
            list_folder_task_items_impl(&manager, &detail.summary.id, None, 0, 10).unwrap()[0]
                .relative_path,
            "selected.txt"
        );

        detail.plan.snapshot_mode = "refresh_before_run".into();
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();

        assert_eq!(detail.summary.inventory.files, 1);
        assert_eq!(detail.summary.progress.pending, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recipe_results_are_bound_to_confirmed_field_types_and_review_rules() {
        let extraction_plan = json!({
            "fields": [{ "name": "amount", "aliases": ["金额"], "type": "number", "required": true }]
        });
        assert!(validate_recipe_result(
            "structured-extraction",
            &extraction_plan,
            &json!({ "summary": "ok", "facts": [{ "label": "金额", "value": 12 }] }),
        )
        .is_ok());
        assert!(validate_recipe_result(
            "structured-extraction",
            &extraction_plan,
            &json!({ "summary": "ok", "facts": [{ "label": "金额", "value": "12" }] }),
        )
        .unwrap_err()
        .contains("wrong value type"));

        let review_plan = json!({
            "rules": [{ "id": "privacy", "evidenceRequired": true }]
        });
        assert!(validate_recipe_result(
            "document-review",
            &review_plan,
            &json!({ "summary": "ok", "recommendation": "fix", "findings": [{
                "severity": "high", "title": "issue", "description": "details", "evidence": "quote"
            }] }),
        )
        .unwrap_err()
        .contains("ruleId is required"));
    }

    #[test]
    fn confirmed_semantic_plan_can_change_the_inferred_recipe() {
        let root = tempdir("semantic-recipe");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("contract.txt"), "privacy terms").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input,
            "Review".into(),
            "Review privacy risks".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        detail.plan.recipe = "document-review".into();
        detail.plan.recipe_plan = default_recipe_plan("document-review", &detail.summary.goal);

        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();

        assert_eq!(detail.summary.recipe, "document-review");
        assert_eq!(detail.plan.recipe, "document-review");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inventories_persists_and_resumes_a_task() {
        let root = tempdir("lifecycle");
        let input = root.join("input");
        fs::create_dir_all(input.join("department-a")).unwrap();
        fs::write(input.join("department-a/report.md"), "cloud resource").unwrap();
        fs::write(input.join("legacy.doc"), b"legacy").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input,
            "Cloud inventory".into(),
            "Extract cloud resource evidence".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        assert_eq!(detail.summary.inventory.files, 2);
        assert_eq!(detail.summary.pending_decisions, 1);
        let decision = detail
            .decisions
            .iter()
            .find(|item| item.status == "pending")
            .unwrap();
        detail = resolve_folder_task_decision_impl(
            &manager,
            &detail.summary.id,
            &decision.id,
            "skip",
            None,
            true,
            detail.summary.revision,
        )
        .unwrap();
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan.clone(),
            detail.summary.revision,
        )
        .unwrap();
        assert_eq!(detail.summary.status, FolderTaskStatus::Running);
        let batch = claim(&manager, &detail.summary.id, "run-lifecycle");
        assert_eq!(batch.items.len(), 1);
        let batch_token = batch.batch.as_ref().unwrap().lease_token.clone();
        detail = update_folder_task_batch_impl(
            &manager,
            &detail.summary.id,
            "run-lifecycle",
            &batch_token,
            vec![FolderTaskItemUpdate {
                item_id: batch.items[0].id.clone(),
                status: "completed".into(),
                result: Some(extraction_result("matched")),
                error: None,
            }],
            Some("first checkpoint".into()),
            "complete",
        )
        .unwrap();
        assert_eq!(detail.summary.progress.completed, 1);
        assert_eq!(detail.summary.progress.skipped, 1);
        assert_eq!(detail.summary.status, FolderTaskStatus::Reviewing);
        let reloaded = get_folder_task_impl(&manager, &detail.summary.id).unwrap();
        assert_eq!(reloaded.summary.status, FolderTaskStatus::Reviewing);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_path_escape_and_unregistered_files() {
        let root = tempdir("sandbox");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("inside.txt"), "inside").unwrap();
        fs::write(root.join("outside.txt"), "outside").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input,
            "Sandbox".into(),
            "Read safely".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        assert!(read_folder_task_file_bytes_impl(
            &manager,
            &detail.summary.id,
            "run-sandbox",
            "missing-token",
            "inside.txt"
        )
        .is_err());
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan.clone(),
            detail.summary.revision,
        )
        .unwrap();
        let claimed = claim(&manager, &detail.summary.id, "run-sandbox");
        assert_eq!(claimed.items.len(), 1);
        let token = &claimed.batch.as_ref().unwrap().lease_token;
        assert!(read_folder_task_file_bytes_impl(
            &manager,
            &detail.summary.id,
            "run-sandbox",
            token,
            "inside.txt"
        )
        .is_ok());
        assert!(read_folder_task_file_bytes_impl(
            &manager,
            &detail.summary.id,
            "run-sandbox",
            token,
            "../outside.txt"
        )
        .is_err());
        assert!(read_folder_task_file_bytes_impl(
            &manager,
            &detail.summary.id,
            "run-sandbox",
            token,
            "missing.txt"
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn full_rescan_refreshes_inventory_before_running() {
        let root = tempdir("full-rescan");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("first.txt"), "one").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input.clone(),
            "Rescan".into(),
            "Use a fresh baseline".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        fs::write(input.join("second.md"), "two").unwrap();
        detail.plan.snapshot_mode = "refresh_before_run".into();
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        assert_eq!(detail.summary.status, FolderTaskStatus::Running);
        assert_eq!(detail.summary.inventory.files, 2);
        assert_eq!(
            list_folder_task_items_impl(&manager, &detail.summary.id, None, 0, 100)
                .unwrap()
                .len(),
            2
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn full_rescan_pauses_when_new_unsupported_formats_appear() {
        let root = tempdir("full-rescan-decision");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("first.txt"), "one").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input.clone(),
            "Rescan decision".into(),
            "Do not guess unsupported files".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        fs::write(input.join("legacy.wps"), "legacy").unwrap();
        detail.plan.snapshot_mode = "refresh_before_run".into();
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        assert_eq!(
            detail.summary.status,
            FolderTaskStatus::AwaitingPlanConfirmation
        );
        assert_eq!(detail.summary.pending_decisions, 1);
        assert_eq!(detail.summary.inventory.attention_files, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn confirmed_plan_filters_inventory_and_export_only_completes_automatically() {
        let root = tempdir("plan-scope");
        let input = root.join("input");
        fs::create_dir_all(input.join("ignored")).unwrap();
        fs::write(input.join("keep.txt"), "keep").unwrap();
        fs::write(input.join("skip.md"), "skip extension").unwrap();
        fs::write(input.join("ignored/also.txt"), "skip path").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input,
            "Scoped plan".into(),
            "Only process selected files".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        detail.plan.include_extensions = vec!["txt".into()];
        detail.plan.exclusions = vec!["ignored/**".into()];
        detail.plan.completion_policy = "complete_after_processing".into();
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        assert_eq!(detail.summary.progress.pending, 1);
        assert_eq!(detail.summary.progress.skipped, 2);
        let batch = claim(&manager, &detail.summary.id, "run-plan-scope");
        assert_eq!(batch.items.len(), 1);
        assert_eq!(batch.items[0].relative_path, "keep.txt");
        let batch_token = batch.batch.as_ref().unwrap().lease_token.clone();
        detail = update_folder_task_batch_impl(
            &manager,
            &detail.summary.id,
            "run-plan-scope",
            &batch_token,
            vec![FolderTaskItemUpdate {
                item_id: batch.items[0].id.clone(),
                status: "completed".into(),
                result: Some(extraction_result("complete")),
                error: None,
            }],
            None,
            "complete",
        )
        .unwrap();
        assert_eq!(detail.summary.status, FolderTaskStatus::Completed);
        assert!(detail
            .recent_events
            .windows(2)
            .all(|pair| pair[0].seq > pair[1].seq));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn collect_until_checkpoint_defers_the_user_pause_and_preserves_decision_invariant() {
        let root = tempdir("deferred-decision");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("first.txt"), "ambiguous").unwrap();
        fs::write(input.join("second.txt"), "clear").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input,
            "Deferred decision".into(),
            "Collect one batch before asking".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        detail.plan.review_policy = "collect_until_checkpoint".into();
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        let batch = claim(&manager, &detail.summary.id, "run-decision");
        let batch_token = batch.batch.as_ref().unwrap().lease_token.clone();
        let ambiguous = batch
            .items
            .iter()
            .find(|item| item.relative_path == "first.txt")
            .unwrap();
        let clear = batch
            .items
            .iter()
            .find(|item| item.relative_path == "second.txt")
            .unwrap();
        let invalid = update_folder_task_batch_impl(
            &manager,
            &detail.summary.id,
            "run-decision",
            &batch_token,
            vec![FolderTaskItemUpdate {
                item_id: ambiguous.id.clone(),
                status: "pending_decision".into(),
                result: None,
                error: None,
            }],
            None,
            "complete",
        );
        assert!(invalid.unwrap_err().contains("Unsupported item status"));
        let decision = request_folder_task_decision_impl(
            &manager,
            &detail.summary.id,
            Some("run-decision"),
            Some(&batch_token),
            NewDecisionRequest {
                kind: "resource_mapping".into(),
                title: "选择资源映射".into(),
                description: "该映射会影响同类文件".into(),
                evidence: json!({ "path": ambiguous.relative_path }),
                options: vec![
                    DecisionOption {
                        id: "a".into(),
                        label: "A".into(),
                        description: "A".into(),
                    },
                    DecisionOption {
                        id: "b".into(),
                        label: "B".into(),
                        description: "B".into(),
                    },
                ],
                recommended_option_id: Some("a".into()),
                affected_item_ids: vec![ambiguous.id.clone()],
                apply_key: Some("resource_mapping".into()),
            },
        )
        .unwrap();
        detail = get_folder_task_impl(&manager, &detail.summary.id).unwrap();
        assert_eq!(detail.summary.status, FolderTaskStatus::Running);
        detail = update_folder_task_batch_impl(
            &manager,
            &detail.summary.id,
            "run-decision",
            &batch_token,
            vec![FolderTaskItemUpdate {
                item_id: clear.id.clone(),
                status: "completed".into(),
                result: Some(extraction_result("clear")),
                error: None,
            }],
            Some("batch checkpoint".into()),
            "complete",
        )
        .unwrap();
        assert_eq!(detail.summary.status, FolderTaskStatus::AwaitingDecision);
        detail = resolve_folder_task_decision_impl(
            &manager,
            &detail.summary.id,
            &decision.id,
            "a",
            None,
            true,
            detail.summary.revision,
        )
        .unwrap();
        assert_eq!(detail.summary.status, FolderTaskStatus::Running);
        assert_eq!(detail.summary.progress.pending_decision, 0);
        assert_eq!(detail.summary.progress.pending, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn full_rescan_does_not_reuse_a_policy_declined_for_similar_files() {
        let root = tempdir("non-reusable-policy");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("legacy.wps"), "legacy").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input.clone(),
            "Non reusable policy".into(),
            "Ask again after rescan".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        let decision = detail.decisions[0].clone();
        detail = resolve_folder_task_decision_impl(
            &manager,
            &detail.summary.id,
            &decision.id,
            "skip",
            None,
            false,
            detail.summary.revision,
        )
        .unwrap();
        fs::write(input.join("another.pages"), "new unsupported file").unwrap();
        detail.plan.snapshot_mode = "refresh_before_run".into();
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        assert_eq!(
            detail.summary.status,
            FolderTaskStatus::AwaitingPlanConfirmation
        );
        assert_eq!(detail.summary.pending_decisions, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn batch_lease_prevents_cross_run_reads_and_claims() {
        let root = tempdir("batch-lease");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("one.txt"), "one").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input,
            "Lease".into(),
            "Keep one owner".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        let first = claim(&manager, &detail.summary.id, "run-owner");
        let token = first.batch.as_ref().unwrap().lease_token.clone();
        assert!(
            claim_folder_task_batch_impl(&manager, &detail.summary.id, "run-other", 8)
                .unwrap_err()
                .contains("owns")
        );
        assert!(read_folder_task_file_bytes_impl(
            &manager,
            &detail.summary.id,
            "run-other",
            &token,
            "one.txt"
        )
        .unwrap_err()
        .contains("does not belong"));
        assert!(read_folder_task_file_bytes_impl(
            &manager,
            &detail.summary.id,
            "run-owner",
            &token,
            "one.txt"
        )
        .is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ending_run_waits_for_its_converter_before_releasing_batch() {
        use super::super::sandbox_exec::execution::CallIdentity;
        for outcome in ["aborted", "failed"] {
            let root = tempdir("run-converter-stop");
            let input = root.join("input");
            fs::create_dir(&input).unwrap();
            fs::write(input.join("one.txt"), b"one").unwrap();
            let manager = manager(&root);
            let detail = create_folder_task_impl(&manager, input, "test".into(), "test".into(), "structured-extraction".into()).unwrap();
            let detail = confirm_folder_task_plan_impl(&manager, &detail.summary.id, detail.plan, detail.summary.revision).unwrap();
            let batch = claim(&manager, &detail.summary.id, "run-stop").batch.unwrap();
            let active = manager.executions.begin(CallIdentity::new(&detail.summary.id, "run-stop", "one").unwrap(), &batch.id, Duration::from_secs(10)).unwrap();
            let copy = manager.clone();
            let id = detail.summary.id.clone();
            let (send, receive) = std::sync::mpsc::channel();
            let stop = std::thread::spawn(move || finish_folder_task_run_with_progress(&copy, &id, "run-stop", outcome, None, |_| { let _ = send.send(()); }));
            let signalled = receive.recv_timeout(Duration::from_secs(3)).is_ok();
            let state = get_folder_task_impl(&manager, &detail.summary.id).unwrap();
            let cancelled = active.check().is_err();
            let blocked = manager.executions.begin(CallIdentity::new(&detail.summary.id, "next-run", "late").unwrap(), &batch.id, Duration::from_secs(1)).is_err();
            drop(active);
            let stopped = stop.join().unwrap().unwrap();
            assert!(signalled && cancelled && blocked);
            assert_eq!(state.summary.status, FolderTaskStatus::Running);
            assert_eq!(state.summary.progress.processing, 1);
            assert_eq!(stopped.summary.status, if outcome == "aborted" { FolderTaskStatus::Paused } else { FolderTaskStatus::Failed });
            assert_eq!(stopped.summary.progress.processing, 0);
            assert_eq!(stopped.summary.progress.pending, 1);
            assert!(manager.executions.begin(CallIdentity::new(&detail.summary.id, "run-stop", "late").unwrap(), &batch.id, Duration::from_secs(1)).is_err());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn active_conversion_blocks_checkpoint_expiry_and_batch_release() {
        use super::super::sandbox_exec::execution::CallIdentity;
        let root = tempdir("conversion-exclusion");
        let input = root.join("input");
        fs::create_dir(&input).unwrap();
        fs::write(input.join("one.txt"), b"one").unwrap();
        let manager = manager(&root);
        let detail = create_folder_task_impl(&manager, input, "test".into(), "test".into(), "structured-extraction".into()).unwrap();
        let detail = confirm_folder_task_plan_impl(&manager, &detail.summary.id, detail.plan, detail.summary.revision).unwrap();
        let claimed = claim(&manager, &detail.summary.id, "run-ocr");
        let batch = claimed.batch.unwrap();
        let clone = manager.clone();
        let call = CallIdentity::new(&detail.summary.id, "run-ocr", "call-one").unwrap();
        let active = clone.executions.begin(call.clone(), &batch.id, Duration::from_secs(30)).unwrap();
        let before = get_folder_task_impl(&manager, &detail.summary.id).unwrap();
        let checkpoint = || update_folder_task_batch_impl(&manager, &detail.summary.id, "run-ocr", &batch.lease_token,
            vec![FolderTaskItemUpdate { item_id: claimed.items[0].id.clone(), status: "completed".into(), result: Some(extraction_result("ok")), error: None }], None, "complete");
        assert!(checkpoint().is_err());
        assert!(claim_folder_task_batch_impl(&manager, &detail.summary.id, "run-next", 1).is_err());
        assert!(set_folder_task_status_impl(&manager, &detail.summary.id, "pause", before.summary.revision + 1).is_err());
        assert!(active.check().is_ok(), "stale pause must not cancel an execution");
        assert!(finish_folder_task_run_impl(&manager, &detail.summary.id, "run-ocr", "completed", None).is_err());
        assert!(finish_folder_task_run_impl(&manager, &detail.summary.id, "run-other", "aborted", None).is_err());
        assert!(active.check().is_ok(), "another run must not stop the owner");
        let still_active = get_folder_task_impl(&manager, &detail.summary.id).unwrap();
        assert_eq!(still_active.summary.progress.processing, 1);
        assert_eq!(still_active.summary.revision, before.summary.revision);
        manager.executions.cancel_call(&call).unwrap();
        assert!(checkpoint().is_err());
        drop(active);
        assert!(checkpoint().is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stop_waits_for_conversion_reap_before_releasing_batch() {
        use super::super::sandbox_exec::execution::CallIdentity;
        for action in ["pause", "cancel"] {
        let root = tempdir("pause-conversion");
        let input = root.join("input");
        fs::create_dir(&input).unwrap();
        fs::write(input.join("one.txt"), b"one").unwrap();
        let manager = manager(&root);
        let detail = create_folder_task_impl(&manager, input, "test".into(), "test".into(), "structured-extraction".into()).unwrap();
        let detail = confirm_folder_task_plan_impl(&manager, &detail.summary.id, detail.plan, detail.summary.revision).unwrap();
        let batch = claim(&manager, &detail.summary.id, "run-stop").batch.unwrap();
        let active = manager.executions.begin(CallIdentity::new(&detail.summary.id, "run-stop", "one").unwrap(), &batch.id, Duration::from_secs(10)).unwrap();
        let before = get_folder_task_impl(&manager, &detail.summary.id).unwrap();
        let copy = manager.clone();
        let id = detail.summary.id.clone();
        let (send, receive) = std::sync::mpsc::channel();
        let stop = std::thread::spawn(move || set_folder_task_status_with_progress(&copy, &id, action, before.summary.revision, |_| { let _ = send.send(()); }));
        let signalled = receive.recv_timeout(Duration::from_secs(3)).is_ok();
        let state = get_folder_task_impl(&manager, &detail.summary.id).unwrap();
        let cancelled = active.check().is_err();
        let blocked = manager.executions.begin(CallIdentity::new(&detail.summary.id, "run-stop", "late").unwrap(), &batch.id, Duration::from_secs(1)).is_err();
        drop(active); // The supervisor normally does this only after reap.
        let paused = stop.join().unwrap().unwrap();
        assert!(signalled && cancelled && blocked);
        assert_eq!(state.summary.status, FolderTaskStatus::Running);
        assert_eq!(state.summary.progress.processing, 1);
        assert_eq!(paused.summary.status, if action == "pause" { FolderTaskStatus::Paused } else { FolderTaskStatus::Cancelled });
        assert_eq!(paused.summary.progress.processing, 0);
        assert_eq!(paused.summary.progress.pending, 1);
        fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn image_only_tasks_plan_claim_and_checkpoint_dependency_wait() {
        let root = tempdir("image-only-plan");
        let input = root.join("input");
        fs::create_dir(&input).unwrap();
        fs::write(input.join("scan.PNG"), b"format-only-fixture").unwrap();
        fs::write(input.join("scan.jpeg"), b"format-only-fixture").unwrap();
        let manager = manager(&root);
        let detail = create_folder_task_impl(&manager, input, "images".into(), "read images".into(), "structured-extraction".into()).unwrap();
        assert_eq!(detail.summary.inventory.readable_files, 0);
        assert_eq!(detail.summary.inventory.external_files, 2);
        assert_eq!(detail.summary.inventory.attention_files, 0);
        assert!(detail.decisions.is_empty());
        assert_eq!(detail.plan.include_extensions, vec!["jpeg", "png"]);
        let preview = preview_folder_task_plan_impl(&manager, &detail.summary.id, detail.plan.clone(), detail.summary.revision).unwrap();
        assert_eq!(preview.selected_files, 2);
        assert!(preview.warnings.iter().any(|warning| warning.contains("OCR")));
        let detail = confirm_folder_task_plan_impl(&manager, &detail.summary.id, detail.plan, detail.summary.revision).unwrap();
        let claimed = claim(&manager, &detail.summary.id, "image-run");
        assert_eq!(claimed.items.len(), 2);
        let updates = claimed.items.iter().map(|item| FolderTaskItemUpdate {
            item_id: item.id.clone(), status: "awaiting_external_parser".into(), result: None,
            error: Some("dependency_missing: OCR unavailable".into()),
        }).collect();
        let result = update_folder_task_batch_impl(&manager, &detail.summary.id, "image-run", &claimed.batch.unwrap().lease_token, updates, None, "complete").unwrap();
        assert_eq!(result.summary.progress.awaiting_external_parser, 2);
        assert_eq!(result.summary.progress.skipped, 0);
        assert_eq!(result.summary.progress.completed, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn image_candidates_are_not_skipped_by_unrelated_format_policy() {
        let root = tempdir("image-format-policy");
        let input = root.join("input");
        fs::create_dir(&input).unwrap();
        for name in ["scan.jpg", "old.pages", "animated.gif", "notes.txt"] {
            fs::write(input.join(name), b"format-only-fixture").unwrap();
        }
        let manager = manager(&root);
        let detail = create_folder_task_impl(&manager, input.clone(), "mixed".into(), "mixed".into(), "structured-extraction".into()).unwrap();
        assert_eq!(detail.summary.inventory.external_files, 1);
        assert_eq!(detail.summary.inventory.attention_files, 2);
        let selected = scan_selected_inventory("selected", &input, &[PathBuf::from("scan.jpg")]).unwrap();
        assert_eq!(selected.0.external_files, 1);
        assert_eq!(selected.0.attention_files, 0);
        let mut connection = manager.connection().unwrap();
        let transaction = connection.transaction().unwrap();
        apply_unsupported_format_policy(&transaction, &detail.summary.id, "skip").unwrap();
        transaction.commit().unwrap();
        let items = list_folder_task_items_impl(&manager, &detail.summary.id, None, 0, 10).unwrap();
        assert_eq!(items.iter().find(|item| item.extension == "jpg").unwrap().status, "pending");
        assert_eq!(items.iter().filter(|item| item.status == "skipped").count(), 2);
        // Capability/format recognition never requeues historical skipped items.
        connection.execute("UPDATE folder_task_items SET status = 'skipped' WHERE extension = 'jpg'", []).unwrap();
        let transaction = connection.transaction().unwrap();
        apply_unsupported_format_policy(&transaction, &detail.summary.id, "attempt_external").unwrap();
        transaction.commit().unwrap();
        let items = list_folder_task_items_impl(&manager, &detail.summary.id, None, 0, 10).unwrap();
        assert_eq!(items.iter().find(|item| item.extension == "jpg").unwrap().status, "skipped");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parser_wait_requires_reason_and_whole_batch_checkpoint() {
        let root = tempdir("parser-wait-checkpoint");
        let input = root.join("input");
        fs::create_dir(&input).unwrap();
        fs::write(input.join("one.pdf"), b"%PDF-fixture").unwrap();
        fs::write(input.join("two.txt"), b"two").unwrap();
        let manager = manager(&root);
        let detail = create_folder_task_impl(&manager, input, "test".into(), "test".into(), "structured-extraction".into()).unwrap();
        let detail = confirm_folder_task_plan_impl(&manager, &detail.summary.id, detail.plan, detail.summary.revision).unwrap();
        let claim = claim(&manager, &detail.summary.id, "run-parser");
        let batch = claim.batch.unwrap();
        let mut waiting = FolderTaskItemUpdate { item_id: claim.items[0].id.clone(), status: "awaiting_external_parser".into(), result: None, error: None };
        assert!(update_folder_task_batch_impl(&manager, &detail.summary.id, "run-parser", &batch.lease_token, vec![waiting.clone()], None, "complete").is_err());
        waiting.error = Some("dependency_missing: OCR 组件未安装".into());
        assert!(update_folder_task_batch_impl(&manager, &detail.summary.id, "run-parser", &batch.lease_token, vec![waiting.clone()], None, "complete").is_err());
        assert_eq!(get_folder_task_impl(&manager, &detail.summary.id).unwrap().summary.progress.processing, 2);
        let result = update_folder_task_batch_impl(&manager, &detail.summary.id, "run-parser", &batch.lease_token, vec![waiting,
            FolderTaskItemUpdate { item_id: claim.items[1].id.clone(), status: "completed".into(), result: Some(extraction_result("ok")), error: None }], None, "complete").unwrap();
        assert_eq!(result.summary.progress.awaiting_external_parser, 1);
        assert_eq!(result.summary.progress.completed, 1);
        assert_eq!(result.summary.progress.processing, 0);
        assert_eq!(result.summary.status, FolderTaskStatus::Reviewing);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn complete_checkpoint_requires_the_whole_batch_and_interruption_requeues_the_rest() {
        let root = tempdir("complete-checkpoint");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("one.txt"), "one").unwrap();
        fs::write(input.join("two.txt"), "two").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input,
            "Checkpoint".into(),
            "Atomic batch".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        let batch = claim(&manager, &detail.summary.id, "run-checkpoint");
        let token = batch.batch.as_ref().unwrap().lease_token.clone();
        let one = batch.items[0].id.clone();
        let partial = update_folder_task_batch_impl(
            &manager,
            &detail.summary.id,
            "run-checkpoint",
            &token,
            vec![FolderTaskItemUpdate {
                item_id: one.clone(),
                status: "completed".into(),
                result: Some(extraction_result("one")),
                error: None,
            }],
            None,
            "complete",
        );
        assert!(partial.unwrap_err().contains("every item"));
        detail = update_folder_task_batch_impl(
            &manager,
            &detail.summary.id,
            "run-checkpoint",
            &token,
            vec![FolderTaskItemUpdate {
                item_id: one,
                status: "completed".into(),
                result: Some(extraction_result("one")),
                error: None,
            }],
            None,
            "interrupted",
        )
        .unwrap();
        assert_eq!(detail.summary.progress.completed, 1);
        assert_eq!(detail.summary.progress.pending, 1);
        assert!(detail.active_batch.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ending_a_run_without_checkpoint_fails_the_task_and_releases_items() {
        let root = tempdir("missing-checkpoint");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("one.txt"), "one").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input,
            "Protocol".into(),
            "Require checkpoint".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        claim(&manager, &detail.summary.id, "run-no-checkpoint");
        detail = finish_folder_task_run_impl(
            &manager,
            &detail.summary.id,
            "run-no-checkpoint",
            "completed",
            None,
        )
        .unwrap();
        assert_eq!(detail.summary.status, FolderTaskStatus::Failed);
        assert_eq!(detail.summary.progress.pending, 1);
        assert!(detail.active_batch.is_none());
        assert_eq!(detail.recent_runs[0].status, "failed");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resuming_an_unconfirmed_legacy_failure_returns_to_planning() {
        let root = tempdir("resume-plan");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("one.txt"), "one").unwrap();
        let manager = manager(&root);
        let detail = create_folder_task_impl(&manager, input, "Resume".into(), "Extract".into(), "structured-extraction".into()).unwrap();
        manager.connection().unwrap().execute("UPDATE folder_tasks SET status = 'failed' WHERE id = ?1", [&detail.summary.id]).unwrap();
        let resumed = set_folder_task_status_impl(&manager, &detail.summary.id, "resume", detail.summary.revision).unwrap();
        assert_eq!(resumed.summary.status, FolderTaskStatus::AwaitingPlanConfirmation);
        assert!(resumed.confirmed_plan_hash.is_none());
        assert_eq!(resumed.summary.progress.pending, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ending_before_confirming_the_plan_records_a_failed_run() {
        let root = tempdir("missing-plan");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("one.txt"), "one").unwrap();
        let manager = manager(&root);
        let detail = create_folder_task_impl(
            &manager,
            input,
            "Protocol".into(),
            "Require a confirmed plan".into(),
            "structured-extraction".into(),
        )
        .unwrap();

        let detail = finish_folder_task_run_impl(
            &manager,
            &detail.summary.id,
            "run-no-plan",
            "completed",
            None,
        )
        .unwrap();

        assert_eq!(
            detail.summary.status,
            FolderTaskStatus::AwaitingPlanConfirmation
        );
        assert_eq!(detail.recent_runs[0].status, "failed");
        assert_eq!(
            detail.recent_runs[0].error.as_deref(),
            Some("Agent run ended before confirming the FolderTask plan")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ending_before_claiming_runnable_work_fails_the_task() {
        let root = tempdir("missing-claim");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("one.txt"), "one").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input,
            "Protocol".into(),
            "Require a claim".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();

        detail = finish_folder_task_run_impl(
            &manager,
            &detail.summary.id,
            "run-no-claim",
            "completed",
            None,
        )
        .unwrap();

        assert_eq!(detail.summary.status, FolderTaskStatus::Failed);
        assert_eq!(detail.summary.progress.pending, 1);
        assert_eq!(detail.recent_runs[0].status, "failed");
        assert_eq!(
            detail.recent_runs[0].error.as_deref(),
            Some("Agent run ended before claiming or checkpointing all FolderTask work")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_checkpointed_run_can_finish_while_a_later_batch_remains() {
        let root = tempdir("checkpointed-run");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("one.txt"), "one").unwrap();
        fs::write(input.join("two.txt"), "two").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input,
            "Protocol".into(),
            "One batch per run".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        detail.plan.batch_size = 1;
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        let batch =
            claim_folder_task_batch_impl(&manager, &detail.summary.id, "run-checkpointed", 1)
                .unwrap();
        let token = batch.batch.as_ref().unwrap().lease_token.clone();
        detail = update_folder_task_batch_impl(
            &manager,
            &detail.summary.id,
            "run-checkpointed",
            &token,
            vec![FolderTaskItemUpdate {
                item_id: batch.items[0].id.clone(),
                status: "completed".into(),
                result: Some(extraction_result("one batch")),
                error: None,
            }],
            None,
            "complete",
        )
        .unwrap();
        assert_eq!(detail.summary.status, FolderTaskStatus::Running);
        assert_eq!(detail.summary.progress.pending, 1);

        detail = finish_folder_task_run_impl(
            &manager,
            &detail.summary.id,
            "run-checkpointed",
            "completed",
            None,
        )
        .unwrap();

        assert_eq!(detail.summary.status, FolderTaskStatus::Running);
        assert_eq!(detail.summary.progress.pending, 1);
        assert_eq!(detail.recent_runs[0].status, "completed");
        assert!(detail.recent_runs[0].error.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn review_can_retry_failures_but_rejects_results_outside_the_recipe_contract() {
        let root = tempdir("review");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("one.txt"), "one").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input,
            "Review".into(),
            "Review failures".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        let batch = claim(&manager, &detail.summary.id, "run-review");
        let token = batch.batch.as_ref().unwrap().lease_token.clone();
        let item_id = batch.items[0].id.clone();
        detail = update_folder_task_batch_impl(
            &manager,
            &detail.summary.id,
            "run-review",
            &token,
            vec![FolderTaskItemUpdate {
                item_id: item_id.clone(),
                status: "failed".into(),
                result: None,
                error: Some("parse failed".into()),
            }],
            None,
            "complete",
        )
        .unwrap();
        assert_eq!(detail.summary.status, FolderTaskStatus::Reviewing);
        let invalid = review_folder_task_items_impl(
            &manager,
            &detail.summary.id,
            vec![FolderTaskReviewUpdate {
                item_id: item_id.clone(),
                action: "accept".into(),
                result: Some(json!({ "summary": "missing facts" })),
                error: None,
            }],
            detail.summary.revision,
        );
        assert!(invalid.unwrap_err().contains("facts"));
        detail = review_folder_task_items_impl(
            &manager,
            &detail.summary.id,
            vec![FolderTaskReviewUpdate {
                item_id,
                action: "retry".into(),
                result: None,
                error: None,
            }],
            detail.summary.revision,
        )
        .unwrap();
        assert_eq!(detail.summary.status, FolderTaskStatus::Running);
        assert_eq!(detail.summary.progress.pending, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn optimistic_revision_prevents_double_decisions() {
        let root = tempdir("revision");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("legacy.wps"), "legacy").unwrap();
        let manager = manager(&root);
        let detail = create_folder_task_impl(
            &manager,
            input,
            "Review".into(),
            "Review formats".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        let decision = detail.decisions[0].clone();
        resolve_folder_task_decision_impl(
            &manager,
            &detail.summary.id,
            &decision.id,
            "skip",
            None,
            false,
            detail.summary.revision,
        )
        .unwrap();
        let stale = resolve_folder_task_decision_impl(
            &manager,
            &detail.summary.id,
            &decision.id,
            "skip",
            None,
            false,
            detail.summary.revision,
        );
        assert!(stale.unwrap_err().contains("changed"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reader_rejects_files_changed_after_inventory() {
        let root = tempdir("changed-file");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("one.txt"), "before").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input.clone(),
            "Changed file".into(),
            "Do not process stale bytes".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        let batch = claim(&manager, &detail.summary.id, "run-changed-file");
        let token = batch.batch.as_ref().unwrap().lease_token.clone();
        fs::write(input.join("one.txt"), "after with different size").unwrap();
        let error = read_folder_task_file_bytes_impl(
            &manager,
            &detail.summary.id,
            "run-changed-file",
            &token,
            "one.txt",
        )
        .unwrap_err();
        assert!(error.contains("changed after inventory"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn future_schema_is_not_silently_downgraded() {
        let root = tempdir("future-schema");
        let database = root.join("tasks.sqlite3");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE folder_task_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO folder_task_meta(key, value) VALUES ('schema_version', '99');",
            )
            .unwrap();
        drop(connection);
        let error = match FolderTaskManager::for_test(database) {
            Ok(_) => panic!("future schema was accepted"),
            Err(error) => error,
        };
        assert!(error.contains("newer than supported schema"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn decision_pause_closes_the_run_without_marking_the_task_failed() {
        let root = tempdir("decision-pause-run");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("one.txt"), "ambiguous").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input,
            "Decision pause".into(),
            "Pause cleanly for a user decision".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        let batch = claim(&manager, &detail.summary.id, "run-decision-pause");
        let token = batch.batch.as_ref().unwrap().lease_token.clone();
        request_folder_task_decision_impl(
            &manager,
            &detail.summary.id,
            Some("run-decision-pause"),
            Some(&token),
            NewDecisionRequest {
                kind: "classification".into(),
                title: "选择分类".into(),
                description: "文件需要人工分类".into(),
                evidence: json!({ "path": "one.txt" }),
                options: vec![
                    DecisionOption {
                        id: "a".into(),
                        label: "A".into(),
                        description: "A".into(),
                    },
                    DecisionOption {
                        id: "b".into(),
                        label: "B".into(),
                        description: "B".into(),
                    },
                ],
                recommended_option_id: Some("a".into()),
                affected_item_ids: vec![batch.items[0].id.clone()],
                apply_key: None,
            },
        )
        .unwrap();
        detail = finish_folder_task_run_impl(
            &manager,
            &detail.summary.id,
            "run-decision-pause",
            "completed",
            None,
        )
        .unwrap();
        assert_eq!(detail.summary.status, FolderTaskStatus::AwaitingDecision);
        assert!(detail.active_batch.is_none());
        assert_eq!(detail.recent_runs[0].status, "completed");
        assert_eq!(detail.summary.progress.pending_decision, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preview_token_binds_the_latest_complete_plan_and_inventory() {
        let root = tempdir("plan-preview");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("one.txt"), "one").unwrap();
        let manager = manager(&root);
        let detail = create_folder_task_impl(
            &manager,
            input,
            "Preview".into(),
            "Bind the plan".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        let first = preview_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan.clone(),
            detail.summary.revision,
        )
        .unwrap();
        let mut changed = detail.plan.clone();
        changed.batch_size = 1;
        let second = preview_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            changed,
            detail.summary.revision,
        )
        .unwrap();
        assert_ne!(first.confirmation_token, second.confirmation_token);
        assert!(confirm_previewed_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            &first.confirmation_token,
            detail.summary.revision
        )
        .is_err());
        let confirmed = confirm_previewed_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            &second.confirmation_token,
            detail.summary.revision,
        )
        .unwrap();
        assert_eq!(
            confirmed.confirmed_plan_hash.as_deref(),
            Some(second.confirmation_token.as_str())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sha256_rejects_changed_content_even_when_metadata_snapshot_is_updated() {
        let root = tempdir("content-hash");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        let file = input.join("one.txt");
        fs::write(&file, "aaaaaa").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input,
            "Hash".into(),
            "Verify content".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        let batch = claim(&manager, &detail.summary.id, "run-hash");
        let token = batch.batch.as_ref().unwrap().lease_token.clone();
        fs::write(&file, "bbbbbb").unwrap();
        let modified_at = fs::metadata(&file)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        manager
            .connection()
            .unwrap()
            .execute(
                "UPDATE folder_task_items SET modified_at = ?1 WHERE task_id = ?2",
                params![modified_at, detail.summary.id],
            )
            .unwrap();
        let error = read_folder_task_file_bytes_impl(
            &manager,
            &detail.summary.id,
            "run-hash",
            &token,
            "one.txt",
        )
        .unwrap_err();
        assert!(error.contains("SHA-256"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn adaptive_batch_obeys_estimated_character_budget() {
        let root = tempdir("adaptive-batch");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("a.txt"), "a".repeat(600)).unwrap();
        fs::write(input.join("b.txt"), "b".repeat(600)).unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input,
            "Budget".into(),
            "Bound context".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        detail.plan.resource_limits.max_batch_estimated_characters = 1_000;
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        let batch = claim(&manager, &detail.summary.id, "run-budget");
        assert_eq!(batch.items.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn xlsx_preserves_scalar_types_and_does_not_infer_numbers_or_formulas_from_text() {
        let mut item = completed_extraction_item("typed", "one.txt", "amount", json!(42.5));
        item.result = Some(json!({
            "summary": "ok", "confidence": 0.75,
            "facts": [
                { "label": "amount", "value": 42.5 },
                { "label": "flag", "value": false },
                { "label": "identifier", "value": "00123" },
                { "label": "note", "value": "=1+1" }
            ]
        }));
        let bytes = build_xlsx_output(&json!({ "summary": { "records": 1 } }), &[item]).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut results = String::new();
        archive.by_name("xl/worksheets/sheet2.xml").unwrap().read_to_string(&mut results).unwrap();
        assert!(results.contains(r#"<c r="G2" t="n"><v>0.75</v></c>"#));
        assert!(results.contains(r#"<c r="K2" t="n"><v>42.5</v></c>"#));
        assert!(results.contains(r#"<c r="M2" t="b"><v>0</v></c>"#));
        assert!(results.contains(r#"<c r="O2" t="inlineStr"><is><t xml:space="preserve">00123</t></is></c>"#));
        assert!(results.contains(r#"<c r="Q2" t="inlineStr"><is><t xml:space="preserve">=1+1</t></is></c>"#));
        assert!(!results.contains("<f>"));
        let mut summary = String::new();
        archive.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut summary).unwrap();
        assert!(summary.contains(r#"<c r="B2" t="n"><v>1</v></c>"#));
    }

    #[test]
    fn automatic_xlsx_output_is_deterministic_and_recorded() {
        let root = tempdir("xlsx-output");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("one.txt"), "one").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input.clone(),
            "Output".into(),
            "Write report".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        detail.plan.completion_policy = "complete_after_processing".into();
        detail.plan.output = FolderTaskOutputPlan {
            format: "xlsx".into(),
            relative_path: ".solidify/outputs/result.xlsx".into(),
            overwrite: true,
            auto_write: true,
        };
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        let batch = claim(&manager, &detail.summary.id, "run-output");
        let token = batch.batch.as_ref().unwrap().lease_token.clone();
        detail = update_folder_task_batch_impl(
            &manager,
            &detail.summary.id,
            "run-output",
            &token,
            vec![FolderTaskItemUpdate {
                item_id: batch.items[0].id.clone(),
                status: "completed".into(),
                result: Some(extraction_result("ok")),
                error: None,
            }],
            None,
            "complete",
        )
        .unwrap();
        assert_eq!(detail.summary.status, FolderTaskStatus::Completed);
        let output = detail.latest_output.clone().unwrap();
        assert_eq!(output.format, "xlsx");
        let bytes = fs::read(input.join(&output.relative_path)).unwrap();
        assert_eq!(&bytes[..2], b"PK");
        let mut archive = zip::ZipArchive::new(Cursor::new(&bytes)).unwrap();
        let mut results_xml = String::new();
        archive.by_name("xl/worksheets/sheet2.xml").unwrap().read_to_string(&mut results_xml).unwrap();
        assert!(results_xml.contains("摘要"));
        assert!(results_xml.contains("审查发现"));
        assert!(!results_xml.contains("&quot;summary&quot;"));
        assert_eq!(sha256_bytes(&bytes), output.content_hash);
        let rewritten =
            write_folder_task_output_impl(&manager, &detail.summary.id, detail.summary.revision)
                .unwrap();
        assert_eq!(
            rewritten.latest_output.unwrap().content_hash,
            output.content_hash,
            "the same confirmed task must produce byte-identical XLSX output"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn automatic_output_conflict_preserves_the_final_checkpoint_for_review() {
        let root = tempdir("output-conflict");
        let input = root.join("input");
        fs::create_dir_all(input.join(".solidify/outputs")).unwrap();
        fs::write(input.join("one.txt"), "one").unwrap();
        fs::write(input.join(".solidify/outputs/result.json"), "user-owned").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input.clone(),
            "Output conflict".into(),
            "Do not lose checkpoint".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        detail.plan.completion_policy = "complete_after_processing".into();
        detail.plan.output = FolderTaskOutputPlan {
            format: "json".into(),
            relative_path: ".solidify/outputs/result.json".into(),
            overwrite: false,
            auto_write: true,
        };
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        let batch = claim(&manager, &detail.summary.id, "run-output-conflict");
        let token = batch.batch.as_ref().unwrap().lease_token.clone();
        detail = update_folder_task_batch_impl(
            &manager,
            &detail.summary.id,
            "run-output-conflict",
            &token,
            vec![FolderTaskItemUpdate {
                item_id: batch.items[0].id.clone(),
                status: "completed".into(),
                result: Some(extraction_result("ok")),
                error: None,
            }],
            None,
            "complete",
        )
        .unwrap();
        assert_eq!(detail.summary.status, FolderTaskStatus::Reviewing);
        assert_eq!(detail.summary.progress.completed, 1);
        assert!(detail.latest_output.is_none());
        assert!(detail
            .recent_events
            .iter()
            .any(|event| event.event_type == "output.failed"));
        assert!(set_folder_task_status_impl(
            &manager,
            &detail.summary.id,
            "complete",
            detail.summary.revision,
        )
        .unwrap_err()
        .contains("missing or stale"));
        assert_eq!(
            fs::read_to_string(input.join(".solidify/outputs/result.json")).unwrap(),
            "user-owned"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn non_owner_run_failure_cannot_fail_an_owned_active_batch() {
        let root = tempdir("run-owner");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("one.txt"), "one").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input,
            "Owner".into(),
            "Keep ownership".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        let owned = claim(&manager, &detail.summary.id, "run-owner");
        detail = finish_folder_task_run_impl(
            &manager,
            &detail.summary.id,
            "run-intruder",
            "failed",
            Some("claim conflict".into()),
        )
        .unwrap();
        assert_eq!(detail.summary.status, FolderTaskStatus::Running);
        assert_eq!(detail.active_batch.unwrap().id, owned.batch.unwrap().id);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn output_symlink_escape_is_rejected_before_creating_external_directories() {
        use std::os::unix::fs::symlink;

        let root = tempdir("output-symlink");
        let input = root.join("input");
        let outside = root.join("outside");
        fs::create_dir_all(&input).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, input.join("escape")).unwrap();
        let output = FolderTaskOutputPlan {
            format: "json".into(),
            relative_path: "escape/new/result.json".into(),
            overwrite: true,
            auto_write: false,
        };

        let error = write_output_bytes(
            input.to_str().unwrap(),
            &output,
            &[],
            b"{}",
            &sha256_bytes(b"{}"),
            None,
        )
        .unwrap_err();

        assert!(error.contains("escapes the workspace"));
        assert!(!outside.join("new").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deterministic_dedupe_uses_canonical_field_names_and_aliases() {
        let mut plan = FolderTaskPlan::default_for(
            "task-dedupe",
            "structured-extraction",
            "Extract amount",
            &FolderInventory::default(),
        );
        plan.recipe_plan = json!({
            "kind": "structured-extraction",
            "schemaVersion": 1,
            "fields": [{
                "name": "Amount",
                "description": "Amount",
                "type": "number",
                "required": true,
                "aliases": ["金额"]
            }],
            "dedupeKeys": ["AMOUNT"]
        });
        let items = vec![
            completed_extraction_item("one", "one.txt", "amount", json!(12)),
            completed_extraction_item("two", "two.txt", "金额", json!(12)),
        ];

        let records = deterministic_records(&plan, &items);

        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["provenance"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn future_plan_schema_is_rejected_instead_of_normalized() {
        let mut plan = FolderTaskPlan::default_for(
            "task-future-plan",
            "structured-extraction",
            "Extract",
            &FolderInventory::default(),
        );
        plan.schema_version = current_plan_schema_version() + 1;

        assert!(plan
            .normalize_legacy("Extract")
            .unwrap_err()
            .contains("newer than supported"));
    }

    #[test]
    fn plan_preview_counts_only_actionable_pending_items() {
        let root = tempdir("preview-actionable");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("one.txt"), "one").unwrap();
        fs::write(input.join("legacy.doc"), "legacy").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input,
            "Preview".into(),
            "Count actionable files".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        let decision_id = detail
            .decisions
            .iter()
            .find(|decision| decision.status == "pending")
            .unwrap()
            .id
            .clone();
        detail = resolve_folder_task_decision_impl(
            &manager,
            &detail.summary.id,
            &decision_id,
            "attempt_external",
            None,
            false,
            detail.summary.revision,
        )
        .unwrap();

        let preview = preview_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();

        assert_eq!(preview.selected_files, 1);
        assert_eq!(preview.excluded_files, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_manual_format_queue_migrates_to_technical_parser_state() {
        let root = tempdir("migrate-manual-format");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("legacy.doc"), "legacy").unwrap();
        let manager = manager(&root);
        let detail = create_folder_task_impl(
            &manager,
            input,
            "Legacy".into(),
            "Migrate technical state".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        let connection = Connection::open(&manager.database_path).unwrap();
        connection
            .execute(
                "UPDATE folder_task_items SET status = 'manual_review', result_json = '{\"reason\":\"manual_review_queue\"}' WHERE task_id = ?1",
                [&detail.summary.id],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE folder_task_meta SET value = '5' WHERE key = 'schema_version'",
                [],
            )
            .unwrap();
        drop(connection);

        manager.connection().unwrap();
        let items = list_folder_task_items_impl(&manager, &detail.summary.id, None, 0, 10).unwrap();

        assert_eq!(items[0].status, "awaiting_external_parser");
        assert_eq!(
            items[0].result.as_ref().unwrap()["reason"],
            "external_parser_required"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn run_id_cannot_be_reused_across_folder_tasks() {
        let root = tempdir("cross-task-run");
        let first_input = root.join("first");
        let second_input = root.join("second");
        fs::create_dir_all(&first_input).unwrap();
        fs::create_dir_all(&second_input).unwrap();
        fs::write(first_input.join("one.txt"), "one").unwrap();
        fs::write(second_input.join("two.txt"), "two").unwrap();
        let manager = manager(&root);
        let mut first = create_folder_task_impl(
            &manager,
            first_input,
            "First".into(),
            "First task".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        first = confirm_folder_task_plan_impl(
            &manager,
            &first.summary.id,
            first.plan,
            first.summary.revision,
        )
        .unwrap();
        let mut second = create_folder_task_impl(
            &manager,
            second_input,
            "Second".into(),
            "Second task".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        second = confirm_folder_task_plan_impl(
            &manager,
            &second.summary.id,
            second.plan,
            second.summary.revision,
        )
        .unwrap();
        claim(&manager, &first.summary.id, "run-shared");

        assert!(
            claim_folder_task_batch_impl(&manager, &second.summary.id, "run-shared", 8)
                .unwrap_err()
                .contains("another folder task")
        );
        assert!(finish_folder_task_run_impl(
            &manager,
            &second.summary.id,
            "run-shared",
            "failed",
            Some("wrong task".into()),
        )
        .unwrap_err()
        .contains("another folder task"));
        assert!(get_folder_task_impl(&manager, &second.summary.id)
            .unwrap()
            .active_batch
            .is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reviewed_results_safely_replace_the_task_owned_automatic_output() {
        let root = tempdir("stale-output");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("one.txt"), "one").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input,
            "Stale output".into(),
            "Bind output to reviewed results".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        detail.plan.output.overwrite = false;
        detail.plan.output.auto_write = true;
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        let batch = claim(&manager, &detail.summary.id, "run-stale-output");
        let token = batch.batch.as_ref().unwrap().lease_token.clone();
        let item_id = batch.items[0].id.clone();
        detail = update_folder_task_batch_impl(
            &manager,
            &detail.summary.id,
            "run-stale-output",
            &token,
            vec![FolderTaskItemUpdate {
                item_id: item_id.clone(),
                status: "completed".into(),
                result: Some(extraction_result("before review")),
                error: None,
            }],
            None,
            "complete",
        )
        .unwrap();
        assert!(detail.latest_output.as_ref().unwrap().is_current);

        detail = set_folder_task_status_impl(&manager, &detail.summary.id, "complete", detail.summary.revision).unwrap();
        assert_eq!(detail.summary.status, FolderTaskStatus::Completed);
        detail = review_folder_task_items_impl(
            &manager,
            &detail.summary.id,
            vec![FolderTaskReviewUpdate {
                item_id,
                action: "accept".into(),
                result: Some(extraction_result("after review")),
                error: None,
            }],
            detail.summary.revision,
        )
        .unwrap();
        assert_eq!(detail.summary.status, FolderTaskStatus::Reviewing);
        assert!(detail.latest_output.as_ref().unwrap().is_current);
        detail = set_folder_task_status_impl(
            &manager,
            &detail.summary.id,
            "complete",
            detail.summary.revision,
        )
        .unwrap();
        assert_eq!(detail.summary.status, FolderTaskStatus::Completed);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn externally_changed_task_output_is_not_silently_overwritten() {
        let root = tempdir("externally-changed-output");
        let input = root.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("one.txt"), "one").unwrap();
        let manager = manager(&root);
        let mut detail = create_folder_task_impl(
            &manager,
            input.clone(),
            "Protected output".into(),
            "Keep user edits".into(),
            "structured-extraction".into(),
        )
        .unwrap();
        detail.plan.output.overwrite = false;
        detail.plan.output.auto_write = true;
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan,
            detail.summary.revision,
        )
        .unwrap();
        let batch = claim(&manager, &detail.summary.id, "run-protected-output");
        let token = batch.batch.as_ref().unwrap().lease_token.clone();
        let item_id = batch.items[0].id.clone();
        detail = update_folder_task_batch_impl(
            &manager,
            &detail.summary.id,
            "run-protected-output",
            &token,
            vec![FolderTaskItemUpdate {
                item_id: item_id.clone(),
                status: "completed".into(),
                result: Some(extraction_result("before external edit")),
                error: None,
            }],
            None,
            "complete",
        )
        .unwrap();
        let output_path = input.join(&detail.latest_output.as_ref().unwrap().relative_path);
        fs::write(&output_path, "user changed this output").unwrap();

        detail = review_folder_task_items_impl(
            &manager,
            &detail.summary.id,
            vec![FolderTaskReviewUpdate {
                item_id,
                action: "accept".into(),
                result: Some(extraction_result("after external edit")),
                error: None,
            }],
            detail.summary.revision,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(&output_path).unwrap(),
            "user changed this output"
        );
        assert!(!detail.latest_output.as_ref().unwrap().is_current);
        assert!(write_folder_task_output_impl(
            &manager,
            &detail.summary.id,
            detail.summary.revision,
        )
        .unwrap_err()
        .contains("overwrite was not confirmed"));
        fs::remove_dir_all(root).unwrap();
    }
}
