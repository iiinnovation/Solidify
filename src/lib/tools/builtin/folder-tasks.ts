import type { Tool, ToolResult } from '../types'
import type {
  FolderTaskDetail,
  FolderTaskItemUpdate,
  NewFolderTaskDecision,
} from '@/lib/folder-tasks/types'
import { folderTaskClient } from '@/lib/folder-tasks/client'
import { extractText, inferFileMimeType } from '@/lib/file-extractor'

const FOLDER_TASK_GROUP = 'folder-task-processing'

function requireTaskId(folderTaskId: string | undefined): string {
  if (!folderTaskId) throw new Error('This tool is only available inside a folder task conversation')
  return folderTaskId
}

function ok(content: string, data?: unknown): ToolResult {
  return { success: true, content, data, metadata: { durationMs: 0 } }
}

function failure(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    success: false,
    content: message,
    error: { kind: 'runtime', message, recoverable: true },
    metadata: { durationMs: 0 },
  }
}

function compactTask(task: FolderTaskDetail): unknown {
  return {
    id: task.id,
    name: task.name,
    goal: task.goal,
    status: task.status,
    recipe: task.recipe,
    plan: task.plan,
    inventory: task.inventory,
    progress: task.progress,
    pendingDecisions: task.decisions
      .filter((decision) => decision.status === 'pending')
      .map((decision) => ({
        id: decision.id,
        kind: decision.kind,
        title: decision.title,
        description: decision.description,
        options: decision.options,
        recommendedOptionId: decision.recommendedOptionId,
        affectedItemIds: decision.affectedItemIds,
      })),
    resolvedRules: task.decisions
      .filter((decision) => decision.status === 'resolved' && decision.resolution?.applyToSimilar)
      .map((decision) => ({
        kind: decision.kind,
        applyKey: decision.applyKey,
        optionId: decision.resolution?.optionId,
        note: decision.resolution?.note,
      })),
    instructions: [
      'Process at most one claimed batch in this model run.',
      'Read only files in the claimed batch.',
      'Checkpoint every claimed item with update_folder_task_batch before ending.',
      'If one answer can resolve multiple similar ambiguities, call request_folder_task_decision once with every affected item ID.',
      'Never infer the contents of an unreadable file; mark it failed or request a decision.',
    ],
  }
}

export const getFolderTaskContextTool: Tool<Record<string, never>, unknown> = {
  name: 'get_folder_task_context',
  description: 'Read the durable plan, progress, decisions, and saved rules for the folder task bound to this conversation. Call this before processing a batch.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  concurrencySafe: true,
  destructive: false,
  requiresConfirmation: false,
  loopGroup: FOLDER_TASK_GROUP,
  loopKey: 'context',
  replaySafe: false,
  availability: 'tauri-only',
  permissions: ['fs:read'],
  async execute(_input, ctx) {
    try {
      const task = await folderTaskClient.get(requireTaskId(ctx.folderTaskId))
      const data = compactTask(task)
      return ok(JSON.stringify(data, null, 2), data)
    } catch (error) {
      return failure(error)
    }
  },
  renderCall: () => '读取当前文件夹任务状态',
}

export const claimFolderTaskBatchTool: Tool<Record<string, never>, unknown> = {
  name: 'claim_folder_task_batch',
  description: 'Claim the next durable batch of pending files. Existing interrupted items are returned first. Claim only one batch per model run.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: false,
  concurrencySafe: false,
  destructive: false,
  requiresConfirmation: false,
  loopGroup: FOLDER_TASK_GROUP,
  loopKey: 'claim',
  replaySafe: false,
  availability: 'tauri-only',
  permissions: ['fs:read'],
  async execute(_input, ctx) {
    try {
      const items = await folderTaskClient.claimBatch(requireTaskId(ctx.folderTaskId))
      return ok(items.length
        ? JSON.stringify({ items, instruction: 'Read and checkpoint every item in this batch. Do not claim another batch in this run.' }, null, 2)
        : JSON.stringify({ items: [], instruction: 'No pending files remain. The task has moved to review.' }), items)
    } catch (error) {
      return failure(error)
    }
  },
  renderCall: () => '按已确认计划领取下一批文件',
}

