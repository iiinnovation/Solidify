export type FolderTaskStatus =
  | 'awaiting_plan_confirmation'
  | 'running'
  | 'paused'
  | 'awaiting_decision'
  | 'reviewing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface FolderTaskPlan {
  recipe: string
  batchSize: number
  outputMode: 'review_before_write' | 'export_only'
  baselineMode: 'incremental' | 'full_rescan'
  reviewPolicy: 'pause_on_ambiguity' | 'collect_until_checkpoint'
  includeExtensions: string[]
  exclusions: string[]
}

export interface FolderInventory {
  files: number
  directories: number
  totalBytes: number
  readableFiles: number
  attentionFiles: number
  topLevelGroups: number
  extensionCounts: Record<string, number>
  fingerprint: string
  warnings: string[]
}

export interface FolderTaskProgress {
  pending: number
  processing: number
  completed: number
  skipped: number
  failed: number
  pendingDecision: number
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
  status: 'pending' | 'processing' | 'completed' | 'skipped' | 'failed' | 'pending_decision'
  attempts: number
  result?: unknown
  error?: string
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
}

export interface FolderTaskItemUpdate {
  itemId: string
  status: 'completed' | 'skipped' | 'failed' | 'pending_decision'
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
}

export const FOLDER_TASK_STATUS_LABELS: Record<FolderTaskStatus, string> = {
  awaiting_plan_confirmation: '待确认计划',
  running: '执行中',
  paused: '已暂停',
  awaiting_decision: '等待决策',
  reviewing: '待审阅',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

export function folderTaskProcessedItems(task: FolderTaskSummary): number {
  return task.progress.completed + task.progress.skipped + task.progress.failed + task.progress.pendingDecision
}

export function folderTaskProgressPercent(task: FolderTaskSummary): number {
  if (task.inventory.files === 0) return 0
  return Math.min(100, Math.round(folderTaskProcessedItems(task) / task.inventory.files * 100))
}
