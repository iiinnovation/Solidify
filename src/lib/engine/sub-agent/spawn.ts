import { newId } from '../../id'
import type { PermissionMap } from '../../harness/types'
import type { QueryContext, QueryEvent, UsageStats } from '../types'
import { runQuery } from '../query'
import { applyRoleDefaults } from './roles'
import { SubAgentScheduler } from './scheduler'
import {
  MAX_SUB_AGENT_DEPTH,
  MAX_SUB_AGENTS_PER_DISPATCH,
  type DispatchSubAgentsOptions,
  type SubAgentProgress,
  type SubAgentResult,
  type SubAgentSpec,
} from './types'

const EMPTY_USAGE: UsageStats = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  turns: 0,
  toolCalls: 0,
})

const signalDisposers = new WeakMap<AbortSignal, () => void>()

export async function dispatchSubAgents(
  parent: QueryContext,
  specs: readonly SubAgentSpec[],
  options: DispatchSubAgentsOptions = {},
): Promise<SubAgentResult[]> {
  assertDispatch(parent, specs)
  const signal = options.signal ?? parent.signal
  const scheduler = new SubAgentScheduler(options.concurrency)
  const runner = options.runner ?? runQuery
  const normalized = specs.map((spec) => ({ ...applyRoleDefaults(spec), id: spec.id?.trim() || newId('agent') }))

  const settled = await scheduler.run(normalized, async (spec) => {
    const runId = `${parent.runId}:${spec.id}`
    const child = createSubAgentContext(parent, spec, runId, signal)
    return consumeSubAgent(child, spec, runner, options.onProgress)
  }, signal)

  return settled.map((entry, index) => {
    if (entry.status === 'fulfilled') return entry.value
    const spec = normalized[index]
    const runId = `${parent.runId}:${spec.id}`
    const aborted = signal.aborted || parent.taskTree?.budget.signal.aborted
    return {
      agentId: spec.id,
      runId,
      parentRunId: parent.runId,
      role: spec.role,
      task: spec.task,
      status: aborted ? 'aborted' : 'failed',
      content: '',
      usage: usageForRun(parent, runId),
      durationMs: 0,
      error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
    }
  })
}

export function createSubAgentContext(
  parent: QueryContext,
  spec: SubAgentSpec,
  runId: string,
  signal = parent.signal,
): QueryContext {
  const requestedTools = spec.allowedTools ? new Set(spec.allowedTools) : undefined
  const tools = parent.tools.filter((tool) =>
    tool.name !== 'dispatch_agent'
    && (requestedTools ? requestedTools.has(tool.name) : tool.readOnly),
  )
  const maxTokens = boundedInteger(spec.maxTokens, parent.limits.maxTokens, parent.limits.maxTokens)
  const maxTurns = boundedInteger(spec.maxTurns, parent.limits.maxTurns, parent.limits.maxTurns)
  const roleContext = [
    `You are the ${spec.role} sub-agent in a bounded one-level task tree.`,
    'Complete only the delegated task. Return a concise, self-contained result to the parent agent.',
    spec.systemPrompt?.trim(),
  ].filter(Boolean).join('\n')

  const combinedSignal = combineSignals([signal, parent.taskTree?.budget.signal])
  if (combinedSignal.dispose) signalDisposers.set(combinedSignal.signal, combinedSignal.dispose)
  return {
    ...parent,
    runId,
    parentRunId: parent.runId,
    conversationId: `${parent.conversationId}:sub:${spec.id}`,
    messages: [{ role: 'user', content: spec.task }],
    tools,
    model: { ...parent.model, model: spec.model?.trim() || parent.model.model },
    limits: { ...parent.limits, maxTokens, maxTurns },
    signal: combinedSignal.signal,
    snapshots: undefined,
    restoreSnapshot: false,
    harnessContext: [...(parent.harnessContext ?? []), roleContext],
    permissions: narrowPermissions(parent.permissions, tools),
    taskTree: parent.taskTree
      ? { ...parent.taskTree, depth: MAX_SUB_AGENT_DEPTH }
      : undefined,
  }
}

function combineSignals(
  signals: readonly (AbortSignal | undefined)[],
): { signal: AbortSignal; dispose?: () => void } {
  const active = [...new Set(signals.filter((signal): signal is AbortSignal => Boolean(signal)))]
  if (active.length === 0) return { signal: new AbortController().signal }
  if (active.length === 1) return { signal: active[0] }
  const controller = new AbortController()
  const listeners = new Map<AbortSignal, () => void>()
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const [current, listener] of listeners) current.removeEventListener('abort', listener)
    listeners.clear()
  }
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason)
    dispose()
  }
  for (const signal of active) {
    const listener = () => abort(signal)
    listeners.set(signal, listener)
  }
  for (const signal of active) {
    if (disposed) break
    const listener = listeners.get(signal)!
    if (signal.aborted) abort(signal)
    else signal.addEventListener('abort', listener, { once: true })
  }
  return { signal: controller.signal, dispose }
}