export const readFolderTaskFileTool: Tool<{ relativePath: string; offset?: number; limit?: number }, unknown> = {
  name: 'read_folder_task_file',
  description: 'Extract readable text from one inventoried file in the active folder task. Supports text, DOCX, XLSX, and text-based PDF. Use only paths returned by claim_folder_task_batch.',
  inputSchema: {
    type: 'object',
    required: ['relativePath'],
    properties: {
      relativePath: { type: 'string', minLength: 1 },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 500, maximum: 24000 },
    },
    additionalProperties: false,
  },
  readOnly: true,
  concurrencySafe: true,
  destructive: false,
  requiresConfirmation: false,
  loopGroup: FOLDER_TASK_GROUP,
  loopKey: 'read',
  replaySafe: true,
  availability: 'tauri-only',
  permissions: ['fs:read'],
  async execute(input, ctx) {
    try {
      const resource = await folderTaskClient.readFileBytes(requireTaskId(ctx.folderTaskId), input.relativePath)
      const file = new File([new Uint8Array(resource.bytes)], resource.name, { type: inferFileMimeType(resource.name) })
      const extracted = await extractText(file)
      const offset = input.offset ?? 0
      const limit = input.limit ?? 12000
      const content = extracted.slice(offset, offset + limit)
      const nextOffset = offset + content.length < extracted.length ? offset + content.length : null
      const data = { relativePath: input.relativePath, offset, nextOffset, totalCharacters: extracted.length, content }
      return ok(JSON.stringify(data, null, 2), data)
    } catch (error) {
      return failure(error)
    }
  },
  renderCall: (input) => `读取任务文件 ${input.relativePath}`,
}

export const updateFolderTaskBatchTool: Tool<{ updates: FolderTaskItemUpdate[]; checkpointNote?: string }, unknown> = {
  name: 'update_folder_task_batch',
  description: 'Persist outcomes for every claimed file as one atomic checkpoint. Each result should contain a concise summary and source evidence needed by the final review.',
  inputSchema: {
    type: 'object',
    required: ['updates'],
    properties: {
      updates: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          type: 'object',
          required: ['itemId', 'status'],
          properties: {
            itemId: { type: 'string', minLength: 1 },
            status: { type: 'string', enum: ['completed', 'skipped', 'failed', 'pending_decision'] },
            result: { type: 'object' },
            error: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      checkpointNote: { type: 'string', maxLength: 1000 },
    },
    additionalProperties: false,
  },
  readOnly: false,
  concurrencySafe: false,
  destructive: false,
  requiresConfirmation: false,
  loopGroup: FOLDER_TASK_GROUP,
  loopKey: 'checkpoint',
  replaySafe: false,
  availability: 'tauri-only',
  permissions: ['fs:read'],
  async execute(input, ctx) {
    try {
      const task = await folderTaskClient.updateBatch(
        requireTaskId(ctx.folderTaskId),
        input.updates,
        input.checkpointNote,
      )
      const data = compactTask(task)
      return ok(JSON.stringify(data, null, 2), data)
    } catch (error) {
      return failure(error)
    }
  },
  renderCall: (input) => `保存批次检查点（${input.updates.length}项）`,
}

export const requestFolderTaskDecisionTool: Tool<NewFolderTaskDecision, unknown> = {
  name: 'request_folder_task_decision',
  description: 'Pause the folder task and ask one structured, high-impact question that can resolve a group of similar ambiguous files. Do not ask one question per file.',
  inputSchema: {
    type: 'object',
    required: ['kind', 'title', 'description', 'options'],
    properties: {
      kind: { type: 'string', minLength: 1, maxLength: 80 },
      title: { type: 'string', minLength: 1, maxLength: 160 },
      description: { type: 'string', minLength: 1, maxLength: 2000 },
      evidence: { type: 'object' },
      options: {
        type: 'array',
        minItems: 2,
        maxItems: 6,
        items: {
          type: 'object',
          required: ['id', 'label', 'description'],
          properties: {
            id: { type: 'string', minLength: 1 },
            label: { type: 'string', minLength: 1 },
            description: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      recommendedOptionId: { type: 'string' },
      affectedItemIds: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      applyKey: { type: 'string', maxLength: 120 },
    },
    additionalProperties: false,
  },
  readOnly: false,
  concurrencySafe: false,
  destructive: false,
  requiresConfirmation: false,
  loopGroup: FOLDER_TASK_GROUP,
  loopKey: 'decision',
  replaySafe: false,
  availability: 'tauri-only',
  permissions: ['fs:read'],
  async execute(input, ctx) {
    try {
      const decision = await folderTaskClient.requestDecision(requireTaskId(ctx.folderTaskId), input)
      return ok(JSON.stringify({
        paused: true,
        decision,
        instruction: 'The durable task is paused. Tell the user to answer in the Folder Tasks decision panel; do not continue processing in this run.',
      }, null, 2), decision)
    } catch (error) {
      return failure(error)
    }
  },
  renderCall: (input) => `请求用户决策：${input.title}`,
}

export const FOLDER_TASK_TOOL_NAMES = new Set([
  getFolderTaskContextTool.name,
  claimFolderTaskBatchTool.name,
  readFolderTaskFileTool.name,
  updateFolderTaskBatchTool.name,
  requestFolderTaskDecisionTool.name,
])

export const folderTaskTools = [
  getFolderTaskContextTool,
  claimFolderTaskBatchTool,
  readFolderTaskFileTool,
  updateFolderTaskBatchTool,
  requestFolderTaskDecisionTool,
]
