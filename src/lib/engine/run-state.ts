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
  /** Sum of completed per-turn decode windows, excluding inter-turn gaps. */
  modelGenerationMs?: number
  /** First chunk of the currently active model turn. */
  activeModelFirstTokenAt?: number
  /** Safe aggregate model activity; never contains raw deliberation text. */
  activity?: {
    phase: string
    label: string
    observedChars?: number
  }
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
  const hasPerTurnWindow = state.modelGenerationMs !== undefined || state.activeModelFirstTokenAt !== undefined
  const activeGenerationMs = state.activeModelFirstTokenAt
    ? Math.max(0, completedAt - state.activeModelFirstTokenAt)
    : 0
  const totalGenMs = hasPerTurnWindow
    ? Math.max(0, (state.modelGenerationMs ?? 0) + activeGenerationMs - toolExecutionMs(state))
    : Math.max(0, (state.firstTokenAt ? completedAt - state.firstTokenAt : durationMs) - toolExecutionMs(state))
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
    case 'run.phase':
      return {
        ...state,
        activity: {
          phase: event.phase,
          label: event.detail?.trim() || runPhaseLabel(event.phase),
        },
      }
    case 'model.progress':
      {
        const now = Date.now()
        const completedGeneration = event.phase === 'preparing' && state.activeModelFirstTokenAt
          ? Math.max(0, now - state.activeModelFirstTokenAt)
          : 0
        const startsFirstChunk = event.phase !== 'preparing' && !state.activeModelFirstTokenAt
        return {
          ...state,
          activity: {
            phase: event.phase,
            label: modelProgressLabel(event.phase),
            ...(event.observedChars === undefined ? {} : { observedChars: event.observedChars }),
          },
          ...(startsFirstChunk ? { activeModelFirstTokenAt: now } : {}),
          ...(completedGeneration > 0
            ? { modelGenerationMs: (state.modelGenerationMs ?? 0) + completedGeneration, activeModelFirstTokenAt: undefined }
            : {}),
          ...(!state.firstTokenAt && event.phase !== 'preparing' ? { firstTokenAt: now } : {}),
        }
      }
    case 'message.delta':
      {
        const now = Date.now()
        return {
        ...state,
        text: state.text + event.text,
        ...(event.text && !state.firstTokenAt ? { firstTokenAt: now } : {}),
        ...(event.text && !state.activeModelFirstTokenAt ? { activeModelFirstTokenAt: now } : {}),
        }
      }
    case 'message.completed':
      {
        const now = Date.now()
        return {
        ...state,
        ...(state.text ? {} : { text: event.content }),
        ...(event.content && !state.firstTokenAt ? { firstTokenAt: now } : {}),
        ...(event.content && !state.activeModelFirstTokenAt ? { activeModelFirstTokenAt: now } : {}),
        }
      }
    case 'tool.requested':
      {
        const now = Date.now()
        const activity = toolActivity(event.call.name)
        return {
        ...state,
        ...(activity ? { activity } : {}),
        ...(!state.firstTokenAt ? { firstTokenAt: now } : {}),
        ...(!state.activeModelFirstTokenAt ? { activeModelFirstTokenAt: now } : {}),
        tools: [...state.tools, { call: event.call, status: 'requested', startedAt: now }],
        }
      }
    case 'tool.progress':
      {
        const detail = asSubAgentDetail(event.progress.detail)
        const withAgent = detail ? updateSubAgent(state, detail.agent, detail.budget) : state
        const activity = progressActivity(event.progress.phase, event.progress.message)
        return {
          ...withAgent,
          ...(activity ? { activity } : {}),
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
    case 'skill.activated':
      return {
        ...state,
        activity: { phase: 'preparing', label: `正在使用 ${event.name} Skill…` },
      }
    case 'run.completed':
      {
        const completedAt = Date.now()
        const finalizedState: RunState = {
          ...state,
          activity: undefined,
          status: 'completed',
          usage: event.usage,
          ...(state.activeModelFirstTokenAt
            ? { modelGenerationMs: (state.modelGenerationMs ?? 0) + Math.max(0, completedAt - state.activeModelFirstTokenAt), activeModelFirstTokenAt: undefined }
            : {}),
          completedAt,
        }
        return { ...finalizedState, metrics: computeMetrics(finalizedState, event.usage) }
      }
    case 'run.failed':
      return {
        ...state,
        activity: undefined,
        status: event.error.kind === 'aborted' ? 'aborted' : 'failed',
        error: event.error.message,
        usage: event.usage,
        metrics: computeMetrics(state, event.usage),
        completedAt: Date.now(),
      }
    case 'run.exhausted':
      return {
        ...state,
        activity: undefined,
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

function modelProgressLabel(phase: Extract<QueryEvent, { type: 'model.progress' }>['phase']): string {
  if (phase === 'preparing') return '正在准备上下文…'
  if (phase === 'reasoning') return '正在分析任务…'
  if (phase === 'generating') return '正在生成结果…'
  return '正在准备工具调用…'
}

function runPhaseLabel(phase: Extract<QueryEvent, { type: 'run.phase' }>['phase']): string {
  if (phase === 'preparing_attachments') return '正在准备附件…'
  if (phase === 'selecting_skill') return '正在选择 Skill…'
  if (phase === 'reading_sources') return '正在读取来源…'
  if (phase === 'validating') return '正在验证交付物…'
  if (phase === 'repairing') return '正在修复交付物…'
  return '正在生成交付物…'
}

function toolActivity(name: string): RunState['activity'] | undefined {
  if (name === 'search_attachments' || name === 'read_attachment' || name === 'prepare_attachment_evidence') {
    return { phase: 'reading_sources', label: '正在读取来源…' }
  }
  if (name === 'generate_pptd') return { phase: 'generating', label: '正在生成交付物…' }
  return undefined
}

function progressActivity(phase: string, message?: string): RunState['activity'] | undefined {
  if (!phase.startsWith('pptd_')) return undefined
  const stage = phase.slice('pptd_'.length)
  if (stage === 'repair') return { phase: 'repairing', label: message || '正在修复交付物…' }
  if (stage === 'assemble' || stage === 'review') return { phase: 'validating', label: message || '正在验证交付物…' }
  if (stage === 'source') return { phase: 'reading_sources', label: message || '正在读取来源…' }
  return { phase: 'generating', label: message || '正在生成交付物…' }
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
  if (reason === 'max_output_tokens') return '已自动精简上下文重试，但模型仍未在本轮输出预算内产生有效结果'
  if (reason === 'max_tokens') return '已达到 token 上限'
  if (reason === 'tool_loop') return '检测到工具无进展循环，已停止继续检索'
  return '已达到工具调用上限'
}