function assertDispatch(parent: QueryContext, specs: readonly SubAgentSpec[]): void {
  if (parent.parentRunId || parent.taskTree?.depth === MAX_SUB_AGENT_DEPTH) {
    throw new Error('Sub-agents cannot dispatch another sub-agent')
  }
  if (specs.length < 1 || specs.length > MAX_SUB_AGENTS_PER_DISPATCH) {
    throw new Error(`A dispatch must contain between 1 and ${MAX_SUB_AGENTS_PER_DISPATCH} sub-agents`)
  }
  const ids = new Set<string>()
  for (const spec of specs) {
    if (!spec.role.trim()) throw new Error('Sub-agent role is required')
    if (!spec.task.trim()) throw new Error('Sub-agent task is required')
    if (spec.id && ids.has(spec.id)) throw new Error(`Duplicate sub-agent id: ${spec.id}`)
    if (spec.id) ids.add(spec.id)
    if (spec.allowedTools) {
      const parentTools = new Set(parent.tools.map((tool) => tool.name))
      const invalid = spec.allowedTools.find((name) => !parentTools.has(name) || name === 'dispatch_agent')
      if (invalid) throw new Error(`Sub-agent tool '${invalid}' is not available to the parent`)
    }
  }
}

async function consumeSubAgent(
  context: QueryContext,
  spec: SubAgentSpec & { id: string },
  runner: (ctx: QueryContext) => AsyncGenerator<QueryEvent>,
  onProgress?: (progress: SubAgentProgress) => void,
): Promise<SubAgentResult> {
  const startedAt = Date.now()
  let content = ''
  let usage = { ...EMPTY_USAGE }
  let status: SubAgentResult['status'] = 'failed'
  let error: string | undefined

  try {
    onProgress?.(progressOf(context, spec, 'running'))
    for await (const event of runner(context)) {
      if (event.type === 'message.delta') content += event.text
      else if (event.type === 'message.completed' && !content) content = event.content
      else if (event.type === 'run.completed') {
        usage = event.usage
        status = 'completed'
      } else if (event.type === 'run.exhausted') {
        usage = event.usage ?? usage
        status = 'exhausted'
        error = `Sub-agent exhausted: ${event.reason}`
      } else if (event.type === 'run.failed') {
        usage = event.usage ?? usage
        status = event.error.kind === 'aborted' ? 'aborted' : 'failed'
        error = event.error.message
      }
    }
  } finally {
    signalDisposers.get(context.signal)?.()
    signalDisposers.delete(context.signal)
  }

  usage = reconcileUsage(usage, usageForRun(context, context.runId))

  if (context.taskTree?.budget.abortReason === 'budget_exhausted' && status === 'aborted') {
    status = 'exhausted'
    error = 'Task-tree token budget exhausted'
  }
  const result: SubAgentResult = {
    agentId: spec.id,
    runId: context.runId,
    parentRunId: context.parentRunId!,
    role: spec.role,
    task: spec.task,
    status,
    content,
    usage,
    durationMs: Date.now() - startedAt,
    ...(error ? { error } : {}),
  }
  onProgress?.(progressOf(context, spec, status, result))
  return result
}

function progressOf(
  context: QueryContext,
  spec: SubAgentSpec & { id: string },
  status: SubAgentProgress['status'],
  result?: SubAgentResult,
): SubAgentProgress {
  return {
    agentId: spec.id,
    runId: context.runId,
    parentRunId: context.parentRunId!,
    role: spec.role,
    task: spec.task,
    status,
    ...(result?.content ? { content: result.content } : {}),
    ...(result?.usage ? { usage: result.usage } : {}),
    ...(result?.error ? { error: result.error } : {}),
  }
}

function narrowPermissions(
  permissions: QueryContext['permissions'],
  tools: QueryContext['tools'],
): PermissionMap | undefined {
  if (!permissions) return undefined
  const required = new Set(tools.flatMap((tool) => tool.permissions))
  return new Map([...permissions]
    .filter(([scope]) => required.has(scope))
    .map(([scope, entry]) => [scope, {
      ...entry,
      status: entry.status === 'granted' ? 'prompt' : entry.status,
    }]))
}

function usageForRun(context: QueryContext, runId: string): UsageStats {
  const totalTokens = context.taskTree?.budget.snapshot().byRun[runId] ?? 0
  return { ...EMPTY_USAGE, totalTokens }
}

function reconcileUsage(reported: UsageStats, metered: UsageStats): UsageStats {
  return metered.totalTokens > reported.totalTokens
    ? { ...reported, totalTokens: metered.totalTokens }
    : reported
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Sub-agent limits must be positive integers')
  return Math.min(value, maximum)
}
