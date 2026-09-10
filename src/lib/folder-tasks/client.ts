import type {
  FolderTaskFileBytes,
  FolderTaskItem,
  FolderTaskItemUpdate,
  FolderTaskPlan,
  FolderTaskReviewUpdate,
  NewFolderTaskDecision,
} from './types'
import * as tauri from '@/lib/tauri'
import type { SandboxExtractionRequest } from './sandbox'

/**
 * Access bridge members only when an operation actually runs. This prevents
 * unrelated runtime tests from needing to mock every FolderTask IPC while
 * retaining a single typed desktop boundary.
 */
export const folderTaskClient = {
  executionProgress: async (taskId: string) => tauri.sandboxExecutionProgress(taskId),
  sandboxCapabilities: async () => tauri.sandboxCapabilities(),
  cancelExtraction: async (input: SandboxExtractionRequest) => tauri.sandboxCancelExecution(input),
  extractText: async (input: SandboxExtractionRequest, signal?: AbortSignal) => {
    if (signal?.aborted) throw new DOMException('转换已取消', 'AbortError')
    let cancelFailure: unknown
    let cancellation: Promise<void> | undefined
    const cancel = () => {
      cancellation ??= tauri.sandboxCancelExecution(input).catch((error: unknown) => { cancelFailure = error })
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      // Do not race this promise against AbortSignal: keep waiting until Rust
      // confirms worker completion, so callers cannot release a live batch.
      const result = await tauri.sandboxExtractText(input)
      if (signal?.aborted) {
        await cancellation
        if (cancelFailure) throw new Error('取消请求未获确认，转换结果已丢弃；请刷新任务状态')
        throw new DOMException('转换已取消', 'AbortError')
      }
      return result
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  },
  create: async (input: { name: string; goal: string; recipe: string; sourceMode?: 'documents' | 'folder' }) =>
    tauri.createFolderTask(input),
  list: async () => tauri.listFolderTasks(),
  listItems: async (taskId: string, status?: FolderTaskItem['status'], offset = 0, limit = 100) =>
    tauri.listFolderTaskItems(taskId, status, offset, limit),
  get: async (taskId: string) => tauri.getFolderTask(taskId),
  previewPlan: async (taskId: string, plan: FolderTaskPlan, expectedRevision: number) =>
    tauri.previewFolderTaskPlan(taskId, plan, expectedRevision),
  confirmPlan: async (taskId: string, confirmationToken: string, expectedRevision: number) =>
    tauri.confirmFolderTaskPlan(taskId, confirmationToken, expectedRevision),
  claimBatch: async (taskId: string, runId: string, limit?: number) =>
    tauri.claimFolderTaskBatch(taskId, runId, limit),
  updateBatch: async (taskId: string, runId: string, batchToken: string, updates: FolderTaskItemUpdate[], checkpointNote?: string, checkpointMode: 'complete' | 'interrupted' = 'complete') =>
    tauri.updateFolderTaskBatch(taskId, runId, batchToken, updates, checkpointNote, checkpointMode),
  requestDecision: async (taskId: string, runId: string, batchToken: string, request: NewFolderTaskDecision) =>
    tauri.requestFolderTaskDecision(taskId, runId, batchToken, request),
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
  readFileBytes: async (taskId: string, runId: string, batchToken: string, relativePath: string): Promise<FolderTaskFileBytes> =>
    tauri.readFolderTaskFileBytes(taskId, runId, batchToken, relativePath),
  finishRun: async (taskId: string, runId: string, outcome: 'completed' | 'failed' | 'aborted', error?: string) =>
    tauri.finishFolderTaskRun(taskId, runId, outcome, error),
  reviewItems: async (taskId: string, updates: FolderTaskReviewUpdate[], expectedRevision: number) =>
    tauri.reviewFolderTaskItems(taskId, updates, expectedRevision),
  writeOutput: async (taskId: string, expectedRevision: number) =>
    tauri.writeFolderTaskOutput(taskId, expectedRevision),
  delete: async (taskId: string, expectedRevision: number) =>
    tauri.deleteFolderTask(taskId, expectedRevision),
}
