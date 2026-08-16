import type { QueryContext, QueryEvent, UsageStats } from '../types'

export const MAX_SUB_AGENT_CONCURRENCY = 5
export const MAX_SUB_AGENTS_PER_DISPATCH = 5
export const MAX_SUB_AGENT_DEPTH = 1

export type SubAgentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'aborted' | 'exhausted'

export interface SubAgentSpec {
  /** Stable within one dispatch. Generated when omitted. */
  id?: string
  role: string
  task: string
  /** Optional role instruction; treated as trusted orchestrator context. */
  systemPrompt?: string
  /** Tool names must be a subset of the parent's available tools. */
  allowedTools?: string[]
  /** Optional model override within the parent's provider. */
  model?: string
  /** Per-child ceiling; the task-tree budget remains authoritative. */
  maxTokens?: number
  maxTurns?: number
}

export interface SubAgentResult {
  agentId: string
  runId: string
  parentRunId: string
  role: string
  task: string
  status: Exclude<SubAgentStatus, 'queued' | 'running'>
  content: string
  usage: UsageStats
  durationMs: number
  error?: string
}

export interface SubAgentProgress {
  agentId: string
  runId: string
  parentRunId: string
  role: string
  task: string
  status: SubAgentStatus
  content?: string
  usage?: UsageStats
  error?: string
}

export interface TaskTreeBudgetSnapshot {
  limit: number
  used: number
  remaining: number
  exhausted: boolean
  byRun: Readonly<Record<string, number>>
}

export interface TaskTreeBudget {
  readonly signal: AbortSignal
  consume(runId: string, tokens: number): boolean
  snapshot(): TaskTreeBudgetSnapshot
  abort(reason?: string): void
  readonly abortReason?: string
}

export type QueryRunner = (ctx: QueryContext) => AsyncGenerator<QueryEvent>

export interface DispatchSubAgentsOptions {
  concurrency?: number
  runner?: QueryRunner
  onProgress?: (progress: SubAgentProgress) => void
  signal?: AbortSignal
}
