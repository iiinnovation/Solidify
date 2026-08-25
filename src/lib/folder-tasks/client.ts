import type {
  FolderTaskFileBytes,
  FolderTaskItem,
  FolderTaskItemUpdate,
  FolderTaskPlan,
  NewFolderTaskDecision,
} from './types'
import * as tauri from '@/lib/tauri'

/**
 * Access bridge members only when an operation actually runs. This prevents
 * unrelated runtime tests from needing to mock every FolderTask IPC while
 * retaining a single typed desktop boundary.
 */
export const folderTaskClient = {
  create: async (input: { name: string; goal: string; recipe: string }) =>
    tauri.createFolderTask(input),
  list: async () => tauri.listFolderTasks(),
  listItems: async (taskId: string, status?: FolderTaskItem['status'], offset = 0, limit = 100) =>
    tauri.listFolderTaskItems(taskId, status, offset, limit),
  get: async (taskId: string) => tauri.getFolderTask(taskId),
  confirmPlan: async (taskId: string, plan: FolderTaskPlan, expectedRevision: number) =>
    tauri.confirmFolderTaskPlan(taskId, plan, expectedRevision),
  claimBatch: async (taskId: string, limit?: number) =>
    tauri.claimFolderTaskBatch(taskId, limit),
  updateBatch: async (taskId: string, updates: FolderTaskItemUpdate[], checkpointNote?: string) =>
    tauri.updateFolderTaskBatch(taskId, updates, checkpointNote),
  requestDecision: async (taskId: string, request: NewFolderTaskDecision) =>
    tauri.requestFolderTaskDecision(taskId, request),
  resolveDecision: async (input: {
    taskId: string
    decisionId: string
    optionId: string
    note?: string
    applyToSimilar: boolean
    expectedRevision: number
  }) => tauri.resolveFolderTaskDecision(input),
  setStatus: async (taskId: string, action: 'pause' | 'resume' | 'complete' | 'cancel', expectedRevision: number) =>
    tauri.setFolderTaskStatus(taskId, action, expectedRevision),
  readFileBytes: async (taskId: string, relativePath: string): Promise<FolderTaskFileBytes> =>
    tauri.readFolderTaskFileBytes(taskId, relativePath),
}
