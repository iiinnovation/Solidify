export type FolderTaskStatus =
  | 'awaiting_plan_confirmation'
  | 'running'
  | 'paused'
  | 'awaiting_decision'
  | 'reviewing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface FolderTaskResourceLimits {
  maxBatchBytes: number
  maxBatchEstimatedCharacters: number
  maxParsedCharactersPerFile: number
  maxPdfPages: number
  maxArchiveEntries: number
  maxExpandedBytes: number
}

export interface FolderTaskOutputPlan {
  format: 'json' | 'xlsx'
  relativePath: string
  overwrite: boolean
  autoWrite: boolean
}

export interface StructuredExtractionRecipePlan {
  kind: 'structured-extraction'
  schemaVersion: 1
  fields: Array<{
    name: string
    description: string
    type: 'string' | 'number' | 'boolean'
    required: boolean
    aliases: string[]
  }>
  dedupeKeys: string[]
}

export interface DocumentReviewRecipePlan {
  kind: 'document-review'
  schemaVersion: 1
  rules: Array<{
    id: string
    title: string
    description: string
    severity: 'low' | 'medium' | 'high'
    evidenceRequired: boolean
  }>
}

export interface ClassificationRecipePlan {
  kind: 'classification'
  schemaVersion: 1
  categories: Array<{ id: string; label: string; description: string }>
  minimumConfidence: number
  unknownCategory: string
}

export type FolderTaskRecipePlan =
  | StructuredExtractionRecipePlan
  | DocumentReviewRecipePlan
  | ClassificationRecipePlan

export interface FolderTaskPlan {
  schemaVersion: 3
  recipe: string
  recipePlan: FolderTaskRecipePlan
  batchSize: number
  completionPolicy: 'review_required' | 'complete_after_processing'
  snapshotMode: 'use_scanned_snapshot' | 'refresh_before_run'
  reviewPolicy: 'pause_on_ambiguity' | 'collect_until_checkpoint'
  includeExtensions: string[]
  exclusions: string[]
  resourceLimits: FolderTaskResourceLimits
  output: FolderTaskOutputPlan
}

export interface FolderInventory {
  files: number
  directories: number
  totalBytes: number
  readableFiles: number
  /** OCR format candidates, independent of component availability. Absent on legacy tasks. */
  externalFiles?: number
  attentionFiles: number
  topLevelGroups: number
  extensionCounts: Record<string, number>
  fingerprint: string
  truncated: boolean
  truncationReasons: string[]
  warnings: string[]
}

export interface FolderTaskPlanPreview {
  confirmationToken: string
  inventoryFingerprint: string
  selectedFiles: number
  selectedBytes: number
  excludedFiles: number
  excludedByExtension: number
  excludedByPattern: number
  warnings: string[]
  plan: FolderTaskPlan
}

export interface FolderTaskProgress {
  pending: number
  processing: number
  completed: number
  skipped: number
  failed: number
  pendingDecision: number
  manualReview: number
  awaitingExternalParser: number
}

export interface FolderTaskSummary {
  id: string
  name: string
  goal: string
  rootPath: string
  status: FolderTaskStatus
  recipe: string
  inventory: FolderInventory
  progress: FolderTaskProgress
  pendingDecisions: number
  createdAt: number
  updatedAt: number
  revision: number
}

export interface FolderTaskItem {
  id: string
  relativePath: string
  size: number
  modifiedAt: number
  extension: string
  contentHash: string
  estimatedCharacters: number
  status: 'pending' | 'processing' | 'completed' | 'skipped' | 'failed' | 'pending_decision' | 'manual_review' | 'awaiting_external_parser'
  attempts: number
  result?: unknown
  error?: string
  provenance: {
    relativePath: string
    sourceHash: string
    size: number
    modifiedAt: number
    parser: string
    parserVersion: string
    extraction?: {
      executionId: string
      runId: string
      batchId: string
      method: 'image_ocr' | 'pdf_ocr'
      parserVersion: string
      languageVersions: string[]
      pages: number[]
      complete: boolean
      warnings: string[]
      durationMs: number
    }
  }
}

export interface DecisionOption {
  id: string
  label: string
  description: string
}

export interface FolderTaskDecision {
  id: string
  kind: string
  title: string
  description: string
  evidence: unknown
  options: DecisionOption[]
  recommendedOptionId?: string
  affectedItemIds: string[]
  applyKey?: string
  status: 'pending' | 'resolved'
  resolution?: {
    optionId: string
    note?: string
    applyToSimilar: boolean
    applyKey?: string
  }
  createdAt: number
  resolvedAt?: number
}

export interface FolderTaskEvent {
  seq: number
  eventType: string
  data: unknown
  createdAt: number
}

export interface FolderTaskDetail extends FolderTaskSummary {
  plan: FolderTaskPlan
  decisions: FolderTaskDecision[]
  recentEvents: FolderTaskEvent[]
  activeBatch?: FolderTaskBatch
  recentRuns: FolderTaskRun[]
  confirmedPlanHash?: string
  latestOutput?: FolderTaskOutput
}

export interface FolderTaskOutput {
  format: 'json' | 'xlsx'
  relativePath: string
  contentHash: string
  itemCount: number
  createdAt: number
  resultRevision: number
  isCurrent: boolean
}

export interface FolderTaskBatch {
  id: string
  taskId: string
  runId: string
  leaseToken: string
  status: 'active' | 'completed' | 'interrupted' | 'failed' | 'expired'
  itemIds: string[]
  leaseExpiresAt: number
  createdAt: number
  completedAt?: number
}

export interface FolderTaskRun {
  runId: string
  taskId: string
  status: 'active' | 'completed' | 'interrupted' | 'failed' | 'expired' | 'aborted'
  error?: string
  startedAt: number
  updatedAt: number
  completedAt?: number
}

export interface FolderTaskBatchClaim {
  batch?: FolderTaskBatch
  items: FolderTaskItem[]
}

export interface FolderTaskItemUpdate {
  itemId: string
  status: 'completed' | 'skipped' | 'failed' | 'awaiting_external_parser'
  result?: unknown
  error?: string
}

export interface FolderTaskReviewUpdate {
  itemId: string
  action: 'accept' | 'retry' | 'skip'
  result?: unknown
  error?: string
}

export interface NewFolderTaskDecision {
  kind: string
  title: string
  description: string
  evidence?: unknown
  options: DecisionOption[]
  recommendedOptionId?: string
  affectedItemIds?: string[]
  applyKey?: string
}

export interface FolderTaskFileBytes {
  name: string
  bytes: number[]
  size: number
  contentHash: string
}

export const FOLDER_TASK_STATUS_LABELS: Record<FolderTaskStatus, string> = {
  awaiting_plan_confirmation: 'AI 正在准备方案',
  running: 'AI 处理中',
  paused: '已暂停',
  awaiting_decision: '等待你的回答',
  reviewing: 'AI 结果待确认',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

export function folderTaskProcessedItems(task: FolderTaskSummary): number {
  return task.progress.completed
    + task.progress.skipped
}

export function folderTaskProgressPercent(task: FolderTaskSummary): number {
  if (task.inventory.files === 0) return 0
  return Math.min(100, Math.round(folderTaskProcessedItems(task) / task.inventory.files * 100))
}
