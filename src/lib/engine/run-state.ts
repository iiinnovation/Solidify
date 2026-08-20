import type { QueryEvent, UsageStats } from './types'
import type { ToolCall, ToolResult } from '../tools/types'
import type { SubAgentStatus, TaskTreeBudgetSnapshot } from './sub-agent/types'

export interface RunToolItem {
  call: ToolCall
  result?: ToolResult
  progress?: string
  progressDetail?: unknown
  status: 'requested' | 'running' | 'completed'
  startedAt: number
  completedAt?: number
}

export interface ExecutionMetrics {
  durationMs: number
  ttftMs?: number
  tokensPerSecond?: number
  outputTokens?: number
  totalTokens?: number
}

export interface RunState {
  runId: string
  status: 'idle' | 'running' | 'completed' | 'aborted' | 'failed' | 'exhausted'
  text: string
  tools: RunToolItem[]
  usage?: UsageStats
  metrics?: ExecutionMetrics
  firstTokenAt?: number
  error?: string
  startedAt: number
  completedAt?: number
  subAgents?: RunSubAgentItem[]
  taskBudget?: TaskTreeBudgetSnapshot
}

export interface RunSubAgentItem {
  agentId: string
  runId: string
  parentRunId: string
  role: string
  task: string
  status: Exclude<SubAgentStatus, 'queued'>
  content?: string
  usage?: UsageStats
  error?: string
}

export function createRunState(runId: string): RunState {
  return { runId, status: 'running', text: '', tools: [], startedAt: Date.now(), subAgents: [] }
}

function computeMetrics(state: RunState, usage?: UsageStats): ExecutionMetrics {
  const completedAt = Date.now()
  const durationMs = Math.max(0, completedAt - state.startedAt)
  const ttftMs = state.firstTokenAt ? Math.max(0, state.firstTokenAt - state.startedAt) : undefined
  const outputTokens = usage?.outputTokens ?? (state.text ? Math.ceil(state.text.length * 0.75) : 0)
  const totalGenMs = Math.max(
    0,
    (state.firstTokenAt ? (completedAt - state.firstTokenAt) : durationMs) - toolExecutionMs(state),
  )
  const genDurationSec = totalGenMs / 1000
  const tokensPerSecond = genDurationSec > 0 && outputTokens > 0
    ? Number((outputTokens / genDurationSec).toFixed(1))
    : undefined
  return {
    durationMs,
    ttftMs,
    tokensPerSecond,
    outputTokens,
    totalTokens: usage?.totalTokens,
  }
}

/**
 * Wall-clock time the run spent inside tools, excluded from the token-rate
 * window so a slow tool does not read as a slow model.
 *
 * Read-only tools run concurrently (query.ts §M1-15), so summing per-tool
 * durations would charge one wall-clock second several times over and could
 * subtract more than the run actually lasted — which clamped the window to
 * zero and made the rate disappear. Overlapping spans are merged instead.
 */
function toolExecutionMs(state: RunState): number {
  const spans = state.tools
    .filter((tool): tool is typeof tool & { startedAt: number; completedAt: number } =>
      typeof tool.startedAt === 'number' && typeof tool.completedAt === 'number' && tool.completedAt > tool.startedAt)
    .map((tool) => ({ start: tool.startedAt, end: tool.completedAt }))
    .sort((a, b) => a.start - b.start)

  let total = 0
  let mergedStart: number | undefined
  let mergedEnd = 0
  for (const span of spans) {
    if (mergedStart === undefined) {
      mergedStart = span.start
      mergedEnd = span.end
      continue
    }
    if (span.start <= mergedEnd) {
      mergedEnd = Math.max(mergedEnd, span.end)
      continue
    }
    total += mergedEnd - mergedStart
    mergedStart = span.start
    mergedEnd = span.end
  }
  return mergedStart === undefined ? 0 : total + (mergedEnd - mergedStart)
}

