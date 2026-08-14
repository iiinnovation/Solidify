use super::workspace::WorkspaceAuthorization;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use tauri::State;

#[tauri::command(async)]
pub fn append_workspace_record(
    workspace_root: String,
    category: String,
    record_id: String,
    content: String,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<(), String> {
    authorization.require(&workspace_root)?;
    append_workspace_record_impl(&workspace_root, &category, &record_id, &content)
}

pub fn append_workspace_record_impl(
    workspace_root: &str,
    category: &str,
    record_id: &str,
    content: &str,
) -> Result<(), String> {
    validate_location(category, record_id)?;
    serde_json::from_str::<serde_json::Value>(content)
        .map_err(|error| format!("Workspace record must be valid JSON: {error}"))?;
    let directory = Path::new(workspace_root).join(".solidify").join(category);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join(format!("{record_id}.jsonl")))
        .map_err(|error| error.to_string())?;
    file.write_all(format!("{content}\n").as_bytes())
        .map_err(|error| error.to_string())?;
    file.sync_data().map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn read_workspace_records(
    workspace_root: String,
    category: String,
    record_id: String,
    authorization: State<'_, WorkspaceAuthorization>,
) -> Result<Vec<serde_json::Value>, String> {
    authorization.require(&workspace_root)?;
    read_workspace_records_impl(&workspace_root, &category, &record_id)
}

fn read_workspace_records_impl(
    workspace_root: &str,
    category: &str,
    record_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    validate_location(category, record_id)?;
    let path = Path::new(workspace_root)
        .join(".solidify")
        .join(category)
        .join(format!("{record_id}.jsonl"));
    if !path.exists() {
        return Ok(Vec::new());
    }
    // Skip unparseable lines instead of failing the whole read. A crash or a
    // second process interleaving mid-append can leave one torn line —
    // collecting into a Result would make every intact record in the file
    // unreadable, which surfaces to the user as a workspace that cannot open.
    Ok(fs::read_to_string(path)
        .map_err(|error| error.to_string())?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| match serde_json::from_str(line) {
            Ok(value) => Some(value),
            Err(error) => {
                eprintln!("Skipping malformed workspace record line: {error}");
                None
            }
        })
        .collect())
}

fn validate_location(category: &str, record_id: &str) -> Result<(), String> {
    if !matches!(category, "ledger" | "conversations") {
        return Err("Unsupported persistence category".into());
    }
    if record_id.is_empty()
        || !record_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.'))
    {
        return Err("Invalid persistence record ID".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_ID: AtomicU64 = AtomicU64::new(0);
    fn tempdir() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "solidify-persistence-{}-{}",
            std::process::id(),
            TEST_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn appends_valid_jsonl_and_rejects_escaping_ids() {
        let root = tempdir();
        let root_text = root.to_string_lossy();
        append_workspace_record_impl(&root_text, "ledger", "run-1", "{\"seq\":1}").unwrap();
        append_workspace_record_impl(&root_text, "ledger", "run-1", "{\"seq\":2}").unwrap();
        let saved = fs::read_to_string(root.join(".solidify/ledger/run-1.jsonl")).unwrap();
        assert_eq!(saved.lines().count(), 2);
        assert!(append_workspace_record_impl(&root_text, "ledger", "../outside", "{}").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    /// A single torn line must not make every intact record in the file
    /// unreadable — that surfaces as a workspace the user cannot open.
    #[test]
    fn skips_a_torn_line_and_keeps_the_intact_records() {
        let root = tempdir();
        let root_text = root.to_string_lossy();
        append_workspace_record_impl(&root_text, "conversations", "c1", "{\"seq\":1}").unwrap();
        // Simulate a crash mid-append.
        let path = root.join(".solidify/conversations/c1.jsonl");
        let mut torn = fs::read_to_string(&path).unwrap();
        torn.push_str("{\"seq\":2,\"partial\"\n");
        fs::write(&path, torn).unwrap();
        append_workspace_record_impl(&root_text, "conversations", "c1", "{\"seq\":3}").unwrap();

        let records = read_workspace_records_impl(&root_text, "conversations", "c1").unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["seq"], 1);
        assert_eq!(records[1]["seq"], 3);
        fs::remove_dir_all(root).unwrap();
    }
}
