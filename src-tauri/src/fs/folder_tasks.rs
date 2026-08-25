use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

const SCHEMA_VERSION: i64 = 1;
const DEFAULT_BATCH_SIZE: u32 = 8;
const MAX_BATCH_SIZE: u32 = 20;
const MAX_MODEL_FILE_BYTES: u64 = 25 * 1024 * 1024;
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

pub struct FolderTaskManager {
    database_path: PathBuf,
}

impl FolderTaskManager {
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Unable to locate app data directory: {error}"))?;
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Unable to create app data directory: {error}"))?;
        let manager = Self {
            database_path: directory.join("folder-tasks.sqlite3"),
        };
        manager.connection()?;
        Ok(manager)
    }

    #[cfg(test)]
    fn for_test(database_path: PathBuf) -> Result<Self, String> {
        let manager = Self { database_path };
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
    pub recipe: String,
    pub batch_size: u32,
    pub output_mode: String,
    pub baseline_mode: String,
    pub review_policy: String,
    pub include_extensions: Vec<String>,
    pub exclusions: Vec<String>,
}

impl FolderTaskPlan {
    fn default_for(recipe: &str, inventory: &FolderInventory) -> Self {
        let include_extensions = inventory
            .extension_counts
            .keys()
            .filter(|extension| is_model_readable_extension(extension))
            .cloned()
            .collect();
        Self {
            recipe: recipe.to_string(),
            batch_size: DEFAULT_BATCH_SIZE,
            output_mode: "review_before_write".into(),
            baseline_mode: "incremental".into(),
            review_policy: "pause_on_ambiguity".into(),
            include_extensions,
            exclusions: vec![
                ".solidify/**".into(),
                ".git/**".into(),
                "node_modules/**".into(),
                "~$*".into(),
            ],
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.batch_size == 0 || self.batch_size > MAX_BATCH_SIZE {
            return Err(format!("Batch size must be between 1 and {MAX_BATCH_SIZE}"));
        }
        if self.recipe.trim().is_empty() {
            return Err("Recipe is required".into());
        }
        if !matches!(
            self.output_mode.as_str(),
            "review_before_write" | "export_only"
        ) {
            return Err("Unsupported output mode".into());
        }
        if !matches!(self.baseline_mode.as_str(), "incremental" | "full_rescan") {
            return Err("Unsupported baseline mode".into());
        }
        if !matches!(
            self.review_policy.as_str(),
            "pause_on_ambiguity" | "collect_until_checkpoint"
        ) {
            return Err("Unsupported review policy".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FolderInventory {
    pub files: u64,
    pub directories: u64,
    pub total_bytes: u64,
    pub readable_files: u64,
    pub attention_files: u64,
    pub top_level_groups: u64,
    pub extension_counts: BTreeMap<String, u64>,
    pub fingerprint: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTaskItem {
    pub id: String,
    pub relative_path: String,
    pub size: u64,
    pub modified_at: i64,
    pub extension: String,
    pub status: String,
    pub attempts: u32,
    pub result: Option<Value>,
    pub error: Option<String>,
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
}

#[tauri::command]
pub async fn create_folder_task(
    app: AppHandle,
    name: String,
    goal: String,
    recipe: String,
    manager: State<'_, FolderTaskManager>,
) -> Result<Option<FolderTaskDetail>, String> {
    let Some(selected) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let selected = selected
        .into_path()
        .map_err(|error| format!("Unable to use selected folder: {error}"))?;
    let database_path = manager.database_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manager = FolderTaskManager { database_path };
        create_folder_task_impl(&manager, selected, name, goal, recipe).map(Some)
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
pub async fn confirm_folder_task_plan(
    task_id: String,
    plan: FolderTaskPlan,
    expected_revision: u64,
    manager: State<'_, FolderTaskManager>,
) -> Result<FolderTaskDetail, String> {
    let database_path = manager.database_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manager = FolderTaskManager { database_path };
        confirm_folder_task_plan_impl(&manager, &task_id, plan, expected_revision)
    })
    .await
    .map_err(|error| format!("Folder inventory worker failed: {error}"))?
}

fn confirm_folder_task_plan_impl(
    manager: &FolderTaskManager,
    task_id: &str,
    plan: FolderTaskPlan,
    expected_revision: u64,
) -> Result<FolderTaskDetail, String> {
    plan.validate()?;
    let refreshed = if plan.baseline_mode == "full_rescan" {
        let connection = manager.connection()?;
        let root: String = connection
            .query_row(
                "SELECT root_path FROM folder_tasks WHERE id = ?1",
                [task_id],
                |row| row.get(0),
            )
            .map_err(|error| map_not_found(error, "Folder task"))?;
        Some(scan_inventory(task_id, Path::new(&root))?)
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
    transaction
        .execute(
            "UPDATE folder_tasks SET status = 'running', plan_json = ?1, updated_at = ?2, revision = revision + 1 WHERE id = ?3",
            params![to_json(&plan)?, now, task_id],
        )
        .map_err(|error| error.to_string())?;
    append_event(
        &transaction,
        task_id,
        "plan.confirmed",
        json!({ "plan": plan }),
        now,
    )?;
    transaction.commit().map_err(|error| error.to_string())?;
    get_folder_task_impl(manager, task_id)
}

#[tauri::command]
pub fn claim_folder_task_batch(
    task_id: String,
    limit: Option<u32>,
    manager: State<'_, FolderTaskManager>,
) -> Result<Vec<FolderTaskItem>, String> {
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
    claim_folder_task_batch_impl(&manager, &task_id, batch_limit)
}

#[tauri::command]
pub fn update_folder_task_batch(
    task_id: String,
    updates: Vec<FolderTaskItemUpdate>,
    checkpoint_note: Option<String>,
    manager: State<'_, FolderTaskManager>,
) -> Result<FolderTaskDetail, String> {
    update_folder_task_batch_impl(&manager, &task_id, updates, checkpoint_note)
}

#[tauri::command]
pub fn request_folder_task_decision(
    task_id: String,
    request: NewDecisionRequest,
    manager: State<'_, FolderTaskManager>,
) -> Result<FolderTaskDecision, String> {
    request_folder_task_decision_impl(&manager, &task_id, request)
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
pub fn set_folder_task_status(
    task_id: String,
    action: String,
    expected_revision: u64,
    manager: State<'_, FolderTaskManager>,
) -> Result<FolderTaskDetail, String> {
    set_folder_task_status_impl(&manager, &task_id, &action, expected_revision)
}

#[tauri::command]
pub fn read_folder_task_file_bytes(
    task_id: String,
    relative_path: String,
    manager: State<'_, FolderTaskManager>,
) -> Result<FolderTaskFileBytes, String> {
    read_folder_task_file_bytes_impl(&manager, &task_id, &relative_path)
}

fn migrate(connection: &Connection) -> Result<(), String> {
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
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS folder_task_items (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES folder_tasks(id) ON DELETE CASCADE,
                relative_path TEXT NOT NULL,
                size INTEGER NOT NULL,
                modified_at INTEGER NOT NULL,
                extension TEXT NOT NULL,
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
            INSERT INTO folder_task_meta(key, value) VALUES ('schema_version', '{SCHEMA_VERSION}')
                ON CONFLICT(key) DO UPDATE SET value = excluded.value;
            "
        ))
        .map_err(|error| format!("Unable to migrate folder task database: {error}"))
}

fn create_folder_task_impl(
    manager: &FolderTaskManager,
    root: PathBuf,
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
    let (inventory, items) = scan_inventory(&task_id, &root)?;
    let plan = FolderTaskPlan::default_for(recipe, &inventory);
    plan.validate()?;
    let now = now_ms()?;
    let mut connection = manager.connection()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO folder_tasks(id, name, goal, root_path, status, recipe, plan_json, inventory_json, created_at, updated_at, revision)
             VALUES (?1, ?2, ?3, ?4, 'awaiting_plan_confirmation', ?5, ?6, ?7, ?8, ?8, 1)",
            params![
                task_id,
                name,
                goal,
                root.to_string_lossy(),
                recipe,
                to_json(&plan)?,
                to_json(&inventory)?,
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
            "INSERT INTO folder_task_items(id, task_id, relative_path, size, modified_at, extension, status, attempts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
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
                item.status,
            ])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn scan_inventory(
    task_id: &str,
    root: &Path,
) -> Result<(FolderInventory, Vec<FolderTaskItem>), String> {
    let mut inventory = FolderInventory::default();
    let mut items = Vec::new();
    let mut groups = BTreeSet::new();
    let mut fingerprint = Fnv64::default();
    let excluded_root = root.to_path_buf();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .follow_links(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .filter_entry(move |entry| !is_excluded_entry(&excluded_root, entry.path()))
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
        let metadata = match entry.metadata() {
            Ok(value) => value,
            Err(error) => {
                inventory.warnings.push(format!("{relative_path}: {error}"));
                continue;
            }
        };
        let extension = normalized_extension(path);
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);
        inventory.files += 1;
        inventory.total_bytes = inventory.total_bytes.saturating_add(metadata.len());
        *inventory
            .extension_counts
            .entry(extension.clone())
            .or_insert(0) += 1;
        if is_model_readable_extension(&extension) {
            inventory.readable_files += 1;
        } else {
            inventory.attention_files += 1;
        }
        items.push(FolderTaskItem {
            id: format!("{task_id}:{}", items.len() + 1),
            relative_path,
            size: metadata.len(),
            modified_at,
            extension,
            status: "pending".into(),
            attempts: 0,
            result: None,
            error: None,
        });
    }
    items.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    for item in &items {
        item.relative_path.hash(&mut fingerprint);
        item.size.hash(&mut fingerprint);
        item.modified_at.hash(&mut fingerprint);
    }
    inventory.top_level_groups = groups.len() as u64;
    inventory.fingerprint = format!("fnv64-{:016x}", fingerprint.finish());
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
        .filter(|(extension, _)| !is_model_readable_extension(extension))
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
                    id: "queue_manual_review".into(),
                    label: "进入人工复核队列".into(),
                    description: "保留文件和证据路径，不让模型猜测内容。".into(),
                },
                DecisionOption {
                    id: "skip".into(),
                    label: "跳过这些格式".into(),
                    description: "本次任务不处理这些文件。".into(),
                },
                DecisionOption {
                    id: "attempt_external".into(),
                    label: "允许外部解析器".into(),
                    description: "后续配置解析器后再处理，当前保持待处理。".into(),
                },
            ],
            recommended_option_id: Some("queue_manual_review".into()),
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
    let plan_json: String = connection
        .query_row(
            "SELECT plan_json FROM folder_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| map_not_found(error, "Folder task"))?;
    let plan = from_json(&plan_json, "folder task plan")?;
    let decisions = list_decisions(&connection, task_id)?;
    let recent_events = list_events(&connection, task_id, 100)?;
    Ok(FolderTaskDetail {
        summary,
        plan,
        decisions,
        recent_events,
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
                 ORDER BY CASE status WHEN 'failed' THEN 0 WHEN 'pending_decision' THEN 1 WHEN 'processing' THEN 2 ELSE 3 END,
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
        "pending" | "processing" | "completed" | "skipped" | "failed" | "pending_decision"
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
            _ => {}
        }
    }
    Ok(result)
}

fn claim_folder_task_batch_impl(
    manager: &FolderTaskManager,
    task_id: &str,
    limit: u32,
) -> Result<Vec<FolderTaskItem>, String> {
    validate_id(task_id)?;
    if limit == 0 || limit > MAX_BATCH_SIZE {
        return Err(format!(
            "Batch limit must be between 1 and {MAX_BATCH_SIZE}"
        ));
    }
    let mut connection = manager.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let (status, _) = current_status_and_revision(&transaction, task_id)?;
    if status != FolderTaskStatus::Running {
        return Err(format!("Folder task is {}, not running", status.as_str()));
    }
    let mut processing_statement = transaction
        .prepare(
            "SELECT id FROM folder_task_items WHERE task_id = ?1 AND status = 'processing'
             ORDER BY relative_path LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let processing_ids = processing_statement
        .query_map(params![task_id, limit], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(processing_statement);
    if !processing_ids.is_empty() {
        return processing_ids
            .iter()
            .map(|id| get_item(&transaction, task_id, id))
            .collect();
    }
    let mut statement = transaction
        .prepare(
            "SELECT id FROM folder_task_items WHERE task_id = ?1 AND status = 'pending'
             ORDER BY relative_path LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let ids = statement
        .query_map(params![task_id, limit], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    if ids.is_empty() {
        let processing: u64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM folder_task_items WHERE task_id = ?1 AND status = 'processing'",
                [task_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if processing == 0 {
            let now = now_ms()?;
            transaction
                .execute(
                    "UPDATE folder_tasks SET status = 'reviewing', updated_at = ?1, revision = revision + 1 WHERE id = ?2",
                    params![now, task_id],
                )
                .map_err(|error| error.to_string())?;
            append_event(&transaction, task_id, "task.reviewing", json!({}), now)?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(Vec::new());
    }
    let now = now_ms()?;
    for id in &ids {
        transaction
            .execute(
                "UPDATE folder_task_items SET status = 'processing', attempts = attempts + 1 WHERE id = ?1 AND task_id = ?2 AND status = 'pending'",
                params![id, task_id],
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
        json!({ "itemIds": ids }),
        now,
    )?;
    let items = ids
        .iter()
        .map(|id| get_item(&transaction, task_id, id))
        .collect::<Result<Vec<_>, _>>()?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(items)
}

fn update_folder_task_batch_impl(
    manager: &FolderTaskManager,
    task_id: &str,
    updates: Vec<FolderTaskItemUpdate>,
    checkpoint_note: Option<String>,
) -> Result<FolderTaskDetail, String> {
    validate_id(task_id)?;
    if updates.is_empty() || updates.len() > MAX_BATCH_SIZE as usize {
        return Err(format!(
            "A batch update must contain 1 to {MAX_BATCH_SIZE} items"
        ));
    }
    let mut seen = BTreeSet::new();
    for update in &updates {
        if !seen.insert(&update.item_id) {
            return Err(format!("Duplicate item update: {}", update.item_id));
        }
        if !matches!(
            update.status.as_str(),
            "completed" | "skipped" | "failed" | "pending_decision"
        ) {
            return Err(format!("Unsupported item status: {}", update.status));
        }
    }
    let mut connection = manager.connection()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let (status, _) = current_status_and_revision(&transaction, task_id)?;
    if status != FolderTaskStatus::Running && status != FolderTaskStatus::AwaitingDecision {
        return Err(format!(
            "Folder task cannot accept item updates while {}",
            status.as_str()
        ));
    }
    for update in &updates {
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
    let now = now_ms()?;
    transaction
        .execute(
            "UPDATE folder_tasks SET updated_at = ?1, revision = revision + 1 WHERE id = ?2",
            params![now, task_id],
        )
        .map_err(|error| error.to_string())?;
    append_event(
        &transaction,
        task_id,
        "batch.checkpointed",
        json!({
            "updates": updates.iter().map(|item| json!({ "itemId": item.item_id, "status": item.status })).collect::<Vec<_>>(),
            "note": checkpoint_note,
        }),
        now,
    )?;
    let unfinished: u64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM folder_task_items WHERE task_id = ?1 AND status IN ('pending', 'processing')",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let pending_decisions: u64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM folder_task_decisions WHERE task_id = ?1 AND status = 'pending'",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if unfinished == 0 && pending_decisions == 0 {
        transaction
            .execute(
                "UPDATE folder_tasks SET status = 'reviewing' WHERE id = ?1 AND status = 'running'",
                [task_id],
            )
            .map_err(|error| error.to_string())?;
        append_event(&transaction, task_id, "task.reviewing", json!({}), now)?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    get_folder_task_impl(manager, task_id)
}

fn request_folder_task_decision_impl(
    manager: &FolderTaskManager,
    task_id: &str,
    request: NewDecisionRequest,
) -> Result<FolderTaskDecision, String> {
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
    transaction
        .execute(
            "UPDATE folder_tasks SET status = 'awaiting_decision', updated_at = ?1, revision = revision + 1 WHERE id = ?2",
            params![now, task_id],
        )
        .map_err(|error| error.to_string())?;
    append_event(
        &transaction,
        task_id,
        "decision.requested",
        json!({ "decisionId": decision.id, "kind": decision.kind }),
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
                     WHERE task_id = ?2 AND status = 'pending' AND extension NOT IN ('txt','md','markdown','csv','json','yaml','yml','xml','html','htm','log','docx','xlsx','pdf')",
                    params![json!({ "reason": "unsupported_format_policy" }).to_string(), task_id],
                )
                .map_err(|error| error.to_string())?;
        }
        "queue_manual_review" => {
            transaction
                .execute(
                    "UPDATE folder_task_items SET status = 'pending_decision', result_json = ?1
                     WHERE task_id = ?2 AND status = 'pending' AND extension NOT IN ('txt','md','markdown','csv','json','yaml','yml','xml','html','htm','log','docx','xlsx','pdf')",
                    params![json!({ "reason": "manual_review_queue" }).to_string(), task_id],
                )
                .map_err(|error| error.to_string())?;
        }
        "attempt_external" => {
            transaction
                .execute(
                    "UPDATE folder_task_items SET status = 'pending_decision', result_json = ?1
                     WHERE task_id = ?2 AND status = 'pending' AND extension NOT IN ('txt','md','markdown','csv','json','yaml','yml','xml','html','htm','log','docx','xlsx','pdf')",
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
    resolution
        .map(|value| {
            let parsed: Value = from_json(&value, "unsupported format resolution")?;
            parsed
                .get("optionId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| "Unsupported format resolution has no optionId".into())
        })
        .transpose()
}

fn set_folder_task_status_impl(
    manager: &FolderTaskManager,
    task_id: &str,
    action: &str,
    expected_revision: u64,
) -> Result<FolderTaskDetail, String> {
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
            FolderTaskStatus::Running
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
        if progress.pending + progress.processing > 0 {
            return Err("Task still has unfinished items".into());
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
    relative_path: &str,
) -> Result<FolderTaskFileBytes, String> {
    validate_id(task_id)?;
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
    let claimed: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM folder_task_items WHERE task_id = ?1 AND relative_path = ?2 AND status = 'processing')",
            params![task_id, portable_path(&relative)],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !claimed {
        return Err("File is not part of the currently claimed batch".into());
    }
    let canonical_root = fs::canonicalize(&root).map_err(|error| error.to_string())?;
    let path = canonical_root.join(relative);
    let canonical =
        fs::canonicalize(&path).map_err(|error| format!("Task file is not accessible: {error}"))?;
    if !canonical.starts_with(&canonical_root) || !canonical.is_file() {
        return Err("Task file escaped the authorized folder".into());
    }
    let metadata = fs::metadata(&canonical).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_MODEL_FILE_BYTES {
        return Err(format!(
            "File is {} bytes; the built-in reader limit is {MAX_MODEL_FILE_BYTES} bytes. Queue it for a specialized parser.",
            metadata.len()
        ));
    }
    let bytes = fs::read(&canonical).map_err(|error| error.to_string())?;
    Ok(FolderTaskFileBytes {
        name: canonical
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("file")
            .to_string(),
        bytes,
        size: metadata.len(),
    })
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
            "SELECT id, relative_path, size, modified_at, extension, status, attempts, result_json, error
             FROM folder_task_items WHERE task_id = ?1 AND id = ?2",
            params![task_id, item_id],
            |row| Ok((
                row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, u64>(2)?,
                row.get::<_, i64>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                row.get::<_, u32>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, Option<String>>(8)?,
            )),
        )
        .map_err(|error| map_not_found(error, "Folder task item"))
        .and_then(|row| Ok(FolderTaskItem {
            id: row.0,
            relative_path: row.1,
            size: row.2,
            modified_at: row.3,
            extension: row.4,
            status: row.5,
            attempts: row.6,
            result: row.7.map(|value| from_json(&value, "item result")).transpose()?,
            error: row.8,
        }))
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
    events.reverse();
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

#[derive(Default)]
struct Fnv64(u64);

impl Hasher for Fnv64 {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        let mut hash = if self.0 == 0 {
            0xcbf29ce484222325
        } else {
            self.0
        };
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        self.0 = hash;
    }
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

    fn manager(root: &Path) -> FolderTaskManager {
        FolderTaskManager::for_test(root.join("tasks.sqlite3")).unwrap()
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
            "cloud-resource-discovery".into(),
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
        let batch = claim_folder_task_batch_impl(&manager, &detail.summary.id, 8).unwrap();
        assert_eq!(batch.len(), 1);
        detail = update_folder_task_batch_impl(
            &manager,
            &detail.summary.id,
            vec![FolderTaskItemUpdate {
                item_id: batch[0].id.clone(),
                status: "completed".into(),
                result: Some(json!({ "matched": true })),
                error: None,
            }],
            Some("first checkpoint".into()),
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
            "custom".into(),
        )
        .unwrap();
        assert!(
            read_folder_task_file_bytes_impl(&manager, &detail.summary.id, "inside.txt").is_err()
        );
        detail = confirm_folder_task_plan_impl(
            &manager,
            &detail.summary.id,
            detail.plan.clone(),
            detail.summary.revision,
        )
        .unwrap();
        let claimed = claim_folder_task_batch_impl(&manager, &detail.summary.id, 8).unwrap();
        assert_eq!(claimed.len(), 1);
        assert!(
            read_folder_task_file_bytes_impl(&manager, &detail.summary.id, "inside.txt").is_ok()
        );
        assert!(
            read_folder_task_file_bytes_impl(&manager, &detail.summary.id, "../outside.txt")
                .is_err()
        );
        assert!(
            read_folder_task_file_bytes_impl(&manager, &detail.summary.id, "missing.txt").is_err()
        );
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
            "custom".into(),
        )
        .unwrap();
        fs::write(input.join("second.md"), "two").unwrap();
        detail.plan.baseline_mode = "full_rescan".into();
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
            "custom".into(),
        )
        .unwrap();
        fs::write(input.join("legacy.wps"), "legacy").unwrap();
        detail.plan.baseline_mode = "full_rescan".into();
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
            "custom".into(),
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
}
