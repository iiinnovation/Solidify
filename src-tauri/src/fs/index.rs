use super::sandbox::resolve_in_workspace;
use super::tree::read_tree_impl;
use super::workspace::WorkspaceAuthorization;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::fs;
use std::path::Path;
use tauri::State;

const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub files: u64,
    pub indexed_documents: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexSearchMatch {
    pub path: String,
    pub text: String,
    pub score: f64,
}

#[tauri::command(async)]
pub fn initialize_index(
    workspace_root: String,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<IndexStats, String> {
    authorization.require(&workspace_root)?;
    let connection = open_index(&workspace_root)?;
    stats(&connection)
}

#[tauri::command(async)]
pub fn rebuild_index(
    workspace_root: String,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<IndexStats, String> {
    authorization.require(&workspace_root)?;
    rebuild_index_impl(&workspace_root)
}

pub fn rebuild_index_impl(workspace_root: &str) -> Result<IndexStats, String> {
    let mut connection = open_index(workspace_root)?;
    let entries = read_tree_impl(workspace_root)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM files_fts", [])
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM files", [])
        .map_err(|error| error.to_string())?;

    for entry in entries.iter().filter(|entry| entry.kind == "file") {
        let absolute = resolve_in_workspace(&entry.path, workspace_root, false)?;
        let kind = file_kind(&absolute);
        let content = extract_plain_text(&absolute, entry.size);
        transaction
            .execute(
                "INSERT INTO files(path, size, mtime, kind, extracted_at) VALUES (?1, ?2, ?3, ?4, CASE WHEN ?5 IS NULL THEN NULL ELSE unixepoch() END)",
                params![entry.path, entry.size as i64, entry.modified_at as i64, kind, content],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO files_fts(path, content) VALUES (?1, ?2)",
                params![entry.path, content.unwrap_or_default()],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    stats(&connection)
}

#[tauri::command(async)]
pub fn upsert_index_document(
    workspace_root: String,
    path: String,
    content: Option<String>,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<(), String> {
    authorization.require(&workspace_root)?;
    let absolute = resolve_in_workspace(&path, &workspace_root, false)?;
    let metadata = fs::metadata(&absolute).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Only files can be indexed".into());
    }
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as i64)
        .unwrap_or_default();
    let connection = open_index(&workspace_root)?;
    upsert_document(
        &connection,
        &path,
        metadata.len(),
        modified_at,
        file_kind(&absolute),
        content.as_deref(),
    )
}

#[tauri::command(async)]
pub fn remove_index_path(
    workspace_root: String,
    path: String,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<(), String> {
    authorization.require(&workspace_root)?;
    remove_index_path_impl(&workspace_root, &path)
}

pub fn remove_index_path_impl(workspace_root: &str, path: &str) -> Result<(), String> {
    let connection = open_index(&workspace_root)?;
    connection
        .execute(
            "DELETE FROM files_fts WHERE path = ?1 OR instr(path, ?1 || '/') = 1",
            params![path],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "DELETE FROM files WHERE path = ?1 OR instr(path, ?1 || '/') = 1",
            params![path],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn search_index(
    workspace_root: String,
    query: String,
    max_results: Option<usize>,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<Vec<IndexSearchMatch>, String> {
    authorization.require(&workspace_root)?;
    search_index_impl(&workspace_root, &query, max_results.unwrap_or(50))
}

pub fn search_index_impl(
    workspace_root: &str,
    query: &str,
    max_results: usize,
) -> Result<Vec<IndexSearchMatch>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let connection = open_index(workspace_root)?;
    let max_results = max_results.clamp(1, 1_000) as i64;
    if query.chars().count() < 3 {
        let pattern = format!("%{}%", escape_like(query));
        // `substr` bounds what comes back. Selecting raw `content` returned up
        // to `max_results` WHOLE files (2 MiB each) for a two-character query —
        // trivially common in Chinese — which both dwarfs the caller's context
        // budget and can materialise gigabytes in one call.
        let mut statement = connection
            .prepare(
                "SELECT path, substr(content, 1, 200), 0.0 FROM files_fts \
                 WHERE path LIKE ?1 ESCAPE '\\' OR content LIKE ?1 ESCAPE '\\' \
                 ORDER BY path LIMIT ?2",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![pattern, max_results], |row| {
                Ok(IndexSearchMatch {
                    path: row.get(0)?,
                    text: row.get(1)?,
                    score: row.get(2)?,
                })
            })
            .map_err(|error| error.to_string())?;
        return rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string());
    }
    let escaped = format!("\"{}\"", query.replace('"', "\"\""));
    let mut statement = connection
        .prepare("SELECT path, snippet(files_fts, 1, '', '', ' … ', 24), bm25(files_fts) FROM files_fts WHERE files_fts MATCH ?1 ORDER BY bm25(files_fts) LIMIT ?2")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![escaped, max_results], |row| {
            Ok(IndexSearchMatch {
                path: row.get(0)?,
                text: row.get(1)?,
                score: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[tauri::command(async)]
pub fn index_stats(
    workspace_root: String,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<IndexStats, String> {
    authorization.require(&workspace_root)?;
    stats(&open_index(&workspace_root)?)
}

fn open_index(workspace_root: &str) -> Result<Connection, String> {
    let metadata_dir = Path::new(workspace_root).join(".solidify");
    fs::create_dir_all(&metadata_dir).map_err(|error| error.to_string())?;
    let connection =
        Connection::open(metadata_dir.join("index.db")).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS files (
               path TEXT PRIMARY KEY,
               size INTEGER NOT NULL,
               mtime INTEGER NOT NULL,
               content_hash TEXT,
               kind TEXT,
               extracted_at INTEGER
             );
             CREATE TABLE IF NOT EXISTS chunks (
               chunk_id TEXT PRIMARY KEY,
               path TEXT NOT NULL,
               ordinal INTEGER NOT NULL,
               text TEXT NOT NULL,
               embedding BLOB,
               FOREIGN KEY(path) REFERENCES files(path) ON DELETE CASCADE
             );",
        )
        .map_err(|error| format!("Unable to initialize workspace index: {error}"))?;
    let fts_schema = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'files_fts'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if fts_schema
        .as_deref()
        .is_some_and(|schema| schema.contains("path UNINDEXED"))
    {
        connection
            .execute("DROP TABLE files_fts", [])
            .map_err(|error| error.to_string())?;
    }
    connection
        .execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(path, content, tokenize='trigram')",
            [],
        )
        .map_err(|error| format!("Unable to initialize workspace full-text index: {error}"))?;
    Ok(connection)
}

fn upsert_document(
    connection: &Connection,
    path: &str,
    size: u64,
    mtime: i64,
    kind: &str,
    content: Option<&str>,
) -> Result<(), String> {
    connection
        .execute("DELETE FROM files_fts WHERE path = ?1", params![path])
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO files(path, size, mtime, kind, extracted_at) VALUES (?1, ?2, ?3, ?4, CASE WHEN ?5 IS NULL THEN NULL ELSE unixepoch() END)
             ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, kind=excluded.kind, extracted_at=excluded.extracted_at",
            params![path, size as i64, mtime, kind, content],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO files_fts(path, content) VALUES (?1, ?2)",
            params![path, content.unwrap_or_default()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn stats(connection: &Connection) -> Result<IndexStats, String> {
    let files = connection
        .query_row("SELECT count(*) FROM files", [], |row| row.get::<_, u64>(0))
        .map_err(|error| error.to_string())?;
    let indexed_documents = connection
        .query_row(
            "SELECT count(*) FROM files WHERE extracted_at IS NOT NULL",
            [],
            |row| row.get::<_, u64>(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(IndexStats {
        files,
        indexed_documents,
    })
}

fn file_kind(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("md" | "txt" | "rst" | "html" | "css" | "json" | "yaml" | "yml" | "toml" | "csv") => {
            "document"
        }
        Some("doc" | "docx") => "word",
        Some("pdf") => "pdf",
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "svg") => "image",
        Some("ppt" | "pptx" | "pptd") => "slides",
        Some("rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "java" | "c" | "cpp") => "code",
        _ => "other",
    }
}

fn extract_plain_text(path: &Path, size: u64) -> Option<String> {
    if size > MAX_TEXT_BYTES {
        return None;
    }
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "md" | "txt"
            | "rst"
            | "html"
            | "css"
            | "json"
            | "yaml"
            | "yml"
            | "toml"
            | "csv"
            | "rs"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "py"
            | "go"
            | "java"
            | "c"
            | "cpp"
    ) {
        return None;
    }
    fs::read_to_string(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_ID: AtomicU64 = AtomicU64::new(0);
    fn tempdir() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "solidify-index-{}-{}",
            std::process::id(),
            TEST_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn indexes_and_finds_chinese_content() {
        let root = tempdir();
        fs::write(root.join("需求说明.md"), "客户需要建设统一的数据治理平台").unwrap();
        let root_text = root.to_string_lossy();
        let result = rebuild_index_impl(&root_text).unwrap();
        assert_eq!(result.files, 1);
        let matches = search_index_impl(&root_text, "数据治理", 10).unwrap();
        assert_eq!(matches[0].path, "需求说明.md");
        drop(matches);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finds_chinese_filenames_and_short_queries() {
        let root = tempdir();
        fs::write(root.join("客户需求.md"), "brief").unwrap();
        let root_text = root.to_string_lossy();
        rebuild_index_impl(&root_text).unwrap();
        assert_eq!(
            search_index_impl(&root_text, "客户需求", 10).unwrap()[0].path,
            "客户需求.md"
        );
        assert_eq!(
            search_index_impl(&root_text, "客", 10).unwrap()[0].path,
            "客户需求.md"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removes_literal_paths_without_glob_expansion() {
        let root = tempdir();
        fs::create_dir_all(root.join("group[1]")).unwrap();
        fs::create_dir_all(root.join("group1")).unwrap();
        fs::write(root.join("group[1]/note.txt"), "first marker").unwrap();
        fs::write(root.join("group1/note.txt"), "second marker").unwrap();
        let root_text = root.to_string_lossy();
        rebuild_index_impl(&root_text).unwrap();
        remove_index_path_impl(&root_text, "group[1]").unwrap();
        assert!(search_index_impl(&root_text, "first marker", 10)
            .unwrap()
            .is_empty());
        assert_eq!(
            search_index_impl(&root_text, "second marker", 10)
                .unwrap()
                .len(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recreates_a_deleted_derived_index() {
        let root = tempdir();
        fs::write(root.join("notes.txt"), "rebuild marker").unwrap();
        let root_text = root.to_string_lossy();
        rebuild_index_impl(&root_text).unwrap();
        fs::remove_file(root.join(".solidify/index.db")).unwrap();
        let result = rebuild_index_impl(&root_text).unwrap();
        assert_eq!(result.files, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removes_deleted_files_from_search() {
        let root = tempdir();
        fs::write(root.join("obsolete.txt"), "deprecated marker").unwrap();
        let root_text = root.to_string_lossy();
        rebuild_index_impl(&root_text).unwrap();
        fs::remove_file(root.join("obsolete.txt")).unwrap();
        remove_index_path_impl(&root_text, "obsolete.txt").unwrap();
        assert!(search_index_impl(&root_text, "deprecated", 10)
            .unwrap()
            .is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn indexes_ten_thousand_files_within_the_m3_budget() {
        let root = tempdir();
        for directory in 0..100 {
            let folder = root.join(format!("batch-{directory:03}"));
            fs::create_dir_all(&folder).unwrap();
            for file in 0..100 {
                fs::write(
                    folder.join(format!("file-{file:03}.txt")),
                    format!("performance marker {directory} {file}"),
                )
                .unwrap();
            }
        }
        let started = std::time::Instant::now();
        let result = rebuild_index_impl(root.to_string_lossy().as_ref()).unwrap();
        assert_eq!(result.files, 10_000);
        assert!(started.elapsed() < std::time::Duration::from_secs(60));
        fs::remove_dir_all(root).unwrap();
    }
}
