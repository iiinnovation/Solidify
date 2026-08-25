# FolderTask runtime

FolderTask is the desktop-only workflow for processing a large local folder over multiple bounded Agent runs. It is deliberately separate from Conversation: chat is an interaction surface, while SQLite is the durable task source of truth.

## Lifecycle

```text
awaiting_plan_confirmation
  -> running
  -> awaiting_decision -> running
  -> reviewing
  -> completed

running <-> paused
any active state -> cancelled
```

Creating a task inventories the selected folder but does not expose it to the model. The user must resolve scan-time decisions and confirm the plan before a batch can be claimed. A batch checkpoint is atomic; after the final checkpoint the backend moves the task to `reviewing`.

## Capability boundary

- Ordinary conversations receive no FolderTask tools.
- A conversation stores only a trusted `folderTaskId`; it is independent of the currently selected Workspace.
- In a FolderTask run the model-visible API is physically reduced to the five tools in `src/lib/tools/builtin/folder-tasks.ts`.
- Filesystem paths are never accepted as general capabilities. A file must belong to the task inventory **and** have status `processing` in the currently claimed batch before Rust will return its bytes.
- One run may claim one batch. Context, claim, read, checkpoint and decision are independent capability leases, so exhausting a one-shot stage cannot revoke the tools required by the next stage.
- Temporary chat attachments, Skill instructions, knowledge retrieval, general filesystem tools, PPTD tools and sub-agents do not enter the FolderTask capability lease.

## Persistence and recovery

`folder-tasks.sqlite3` lives in the application data directory and stores:

- task plan, inventory fingerprint, progress and optimistic revision;
- per-file status, attempt count, result and error;
- structured decisions and reusable `applyKey` resolutions;
- an append-only task event trail.

Interrupted `processing` items are returned before a new batch is claimed. Pausing and resuming resets unfinished claimed items to `pending`. UI mutations use the task revision so stale decision/status writes fail rather than overwrite newer state.

## File handling

The built-in reader supports text, DOCX, XLSX and text-based PDF. XLSX extraction reads the OpenXML package locally, including workbook relationships, sheet names, shared strings and inline values. Unsupported formats are resolved as a group during planning and are never guessed by the model.

Folder scans run off the async UI executor. `full_rescan` rebuilds the inventory immediately before execution; if new unsupported formats appear, confirmation returns to the decision step.

## UI

`/folder-tasks` is a focused task center with inventory, plan confirmation, grouped decisions, progress, results, event history, pause/resume/review controls and complete JSON export. “Use Agent to process next batch” opens or reuses the task-bound conversation.
