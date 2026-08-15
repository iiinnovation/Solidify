/**
 * Tauri 桌面端能力封装层
 *
 * 所有 Tauri API 调用都通过此模块间接调用，
 * Web 端运行时自动降级为 no-op / 浏览器 fallback。
 *
 * 业务组件不应直接 import @tauri-apps/api。
 */

/** 是否运行在 Tauri 桌面端 */
export const isTauri = '__TAURI_INTERNALS__' in window

async function invokeCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri) throw new Error('This operation requires the desktop app')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

export interface LocalDirEntry { path: string; name: string; kind: 'file' | 'directory'; size: number }
export interface LocalFileRead { content: string | null; binary: boolean; bytes: number; truncated: boolean }
export interface LocalSearchMatch { path: string; line: number | null; text: string | null }
export interface WorkspaceTreeEntry extends LocalDirEntry { modifiedAt: number }
export interface WorkspaceProject { schemaVersion: number; id: string; name: string; createdAt: string; stage: string }
export interface LocalWorkspaceInfo { root: string; project: WorkspaceProject }
export interface WorkspaceIndexStats { files: number; indexedDocuments: number }
export interface WorkspaceIndexMatch { path: string; text: string; score: number }
export interface WorkspaceFsChange { kind: 'created' | 'modified' | 'removed' | 'renamed' | 'rescan'; path: string; isDir: boolean }
export interface DocumentVersion { n: number; ts: string; runId: string; messageId: string; content: string }
export interface MaterializeDocumentResult { path: string; created: boolean; snapshotVersion: number | null; currentVersion: number; modifiedAt: number }

export function resolveWorkspacePath(path: string, workspaceRoot: string): Promise<string> {
  return invokeCommand('resolve_path', { path, workspaceRoot })
}

export function listWorkspaceDir(path: string, workspaceRoot: string, depth?: number): Promise<LocalDirEntry[]> {
  return invokeCommand('list_dir', { path, workspaceRoot, depth })
}

export function readWorkspaceFile(path: string, workspaceRoot: string, offset?: number, limit?: number): Promise<LocalFileRead> {
  return invokeCommand('read_file', { path, workspaceRoot, offset, limit })
}

export function readWorkspaceBytes(path: string, workspaceRoot: string): Promise<number[]> {
  return invokeCommand('read_file_bytes', { path, workspaceRoot })
}

export function readWorkspaceTree(workspaceRoot: string): Promise<WorkspaceTreeEntry[]> {
  return invokeCommand('read_tree', { workspaceRoot })
}

export function writeWorkspaceFile(path: string, content: string, workspaceRoot: string): Promise<number> {
  return invokeCommand('write_file', { path, content, workspaceRoot })
}

export function materializeWorkspaceDocument(options: {
  path: string
  content: string
  workspaceRoot: string
  runId: string
  messageId: string
  expectedModifiedAt?: number
  force?: boolean
}): Promise<MaterializeDocumentResult> {
  return invokeCommand('materialize_document', {
    path: options.path,
    content: options.content,
    workspaceRoot: options.workspaceRoot,
    runId: options.runId,
    messageId: options.messageId,
    expectedModifiedAt: options.expectedModifiedAt,
    force: options.force ?? false,
  })
}

export function listWorkspaceDocumentVersions(path: string, workspaceRoot: string): Promise<DocumentVersion[]> {
  return invokeCommand('list_document_versions', { path, workspaceRoot })
}

export function rollbackWorkspaceDocument(options: {
  path: string
  version: number
  workspaceRoot: string
  runId: string
  messageId: string
  expectedModifiedAt?: number
  force?: boolean
}): Promise<MaterializeDocumentResult> {
  return invokeCommand('rollback_document', { ...options, force: options.force ?? false })
}

export function searchWorkspaceFiles(query: string, path: string, workspaceRoot: string, maxResults?: number): Promise<LocalSearchMatch[]> {
  return invokeCommand('search_files', { query, path, workspaceRoot, maxResults })
}

export function selectWorkspace(): Promise<string | null> {
  return invokeCommand('select_workspace', {})
}

export function restoreWorkspace(workspaceRoot: string): Promise<LocalWorkspaceInfo> {
  return invokeCommand('restore_workspace', { workspaceRoot })
}