export function applyRunEvent(state: RunState, event: QueryEvent): RunState {
  switch (event.type) {
    case 'message.delta':
      return {
        ...state,
        text: state.text + event.text,
        ...(event.text && !state.firstTokenAt ? { firstTokenAt: Date.now() } : {}),
      }
    case 'message.completed':
      return {
        ...state,
        ...(state.text ? {} : { text: event.content }),
        ...(event.content && !state.firstTokenAt ? { firstTokenAt: Date.now() } : {}),
      }
    case 'tool.requested':
      return {
        ...state,
        ...(!state.firstTokenAt ? { firstTokenAt: Date.now() } : {}),
        tools: [...state.tools, { call: event.call, status: 'requested', startedAt: Date.now() }],
      }
    case 'tool.progress':
      {
        const detail = asSubAgentDetail(event.progress.detail)
        const withAgent = detail ? updateSubAgent(state, detail.agent, detail.budget) : state
        return {
          ...withAgent,
          tools: withAgent.tools.map((item) => item.call.id === event.callId
            ? {
                ...item,
                status: 'running',
                progress: event.progress.message ?? event.progress.phase,
                progressDetail: event.progress.detail,
              }
            : item),
        }
      }
    case 'tool.completed':
      {
        const dispatch = asDispatchResult(event.result.data)
        return {
          ...state,
          ...(dispatch ? { subAgents: dispatch.results, taskBudget: dispatch.budget } : {}),
          tools: state.tools.map((item) => item.call.id === event.callId
            ? { ...item, status: 'completed', result: event.result, completedAt: Date.now() }
            : item),
        }
      }
    case 'run.completed':
      return {
        ...state,
        status: 'completed',
        usage: event.usage,
        metrics: computeMetrics(state, event.usage),
        completedAt: Date.now(),
      }
    case 'run.failed':
      return {
        ...state,
        status: event.error.kind === 'aborted' ? 'aborted' : 'failed',
        error: event.error.message,
        usage: event.usage,
        metrics: computeMetrics(state, event.usage),
        completedAt: Date.now(),
      }
    case 'run.exhausted':
      return {
        ...state,
        status: 'exhausted',
        error: exhaustedLabel(event.reason),
        usage: event.usage,
        metrics: computeMetrics(state, event.usage),
        completedAt: Date.now(),
      }
    default:
      return state
  }
}


interface SubAgentDetail {
  agent: RunSubAgentItem
  budget?: TaskTreeBudgetSnapshot
}

function asSubAgentDetail(value: unknown): SubAgentDetail | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const detail = value as { agent?: unknown; budget?: unknown }
  if (!detail.agent || typeof detail.agent !== 'object' || Array.isArray(detail.agent)) return undefined
  const agent = detail.agent as Record<string, unknown>
  if (typeof agent.agentId !== 'string' || typeof agent.runId !== 'string' || typeof agent.parentRunId !== 'string' || typeof agent.role !== 'string' || typeof agent.task !== 'string' || typeof agent.status !== 'string') return undefined
  return {
    agent: {
      agentId: agent.agentId,
      runId: agent.runId,
      parentRunId: agent.parentRunId,
      role: agent.role,
      task: agent.task,
      status: agent.status as RunSubAgentItem['status'],
      ...(typeof agent.content === 'string' ? { content: agent.content } : {}),
      ...(isUsage(agent.usage) ? { usage: agent.usage } : {}),
      ...(typeof agent.error === 'string' ? { error: agent.error } : {}),
    },
    budget: isBudget(detail.budget) ? detail.budget : undefined,
  }
}

function updateSubAgent(state: RunState, agent: RunSubAgentItem, budget?: TaskTreeBudgetSnapshot): RunState {
  const current = state.subAgents ?? []
  const index = current.findIndex((item) => item.agentId === agent.agentId)
  const subAgents = index < 0
    ? [...current, agent]
    : current.map((item, position) => position === index ? { ...item, ...agent } : item)
  return { ...state, subAgents, ...(budget ? { taskBudget: budget } : {}) }
}

function asDispatchResult(value: unknown): { results: RunSubAgentItem[]; budget?: TaskTreeBudgetSnapshot } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as { results?: unknown; budget?: unknown }
  if (!Array.isArray(candidate.results)) return undefined
  const results = candidate.results.filter((item): item is RunSubAgentItem => Boolean(item) && typeof item === 'object' && typeof (item as RunSubAgentItem).agentId === 'string')
  return { results, budget: isBudget(candidate.budget) ? candidate.budget : undefined }
}

function isUsage(value: unknown): value is UsageStats {
  return Boolean(value) && typeof value === 'object' && Number.isFinite((value as UsageStats).totalTokens)
}

function isBudget(value: unknown): value is TaskTreeBudgetSnapshot {
  return Boolean(value) && typeof value === 'object' && Number.isFinite((value as TaskTreeBudgetSnapshot).limit) && Number.isFinite((value as TaskTreeBudgetSnapshot).used)
}

function exhaustedLabel(reason: Extract<QueryEvent, { type: 'run.exhausted' }>['reason']): string {
  if (reason === 'max_turns') return '已达到最大运行轮数'
  if (reason === 'max_tokens') return '已达到 token 上限'
  return '已达到工具调用上限'
}
