import type { Tool, ToolResult } from '../types'
import type {
  FolderTaskDetail,
  FolderTaskItemUpdate,
  FolderTaskRecipePlan,
  NewFolderTaskDecision,
} from '@/lib/folder-tasks/types'
import { folderTaskClient } from '@/lib/folder-tasks/client'
import { getFolderTaskRecipe, validateFolderTaskPlanRecipe } from '@/lib/folder-tasks/recipes'
import { extractTextResult, inferFileMimeType } from '@/lib/file-extractor'
import type { JSONSchema } from '@/lib/types/json-schema'
import type { SandboxExtractMethod } from '@/lib/folder-tasks/sandbox'

interface FolderTaskBatchUpdateInput {
  batchToken: string
  updates: FolderTaskModelUpdate[]
  checkpointNote?: string
}

/**
 * The canonical contract is `itemId` + `result`. A few providers routinely
 * flatten the result and use the inventoried relative path as the identifier;
 * keep those spellings at the trusted boundary and normalize them before IPC.
 */
interface FolderTaskModelUpdate {
  itemId?: string
  relativePath?: string
  path?: string
  filePath?: string
  status: 'completed' | 'skipped' | 'failed' | string
  result?: Record<string, unknown>
  error?: string
  summary?: unknown
  facts?: unknown
  findings?: unknown
  recommendation?: unknown
  classification?: unknown
  category?: unknown
  reason?: unknown
  rationale?: unknown
  confidence?: unknown
}