export function createWorkspace(name: string): Promise<LocalWorkspaceInfo | null> {
  return invokeCommand('create_workspace', { name })
}

export function closeWorkspace(): Promise<void> {
  return invokeCommand('close_workspace', {})
}

export function updateWorkspaceProjectStage(workspaceRoot: string, stage: string): Promise<WorkspaceProject> {
  return invokeCommand('update_project_stage', { workspaceRoot, stage })
}

export function initializeWorkspaceIndex(workspaceRoot: string): Promise<WorkspaceIndexStats> {
  return invokeCommand('initialize_index', { workspaceRoot })
}

export function rebuildWorkspaceIndex(workspaceRoot: string): Promise<WorkspaceIndexStats> {
  return invokeCommand('rebuild_index', { workspaceRoot })
}

export function upsertWorkspaceIndexDocument(workspaceRoot: string, path: string, content?: string): Promise<void> {
  return invokeCommand('upsert_index_document', { workspaceRoot, path, content })
}

export function removeWorkspaceIndexPath(workspaceRoot: string, path: string): Promise<void> {
  return invokeCommand('remove_index_path', { workspaceRoot, path })
}

export function searchWorkspaceIndex(workspaceRoot: string, query: string, maxResults?: number): Promise<WorkspaceIndexMatch[]> {
  return invokeCommand('search_index', { workspaceRoot, query, maxResults })
}

export function getWorkspaceIndexStats(workspaceRoot: string): Promise<WorkspaceIndexStats> {
  return invokeCommand('index_stats', { workspaceRoot })
}

export function startWorkspaceWatcher(workspaceRoot: string): Promise<void> {
  return invokeCommand('watch_dir', { workspaceRoot })
}

export function stopWorkspaceWatcher(): Promise<void> {
  return invokeCommand('unwatch_dir', {})
}

export async function listenWorkspaceChanges(listener: (event: WorkspaceFsChange) => void): Promise<() => void> {
  if (!isTauri) return () => undefined
  const { listen } = await import('@tauri-apps/api/event')
  return listen<WorkspaceFsChange>('workspace://fs-change', (event) => listener(event.payload))
}

export function appendWorkspaceSnapshot(
  conversationId: string,
  content: string,
  workspaceRoot: string,
): Promise<void> {
  return invokeCommand('append_snapshot', { conversationId, content, workspaceRoot })
}

export function readWorkspaceSnapshot(
  conversationId: string,
  workspaceRoot: string,
): Promise<string | null> {
  return invokeCommand('read_snapshot', { conversationId, workspaceRoot })
}

export function clearWorkspaceSnapshot(
  conversationId: string,
  workspaceRoot: string,
): Promise<void> {
  return invokeCommand('clear_snapshot', { conversationId, workspaceRoot })
}

export function appendWorkspaceRecord(
  workspaceRoot: string,
  category: 'ledger' | 'conversations',
  recordId: string,
  content: unknown,
): Promise<void> {
  return invokeCommand('append_workspace_record', {
    workspaceRoot,
    category,
    recordId,
    content: JSON.stringify(content),
  })
}

export function readWorkspaceRecords<T>(
  workspaceRoot: string,
  category: 'ledger' | 'conversations',
  recordId: string,
): Promise<T[]> {
  return invokeCommand('read_workspace_records', { workspaceRoot, category, recordId })
}

/** 当前操作系统平台 */
export type Platform = 'macos' | 'windows' | 'linux' | 'web'

let _platform: Platform | null = null

export async function getPlatform(): Promise<Platform> {
  if (_platform) return _platform
  if (!isTauri) {
    _platform = 'web'
    return _platform
  }
  try {
    const { platform } = await import('@tauri-apps/plugin-os')
    const p = platform()
    if (p === 'macos') _platform = 'macos'
    else if (p === 'windows') _platform = 'windows'
    else if (p === 'linux') _platform = 'linux'
    else _platform = 'web'
  } catch {
    _platform = 'web'
  }
  return _platform
}

// ─── 文件对话框 ──────────────────────────────────────────

export interface SaveFileOptions {
  defaultName?: string
  filters?: { name: string; extensions: string[] }[]
}

export interface OpenFileOptions {
  filters?: { name: string; extensions: string[] }[]
  multiple?: boolean
  directory?: boolean
}