const recipePlanSchema: JSONSchema = {
  type: 'object',
  required: ['kind', 'schemaVersion'],
  properties: {
    kind: {
      type: 'string',
      enum: ['structured-extraction', 'document-review', 'classification'],
      description: 'Must match recipe.',
    },
    schemaVersion: { type: 'integer', enum: [1] },
    fields: {
      type: 'array',
      maxItems: 128,
      items: {
        type: 'object',
        required: ['name', 'description', 'type', 'required', 'aliases'],
        properties: {
          name: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          type: { type: 'string', enum: ['string', 'number', 'boolean'] },
          required: { type: 'boolean' },
          aliases: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 },
        },
        additionalProperties: false,
      },
    },
    dedupeKeys: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 128 },
    rules: {
      type: 'array',
      minItems: 1,
      maxItems: 128,
      items: {
        type: 'object',
        required: ['id', 'title', 'description', 'severity', 'evidenceRequired'],
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          evidenceRequired: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    categories: {
      type: 'array',
      minItems: 2,
      maxItems: 128,
      items: {
        type: 'object',
        required: ['id', 'label', 'description'],
        properties: {
          id: { type: 'string', minLength: 1 },
          label: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
    },
    minimumConfidence: { type: 'number', minimum: 0, maximum: 1 },
    unknownCategory: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
}

const resultSchema: JSONSchema = {
  type: 'object',
  description: 'Use the exact result shape from recipeContract. Canonical fields are summary/facts, summary/findings/recommendation, or summary/category/confidence/rationale.',
  properties: {
    summary: { type: 'string', minLength: 1 },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'value'],
        properties: {
          label: { type: 'string', minLength: 1 },
          value: {},
          evidence: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ruleId', 'severity', 'title', 'description'],
        properties: {
          ruleId: { type: 'string', minLength: 1 },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          title: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          evidence: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    recommendation: { type: 'string', minLength: 1 },
    category: { type: 'string', minLength: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string', minLength: 1 },
    // Compatibility spellings accepted by the normalizer below.
    classification: { type: 'string', minLength: 1 },
    reason: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
}

export const FOLDER_TASK_TOOL_GROUPS = {
  context: 'folder-task-context',
  plan: 'folder-task-plan',
  claim: 'folder-task-claim',
  read: 'folder-task-read',
  checkpoint: 'folder-task-checkpoint',
  decision: 'folder-task-decision',
  results: 'folder-task-results',
  review: 'folder-task-review',
  output: 'folder-task-output',
} as const

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
  const recipe = getFolderTaskRecipe(task.recipe)
  return {
    id: task.id,
    revision: task.revision,
    name: task.name,
    goal: task.goal,
    status: task.status,
    recipe: task.recipe,
    recipeContract: recipe ? {
      id: recipe.id,
      description: recipe.description,
      resultShape: recipe.resultShape,
    } : undefined,
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
      'Keep the batchToken returned by claim_folder_task_batch and pass it to every read, decision, and checkpoint call.',
      'Checkpoint every claimed item with update_folder_task_batch before ending. A complete checkpoint is rejected unless it covers the whole batch.',
      'If one answer can resolve multiple similar ambiguities, call request_folder_task_decision once with every affected item ID.',
      'Never infer the contents of an unreadable file; mark it failed or request a decision.',
    ],
  }
}

async function normalizeFolderTaskUpdates(
  updates: readonly FolderTaskModelUpdate[],
  task: FolderTaskDetail,
  messages?: readonly unknown[],
): Promise<FolderTaskItemUpdate[]> {
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error('A batch checkpoint must contain at least one update')
  }

  const pathToItemId = collectClaimedItemPaths(messages)
  const unresolvedPath = updates.some((update) => {
    const candidate = firstText(update.itemId, update.relativePath, update.path, update.filePath)
    return Boolean(candidate && looksLikeRelativePath(candidate) && !pathToItemId.has(normalizeRelativePath(candidate)))
  })
  if (unresolvedPath) {
    // The Rust detail intentionally keeps the active batch compact and only
    // exposes opaque item IDs. Ask the scoped item endpoint for the active
    // processing rows when a provider used a relative path instead.
    try {
      const items = await folderTaskClient.listItems(task.id, 'processing', 0, 100)
      for (const item of items ?? []) {
        if (item?.id && item.relativePath) pathToItemId.set(normalizeRelativePath(item.relativePath), item.id)
      }
    } catch {
      // Preserve the original identifier so the backend can return its normal
      // ownership error when no mapping is available.
    }
  }

  return updates.map((raw, index) => {
    const candidate = firstText(raw.itemId, raw.relativePath, raw.path, raw.filePath)
    if (!candidate) throw new Error(`updates[${index}] requires itemId (or relativePath)`)
    const normalizedCandidate = normalizeRelativePath(candidate)
    const itemId = pathToItemId.get(normalizedCandidate) ?? candidate
    const status = normalizeFolderTaskItemStatus(raw.status, index)
    const result = normalizeFolderTaskResult(raw, task.recipe)
    const update: FolderTaskItemUpdate = { itemId, status }
    if (result !== undefined) update.result = result
    if (typeof raw.error === 'string' && raw.error.trim()) update.error = raw.error.trim()
    return update
  })
}

function normalizeFolderTaskItemStatus(value: unknown, index: number): FolderTaskItemUpdate['status'] {
  const normalized = String(value ?? '').trim().toLowerCase()
  switch (normalized) {
    case 'completed':
    case 'complete':
    case 'done':
    case 'success':
    case 'ok': return 'completed'
    case 'skipped':
    case 'skip':
    case 'ignored': return 'skipped'
    case 'failed':
    case 'failure':
    case 'error': return 'failed'
    case 'awaiting_external_parser': return 'awaiting_external_parser'
    default: throw new Error(`updates[${index}].status must be completed, skipped, failed, or awaiting_external_parser`)
  }
}

function normalizeFolderTaskResult(
  raw: FolderTaskModelUpdate,
  recipe: string,
): Record<string, unknown> | undefined {
  const source = isObject(raw.result) ? { ...raw.result } : {}
  const resultKeys = [
    'summary', 'facts', 'findings', 'recommendation',
    'category', 'confidence', 'rationale', 'classification', 'reason',
  ] as const
  for (const key of resultKeys) {
    if (source[key] === undefined && raw[key] !== undefined) source[key] = raw[key]
  }

  // Classification models often use the natural-language labels
  // `classification` and `reason`; the durable Recipe Contract deliberately
  // uses `category` and `rationale`. Normalize only unambiguous aliases and
  // leave missing confidence/summary fields for the contract validator to
  // report rather than inventing data.
  if (recipe === 'classification') {
    if (source.category === undefined && typeof source.classification === 'string') {
      source.category = source.classification
    }
    if (source.rationale === undefined && typeof source.reason === 'string') {
      source.rationale = source.reason
    }
  }
  delete source.classification
  delete source.reason

  if (typeof source.confidence === 'string' && source.confidence.trim()) {
    const numeric = Number(source.confidence)
    if (Number.isFinite(numeric)) source.confidence = numeric
  }
  return Object.keys(source).length > 0 ? source : undefined
}

function collectClaimedItemPaths(messages?: readonly unknown[]): Map<string, string> {
  const paths = new Map<string, string>()
  for (const message of messages ?? []) {
    if (!isObject(message) || !Array.isArray(message.content)) continue
    for (const item of message.content) {
      if (!isObject(item) || item.type !== 'tool_result') continue
      const payload = parseJsonObject(item.content)
      const values = Array.isArray(payload?.items) ? payload.items : []
      for (const value of values) {
        if (!isObject(value)) continue
        const id = firstText(value.id, value.itemId)
        const path = firstText(value.relativePath, value.path, value.filePath)
        if (id && path) paths.set(normalizeRelativePath(path), id)
      }
    }
  }
  return paths
}

function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim()
}

function normalizeRelativePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

function looksLikeRelativePath(value: string): boolean {
  const normalized = normalizeRelativePath(value)
  return normalized.includes('/') || /\.[^/]+$/.test(normalized)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (isObject(value)) return value
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
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
  loopGroup: FOLDER_TASK_TOOL_GROUPS.context,
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
  internalStateOnly: true,
  requiresConfirmation: false,
  loopGroup: FOLDER_TASK_TOOL_GROUPS.claim,
  replaySafe: false,
  availability: 'tauri-only',
  permissions: ['fs:read'],
  async execute(_input, ctx) {
    try {
      const claim = await folderTaskClient.claimBatch(requireTaskId(ctx.folderTaskId), ctx.runId)
      return ok(claim.items.length
        ? JSON.stringify({ ...claim, instruction: 'Pass batch.leaseToken as batchToken to every read, decision, and checkpoint. Read and checkpoint every item. Do not claim another batch in this run.' }, null, 2)
        : JSON.stringify({ ...claim, instruction: 'No pending files remain. The task has moved to review or completion.' }), claim)
    } catch (error) {
      return failure(error)
    }
  },
  renderCall: () => '按已确认计划领取下一批文件',
}

export const prepareFolderTaskPlanTool: Tool<{
  recipe: 'structured-extraction' | 'document-review' | 'classification'
  recipePlan: FolderTaskRecipePlan
}, unknown> = {
  name: 'prepare_folder_task_plan',
  description: 'Turn the user\'s natural-language goal into the semantic FolderTask recipe plan and start processing. Use while status is awaiting_plan_confirmation. Define specific extraction fields, review rules, or classification categories from the user request; execution limits remain system-managed. If validation rejects the contract, correct that error and retry within the bounded plan budget.',
  inputSchema: {
    type: 'object',
    required: ['recipe', 'recipePlan'],
    properties: {
      recipe: { type: 'string', enum: ['structured-extraction', 'document-review', 'classification'] },
      recipePlan: recipePlanSchema,
    },
    additionalProperties: false,
  },
  readOnly: false,
  concurrencySafe: false,
  destructive: false,
  internalStateOnly: true,
  requiresConfirmation: false,
  loopGroup: FOLDER_TASK_TOOL_GROUPS.plan,
  replaySafe: false,
  availability: 'tauri-only',
  permissions: ['fs:read'],
  async execute(input, ctx) {
    try {
      const taskId = requireTaskId(ctx.folderTaskId)
      const task = await folderTaskClient.get(taskId)
      if (task.status !== 'awaiting_plan_confirmation') {
        throw new Error(`FolderTask is ${task.status}, not awaiting plan preparation`)
      }
      const plan = {
        ...task.plan,
        recipe: input.recipe,
        recipePlan: input.recipePlan,
        output: { ...task.plan.output, autoWrite: true },
      }
      const issues = validateFolderTaskPlanRecipe(plan)
      if (issues.length > 0) throw new Error(issues[0])
      const preview = await folderTaskClient.previewPlan(taskId, plan, task.revision)
      if (preview.selectedFiles === 0) throw new Error('The semantic plan selects no readable files')
      const updated = await folderTaskClient.confirmPlan(taskId, preview.confirmationToken, task.revision)
      const data = compactTask(updated)
      return ok(JSON.stringify({
        selectedFiles: preview.selectedFiles,
        excludedFiles: preview.excludedFiles,
        task: data,
        instruction: 'The plan is bound and the task is running. Claim exactly one batch and begin processing it now.',
      }, null, 2), data)
    } catch (error) {
      return failure(error)
    }
  },
  renderCall: () => '根据你的要求准备文档处理方案',
}

export const readFolderTaskFileTool: Tool<{ batchToken: string; relativePath: string; offset?: number; limit?: number }, unknown> = {
  name: 'read_folder_task_file',
  description: 'Extract readable text from one inventoried file in the active folder task. Supports text, DOCX, XLSX, and text-based PDF. Use only paths returned by claim_folder_task_batch. limit is optional and values above 24000 are safely capped.',
  inputSchema: {
    type: 'object',
    required: ['batchToken', 'relativePath'],
    properties: {
      batchToken: { type: 'string', minLength: 1 },
      relativePath: { type: 'string', minLength: 1 },
      offset: { type: 'integer', minimum: 0 },
      // Providers occasionally ignore JSON Schema maxima. Accept an oversized
      // request and cap it in the trusted implementation so one bad argument
      // cannot strand an already claimed durable batch.
      limit: { type: 'integer', minimum: 500 },
    },
    additionalProperties: false,
  },
  readOnly: true,
  concurrencySafe: true,
  destructive: false,
  requiresConfirmation: false,
  loopGroup: FOLDER_TASK_TOOL_GROUPS.read,
  replaySafe: true,
  availability: 'tauri-only',
  permissions: ['fs:read'],
  async execute(input, ctx) {
    try {
      const resource = await folderTaskClient.readFileBytes(requireTaskId(ctx.folderTaskId), ctx.runId, input.batchToken, input.relativePath)
      const file = new File([new Uint8Array(resource.bytes)], resource.name, { type: inferFileMimeType(resource.name) })
      const task = await folderTaskClient.get(requireTaskId(ctx.folderTaskId))
      const limits = task.plan.resourceLimits
      const extracted = await extractTextResult(file, {
        maxCharacters: limits?.maxParsedCharactersPerFile ?? 200_000,
        maxPdfPages: limits?.maxPdfPages ?? 100,
        maxArchiveEntries: limits?.maxArchiveEntries ?? 2_000,
        maxExpandedBytes: limits?.maxExpandedBytes ?? 128 * 1024 * 1024,
      })
      if (extracted.externalMethods?.length) {
        const capabilities = await folderTaskClient.sandboxCapabilities()
        const methods = capabilities.filter((capability) => extracted.externalMethods?.includes(capability.method))
        const data = {
          status: 'needs_external_parser', relativePath: input.relativePath,
          reasonCode: extracted.reasonCode, methods,
          warnings: extracted.warnings, pageCount: extracted.pageCount, parsedPages: extracted.parsedPages,
          parser: extracted.parser, parserVersion: extracted.parserVersion, sourceHash: resource.contentHash,
          nextAction: methods.some((method) => method.available)
            ? '在同一批次租约下调用 extract_document_text；转换成功后再处理并提交检查点。'
            : '转换组件不可用；在交代整个批次的检查点中将此项标为 awaiting_external_parser，并填写 error。',
        }
        return ok(JSON.stringify(data, null, 2), data)
      }
      if (extracted.status === 'failed' || extracted.status === 'unsupported') {
        throw new Error(`${input.relativePath}: ${extracted.warnings.join('；')}`)
      }
      const offset = input.offset ?? 0
      const limit = Math.min(input.limit ?? 12000, 24000)
      const content = extracted.content.slice(offset, offset + limit)
      const nextOffset = offset + content.length < extracted.content.length ? offset + content.length : null
      const data = {
        relativePath: input.relativePath,
        offset,
        nextOffset,
        totalCharacters: extracted.totalCharacters,
        returnedCharacters: content.length,
        status: extracted.status,
        warnings: extracted.warnings,
        parser: extracted.parser,
        parserVersion: extracted.parserVersion,
        sourceHash: resource.contentHash,
        content,
      }
      return ok(JSON.stringify(data, null, 2), data)
    } catch (error) {
      return failure(error)
    }
  },
  renderCall: (input) => `读取任务文件 ${input.relativePath}`,
}

export const extractDocumentTextTool: Tool<{ batchToken: string; relativePath: string; method: SandboxExtractMethod }, unknown> = {
  name: 'extract_document_text',
  description: 'Convert an active-batch PNG/JPEG or scanned PDF using the fixed sandbox OCR pipeline after read_folder_task_file reports needs_external_parser. No shell or arbitrary commands. Each file/method may run once per run; do not retry failures. The backend preserves conversion provenance for checkpoint and output. Cite page numbers in result evidence and account for OCR warnings; complete means all pages were processed, not that the text is accurate.',
  inputSchema: {
    type: 'object', required: ['batchToken', 'relativePath', 'method'], additionalProperties: false,
    properties: {
      batchToken: { type: 'string', minLength: 1 },
      relativePath: { type: 'string', minLength: 1 },
      method: { type: 'string', enum: ['image_ocr', 'pdf_ocr'] },
    },
  },
  readOnly: true, concurrencySafe: false, destructive: false, requiresConfirmation: false,
  replaySafe: false, availability: 'tauri-only', permissions: ['fs:read', 'process:spawn'],
  timeoutMs: 150_000,
  retry: { maxAttempts: 1, backoffMs: 0 },
  loopGroup: 'folder-task-extract',
  async execute(input, ctx, signal) {
    if (ctx.platform !== 'tauri' || !ctx.folderTaskId
      || !ctx.sandboxCapabilities?.some((item) => item.method === input.method && item.available)) {
      return { success: false, content: '当前任务的转换组件不可用。',
        error: { kind: 'permission_denied', message: '当前任务的转换组件不可用。', recoverable: false } }
    }
    try {
      const data = await folderTaskClient.extractText({
        batchToken: input.batchToken, relativePath: input.relativePath, method: input.method,
        taskId: ctx.folderTaskId, runId: ctx.runId, callId: crypto.randomUUID(),
      }, signal)
      return ok(JSON.stringify(data), data)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        && typeof error.code === 'string' && /^[a-zA-Z_]{1,64}$/.test(error.code) ? error.code : 'conversion_failed'
      const message = signal.aborted ? '转换已取消。' : `文档转换失败 (${code})；不要在本次运行重试。请记录失败原因并提交整个批次的检查点。`
      return { success: false, content: message,
        data: { code },
        error: { kind: signal.aborted ? 'aborted' : 'runtime', message, recoverable: false } }
    }
  },
  renderCall: (input) => `转换任务文件 ${input.relativePath} (${input.method})`,
}

export const updateFolderTaskBatchTool: Tool<FolderTaskBatchUpdateInput, unknown> = {
  name: 'update_folder_task_batch',
  description: 'Persist outcomes for every claimed file as one atomic checkpoint. Each result should contain a concise summary and source evidence needed by the final review.',
  inputSchema: {
    type: 'object',
    required: ['batchToken', 'updates'],
    properties: {
      batchToken: { type: 'string', minLength: 1 },
      updates: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          type: 'object',
          required: ['status'],
          properties: {
            itemId: { type: 'string', minLength: 1 },
            relativePath: { type: 'string', minLength: 1 },
            path: { type: 'string', minLength: 1 },
            filePath: { type: 'string', minLength: 1 },
            status: { type: 'string', enum: ['completed', 'skipped', 'failed', 'awaiting_external_parser', 'complete', 'done', 'success', 'ok', 'skip', 'ignored', 'failure', 'error'] },
            result: resultSchema,
            error: { type: 'string' },
            summary: {},
            classification: { type: 'string', minLength: 1 },
            category: { type: 'string', minLength: 1 },
            reason: { type: 'string', minLength: 1 },
            rationale: { type: 'string', minLength: 1 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          additionalProperties: true,
        },
      },
      checkpointNote: { type: 'string', maxLength: 1000 },
    },
    additionalProperties: false,
  },
  readOnly: false,
  concurrencySafe: false,
  destructive: false,
  internalStateOnly: true,
  requiresConfirmation: false,
  loopGroup: FOLDER_TASK_TOOL_GROUPS.checkpoint,
  replaySafe: false,
  availability: 'tauri-only',
  permissions: ['fs:read'],
  async execute(input, ctx) {
    try {
      const taskId = requireTaskId(ctx.folderTaskId)
      const taskBefore = await folderTaskClient.get(taskId)
      const recipe = getFolderTaskRecipe(taskBefore.recipe)
      if (!recipe) throw new Error(`Unsupported FolderTask recipe: ${taskBefore.recipe}`)
      const updates = await normalizeFolderTaskUpdates(input.updates, taskBefore, ctx.messages)
      for (const update of updates) {
        if (update.status !== 'completed') continue
        const issues = recipe.validateResult(update.result, taskBefore.plan.recipePlan)
        if (issues.length) throw new Error(`${update.itemId}: ${issues.join('；')}. Expected ${recipe.resultShape}`)
      }
      const task = await folderTaskClient.updateBatch(
        taskId,
        ctx.runId,
        input.batchToken,
        updates,
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

export const requestFolderTaskDecisionTool: Tool<NewFolderTaskDecision & { batchToken: string }, unknown> = {
  name: 'request_folder_task_decision',
  description: 'Pause the folder task and ask one structured, high-impact question that can resolve a group of similar ambiguous files. Do not ask one question per file.',
  inputSchema: {
    type: 'object',
    required: ['batchToken', 'kind', 'title', 'description', 'options'],
    properties: {
      batchToken: { type: 'string', minLength: 1 },
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
  internalStateOnly: true,
  requiresConfirmation: false,
  loopGroup: FOLDER_TASK_TOOL_GROUPS.decision,
  replaySafe: false,
  availability: 'tauri-only',
  permissions: ['fs:read'],
  async execute(input, ctx) {
    try {
      const taskId = requireTaskId(ctx.folderTaskId)
      const { batchToken, ...request } = input
      const decision = await folderTaskClient.requestDecision(taskId, ctx.runId, batchToken, request)
      const task = await folderTaskClient.get(taskId)
      const paused = task.status === 'awaiting_decision'
      const data = {
        paused,
        decision,
        instruction: paused
          ? 'The durable task is paused. Ask the user one concise natural-language question. Their next reply can be applied with resolve_folder_task_decision.'
          : 'The decision is saved. Finish the current claimed batch and checkpoint it; the task will pause for the user at that checkpoint.',
      }
      return ok(JSON.stringify(data, null, 2), data)
    } catch (error) {
      return failure(error)
    }
  },
  renderCall: (input) => `请求用户决策：${input.title}`,
}

export const resolveFolderTaskDecisionTool: Tool<{
  decisionId: string
  optionId: string
  note?: string
  applyToSimilar?: boolean
}, unknown> = {
  name: 'resolve_folder_task_decision',
  description: 'Apply the user\'s latest natural-language answer to a pending FolderTask business decision. Use only when the user has clearly answered the question; never choose on their behalf.',
  inputSchema: {
    type: 'object',
    required: ['decisionId', 'optionId'],
    properties: {
      decisionId: { type: 'string', minLength: 1 },
      optionId: { type: 'string', minLength: 1 },
      note: { type: 'string', maxLength: 1000 },
      applyToSimilar: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  readOnly: false,
  concurrencySafe: false,
  destructive: false,
  internalStateOnly: true,
  requiresConfirmation: false,
  loopGroup: FOLDER_TASK_TOOL_GROUPS.decision,
  replaySafe: false,
  availability: 'tauri-only',
  permissions: ['fs:read'],
  async execute(input, ctx) {
    try {
      const taskId = requireTaskId(ctx.folderTaskId)
      const task = await folderTaskClient.get(taskId)
      const decision = task.decisions.find((candidate) =>
        candidate.id === input.decisionId && candidate.status === 'pending'
      )
      if (!decision) throw new Error('Pending FolderTask decision was not found')
      if (!decision.options.some((option) => option.id === input.optionId)) {
        throw new Error('Selected option does not belong to the pending decision')
      }
      const updated = await folderTaskClient.resolveDecision({
        taskId,
        decisionId: input.decisionId,
        optionId: input.optionId,
        note: input.note,
        applyToSimilar: input.applyToSimilar ?? Boolean(decision.applyKey),
        expectedRevision: task.revision,
      })
      const data = compactTask(updated)
      return ok(JSON.stringify({
        task: data,
        instruction: updated.status === 'running'
          ? 'The answer is saved. Continue with the task by claiming one batch if this run has not claimed a batch yet.'
          : 'The answer is saved. Re-read task context before taking another action.',
      }, null, 2), data)
    } catch (error) {
      return failure(error)
    }
  },
  renderCall: () => '根据你的回答继续任务',
}

export const completeFolderTaskTool: Tool<Record<string, never>, unknown> = {
  name: 'complete_folder_task',
  description: 'Mark a reviewing FolderTask complete only after the user explicitly confirms the AI results in their latest message. Never use this merely because processing finished.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: false,
  concurrencySafe: false,
  destructive: false,
  internalStateOnly: true,
  requiresConfirmation: false,
  loopGroup: FOLDER_TASK_TOOL_GROUPS.decision,
  replaySafe: false,
  availability: 'tauri-only',
  permissions: ['fs:read'],
  async execute(_input, ctx) {
    try {
      const latestUserMessage = [...(ctx.messages ?? [])].reverse().find((message) => {
        const candidate = message as { role?: unknown }
        return candidate?.role === 'user'
      }) as { content?: unknown } | undefined
      const confirmation = typeof latestUserMessage?.content === 'string' ? latestUserMessage.content.trim() : ''
      const automaticContinuation = confirmation.startsWith('请开始处理我选择的文档。任务目标：')
        || confirmation.startsWith('继续当前文档任务。读取持久化状态')
      const rejectsCompletion = /(?:(?:不要|别|暂不|不能|不应|不可以|先不|没有|尚未|还没)有?\s*(?:确认|完成|结束|通过)|\b(?:not\s+yet|do\s+not|don't|not\s+(?:confirmed|approved|complete|ready))\b)/i.test(confirmation)
      const explicitlyConfirms = /(?:结果.{0,8}(?:没问题|正确|可以|满意|通过)|确认(?:结果|完成|通过)|(?:完成|结束)(?:任务)?(?:吧|了)?|可以(?:完成|结束)|(?:没问题|可以了|就这样|通过了)[。！!\s]*$|\b(?:looks?\s+good|confirmed?|approve(?:d)?|complete\s+(?:the\s+)?task)\b)/i.test(confirmation)
      if (!confirmation || automaticContinuation || rejectsCompletion || !explicitlyConfirms) {
        throw new Error('The latest user message does not explicitly confirm completing this task')
      }
      const taskId = requireTaskId(ctx.folderTaskId)
      const task = await folderTaskClient.get(taskId)
      if (task.status !== 'reviewing') {
        throw new Error(`FolderTask is ${task.status}, not awaiting result confirmation`)
      }
      const updated = await folderTaskClient.setStatus(taskId, 'complete', task.revision)
      const data = compactTask(updated)
      return ok(JSON.stringify({ task: data, instruction: 'The task is complete. Summarize the result and output location for the user.' }, null, 2), data)
    } catch (error) {
      return failure(error)
    }
  },
  renderCall: () => '确认 AI 结果并完成任务',
}

export const listFolderTaskResultsTool: Tool<{
  status?: 'pending' | 'processing' | 'completed' | 'skipped' | 'failed' | 'pending_decision' | 'manual_review' | 'awaiting_external_parser'
  offset?: number
  limit?: number
}, unknown> = {
  name: 'list_folder_task_results',
  description: 'List persisted per-document FolderTask results so you can answer review questions or locate an item the user wants changed. Use during result review; do not ask the user to inspect raw task-management forms.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['pending', 'processing', 'completed', 'skipped', 'failed', 'pending_decision', 'manual_review', 'awaiting_external_parser'] },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    },
    additionalProperties: false,
  },
  readOnly: true,
  concurrencySafe: true,
  destructive: false,
  requiresConfirmation: false,
  loopGroup: FOLDER_TASK_TOOL_GROUPS.results,
  replaySafe: false,
  availability: 'tauri-only',
  permissions: ['fs:read'],
  async execute(input, ctx) {
    try {
      const taskId = requireTaskId(ctx.folderTaskId)
      const offset = input.offset ?? 0
      const limit = input.limit ?? 20
      const items = await folderTaskClient.listItems(taskId, input.status, offset, limit)
      const data = {
        offset,
        limit,
        hasMore: items.length === limit,
        items: items.map((item) => ({
          id: item.id,
          relativePath: item.relativePath,
          status: item.status,
          result: item.result,
          error: item.error,
          attempts: item.attempts,
        })),
      }
      return ok(JSON.stringify(data, null, 2), data)
    } catch (error) {
      return failure(error)
    }
  },
  renderCall: () => '读取 AI 文档处理结果',
}

export const reviseFolderTaskResultTool: Tool<{
  itemId: string
  action: 'accept' | 'retry' | 'skip'
  result?: Record<string, unknown>
  error?: string
}, unknown> = {
  name: 'revise_folder_task_result',
  description: 'Apply the user\'s requested correction to one persisted AI result, retry that document with the confirmed recipe, or skip a technical failure. Use only when the latest user message clearly requests the change.',
  inputSchema: {
    type: 'object',
    required: ['itemId', 'action'],
    properties: {
      itemId: { type: 'string', minLength: 1 },
      action: { type: 'string', enum: ['accept', 'retry', 'skip'] },
      result: { type: 'object' },
      error: { type: 'string', maxLength: 1000 },
    },
    additionalProperties: false,
  },
  readOnly: false,
  concurrencySafe: false,
  destructive: false,
  internalStateOnly: true,
  requiresConfirmation: false,
  loopGroup: FOLDER_TASK_TOOL_GROUPS.review,
  replaySafe: false,
  availability: 'tauri-only',
  permissions: ['fs:read', 'fs:write'],
  async execute(input, ctx) {
    try {
      const taskId = requireTaskId(ctx.folderTaskId)
      const task = await folderTaskClient.get(taskId)
      if (input.action === 'accept') {
        const recipe = getFolderTaskRecipe(task.recipe)
        if (!recipe) throw new Error(`Unsupported FolderTask recipe: ${task.recipe}`)
        const issues = recipe.validateResult(input.result, task.plan.recipePlan)
        if (issues.length > 0) throw new Error(`${issues.join('；')}. Expected ${recipe.resultShape}`)
      }
      const updated = await folderTaskClient.reviewItems(taskId, [{
        itemId: input.itemId,
        action: input.action,
        result: input.result,
        error: input.error,
      }], task.revision)
      const data = compactTask(updated)
      return ok(JSON.stringify({
        task: data,
        instruction: updated.status === 'running'
          ? 'The requested retry is queued. Claim one batch and process it now.'
          : 'The requested result change is saved. Summarize the change and current output state.',
      }, null, 2), data)
    } catch (error) {
      return failure(error)
    }
  },
  renderCall: (input) => input.action === 'retry' ? '让 AI 重新处理文档' : '按你的要求修改 AI 结果',
}

export const writeFolderTaskOutputTool: Tool<Record<string, never>, unknown> = {
  name: 'write_folder_task_output',
  description: 'Regenerate the deterministic task-owned output after result review, or retry a prior automatic output failure. This never overwrites an unrecognized user file.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: false,
  concurrencySafe: false,
  destructive: false,
  internalStateOnly: true,
  requiresConfirmation: false,
  loopGroup: FOLDER_TASK_TOOL_GROUPS.output,
  replaySafe: false,
  availability: 'tauri-only',
  permissions: ['fs:read', 'fs:write'],
  async execute(_input, ctx) {
    try {
      const taskId = requireTaskId(ctx.folderTaskId)
      const task = await folderTaskClient.get(taskId)
      const updated = await folderTaskClient.writeOutput(taskId, task.revision)
      const data = compactTask(updated)
      return ok(JSON.stringify({ task: data, instruction: 'The current deterministic output is written. Report its path to the user.' }, null, 2), data)
    } catch (error) {
      return failure(error)
    }
  },
  renderCall: () => '重新生成任务输出文件',
}

export const FOLDER_TASK_TOOL_NAMES = new Set([
  getFolderTaskContextTool.name,
  prepareFolderTaskPlanTool.name,
  claimFolderTaskBatchTool.name,
  readFolderTaskFileTool.name,
  extractDocumentTextTool.name,
  updateFolderTaskBatchTool.name,
  requestFolderTaskDecisionTool.name,
  resolveFolderTaskDecisionTool.name,
  listFolderTaskResultsTool.name,
  reviseFolderTaskResultTool.name,
  writeFolderTaskOutputTool.name,
  completeFolderTaskTool.name,
])

export const folderTaskTools = [
  getFolderTaskContextTool,
  prepareFolderTaskPlanTool,
  claimFolderTaskBatchTool,
  readFolderTaskFileTool,
  extractDocumentTextTool,
  updateFolderTaskBatchTool,
  requestFolderTaskDecisionTool,
  resolveFolderTaskDecisionTool,
  listFolderTaskResultsTool,
  reviseFolderTaskResultTool,
  writeFolderTaskOutputTool,
  completeFolderTaskTool,
]