/** 打开文件选择对话框，返回文件路径（Web 端降级为 file input） */
export async function openFileDialog(
  options?: OpenFileOptions,
): Promise<string | string[] | null> {
  if (!isTauri) return null
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const result = await open({
      multiple: options?.multiple ?? false,
      directory: options?.directory ?? false,
      filters: options?.filters,
    })
    return result
  } catch {
    return null
  }
}

/** 打开保存文件对话框，返回保存路径 */
export async function saveFileDialog(
  options?: SaveFileOptions,
): Promise<string | null> {
  if (!isTauri) return null
  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const result = await save({
      defaultPath: options?.defaultName,
      filters: options?.filters,
    })
    return result
  } catch {
    return null
  }
}

// ─── 文件系统 ──────────────────────────────────────────

/** 读取本地文件（文本） */
export async function readTextFile(path: string): Promise<string | null> {
  if (!isTauri) return null
  try {
    const { readTextFile: read } = await import('@tauri-apps/plugin-fs')
    return await read(path)
  } catch {
    return null
  }
}

/** 读取本地文件（二进制） */
export async function readBinaryFile(path: string): Promise<Uint8Array | null> {
  if (!isTauri) return null
  try {
    const { readFile } = await import('@tauri-apps/plugin-fs')
    return await readFile(path)
  } catch {
    return null
  }
}

/** 写入本地文件（文本） */
export async function writeTextFile(
  path: string,
  content: string,
): Promise<boolean> {
  if (!isTauri) return false
  try {
    const { writeTextFile: write } = await import('@tauri-apps/plugin-fs')
    await write(path, content)
    return true
  } catch {
    return false
  }
}

/** 写入本地文件（二进制） */
export async function writeBinaryFile(
  path: string,
  data: Uint8Array,
): Promise<boolean> {
  if (!isTauri) return false
  try {
    const { writeFile } = await import('@tauri-apps/plugin-fs')
    await writeFile(path, data)
    return true
  } catch {
    return false
  }
}

/** 统一保存文件入口：Tauri 用原生对话框 + writeBinaryFile，Web 用 file-saver */
export async function saveFile(
  blob: Blob,
  defaultName: string,
  filters?: { name: string; extensions: string[] }[],
): Promise<boolean> {
  if (isTauri) {
    const path = await saveFileDialog({ defaultName, filters })
    if (!path) return false
    const buffer = await blob.arrayBuffer()
    return writeBinaryFile(path, new Uint8Array(buffer))
  }
  // Web 端降级为 file-saver
  const { saveAs } = await import('file-saver')
  saveAs(blob, defaultName)
  return true
}

// ─── 系统通知 ──────────────────────────────────────────

/** 发送系统通知 */
export async function sendNotification(
  title: string,
  body?: string,
): Promise<void> {
  if (!isTauri) {
    // Web 端降级为浏览器通知
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body })
    }
    return
  }
  try {
    const { sendNotification: notify } = await import(
      '@tauri-apps/plugin-notification'
    )
    notify({ title, body })
  } catch {
    // 静默失败
  }
}

/** 请求通知权限 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!isTauri) {
    if ('Notification' in window) {
      const result = await Notification.requestPermission()
      return result === 'granted'
    }
    return false
  }
  try {
    const {
      isPermissionGranted,
      requestPermission,
    } = await import('@tauri-apps/plugin-notification')
    let granted = await isPermissionGranted()
    if (!granted) {
      const permission = await requestPermission()
      granted = permission === 'granted'
    }
    return granted
  } catch {
    return false
  }
}

// ─── 自动更新 ──────────────────────────────────────────

export interface UpdateResult {
  available: boolean
  version?: string
  notes?: string
}

/** 检查更新（静默，不阻塞 UI） */
export async function checkForUpdates(): Promise<UpdateResult> {
  if (!isTauri) return { available: false }
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (update) {
      return {
        available: true,
        version: update.version,
        notes: update.body ?? undefined,
      }
    }
    return { available: false }
  } catch {
    return { available: false }
  }
}

/** 下载并安装更新 */
export async function downloadAndInstallUpdate(): Promise<boolean> {
  if (!isTauri) return false
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (update) {
      await update.downloadAndInstall()
      // 安装后需要重启应用
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
      return true
    }
    return false
  } catch {
    return false
  }
}
