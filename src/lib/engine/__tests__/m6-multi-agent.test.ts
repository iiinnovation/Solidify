import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryState } from '../../memory'
import { ProviderRegistry } from '../../model'
import type { CompletionChunk, CompletionRequest, ModelProvider } from '../../model'
import { resetFlagCache, setFlagOverride } from '../../harness/flags'
import type { Tool } from '../../tools/types'
import { enableSubAgents } from '../sub-agent/context'
import { dispatchSubAgents } from '../sub-agent/spawn'
import { runQuery } from '../query'
import type { QueryContext, QueryEvent } from '../types'

const finalTurn: CompletionChunk[] = [
  { type: 'content_delta', delta: 'child result' },
  { type: 'message_end', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, stopReason: 'end_turn' },
]

const dispatchTurn: CompletionChunk[] = [
  { type: 'tool_call_start', id: 'dispatch-1', name: 'dispatch_agent' },
  {
    type: 'tool_call_end',
    id: 'dispatch-1',
    input: {
      tasks: [
        { id: 'research', role: 'researcher', task: 'Read source A' },
        { id: 'check', role: 'fact_checker', task: 'Read source B' },
      ],
      concurrency: 2,
    },
  },
  { type: 'message_end', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, stopReason: 'tool_use' },
]

const rootFinal: CompletionChunk[] = [
  { type: 'content_delta', delta: 'combined result' },
  { type: 'message_end', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, stopReason: 'end_turn' },
]

const readTool: Tool = {
  name: 'read_file',
  description: 'read',
  inputSchema: { type: 'object' },
  readOnly: true,
  concurrencySafe: true,
  destructive: false,
  requiresConfirmation: false,
  availability: 'always',
  permissions: ['fs:read'],
  execute: async () => ({ success: true, content: 'source' }),
  renderCall: () => 'read',
}

function context(provider: ModelProvider): QueryContext {
  const providers = new ProviderRegistry()
  providers.register('mock', provider)
  return {
    runId: 'm6-root',
    conversationId: 'm6-conversation',
    cwd: '/workspace',
    messages: [{ role: 'user', content: 'delegate these sources' }],
    tools: [readTool],
    memory: new InMemoryState(),
    model: { provider: 'mock', model: 'mock-model' },
    limits: { maxTurns: 5, maxTokens: 30, maxOutputTokens: 1000, maxToolCalls: 10, toolTimeoutMs: 1000 },
    signal: new AbortController().signal,
    providerRegistry: providers,
    workspace: { root: '/workspace', name: 'workspace', resolve: (path: string) => `/workspace/${path}`, contains: () => true },
    platform: 'web',
  }
}

function provider(childDelayMs = 0): ModelProvider {
  let rootTurns = 0
  return {
    name: 'mock',
    metadata: {
      name: 'mock', displayName: 'mock', supportsVision: false, supportsTools: true,
      supportsStreaming: true, defaultMaxTokens: 1000, models: ['mock-model'],
    },
    async *stream(request: CompletionRequest) {
      const childRequest = request.messages.some((message) => typeof message.content === 'string' && /Read source [AB]/.test(message.content))
      if (childRequest) {
        if (childDelayMs) await new Promise((resolve) => setTimeout(resolve, childDelayMs))
        yield* finalTurn
        return
      }
      yield* (rootTurns++ === 0 ? dispatchTurn : rootFinal)
    },
  }
}

async function collect(generator: AsyncGenerator<QueryEvent>): Promise<QueryEvent[]> {
  const events: QueryEvent[] = []
  for await (const event of generator) events.push(event)
  return events
}

describe('M6 multi-agent acceptance', () => {
  beforeEach(() => setFlagOverride('harness', true))
  afterEach(() => {
    localStorage.clear()
    resetFlagCache()
  })

  it('runs a bounded parallel dispatch through the real query loop', async () => {
    const root = enableSubAgents(context(provider()))
    const events = await collect(runQuery(root))
    const dispatch = events.find((event) => event.type === 'tool.completed' && event.result.data && typeof event.result.data === 'object')

    expect(events.at(-1)?.type).toBe('run.completed')
    expect(events.filter((event) => event.type === 'tool.progress' && event.progress.phase === 'sub_agents').length).toBeGreaterThanOrEqual(4)
    expect(dispatch).toBeDefined()
    if (dispatch?.type === 'tool.completed') {
      const results = (dispatch.result.data as { results: Array<{ status: string }> }).results
      expect(results.map((result) => result.status)).toEqual(['completed', 'completed'])
    }
    const researchLedger = JSON.parse(localStorage.getItem('solidify-ledger:m6-root:research') ?? '[]') as Array<{ type: string; payload: { parentRunId?: string } }>
    expect(researchLedger.find((event) => event.type === 'run.started')?.payload.parentRunId).toBe('m6-root')
  })

  it('does not apply the single-tool fallback timeout to child query loops', async () => {
    const base = context(provider(80))
    const root = enableSubAgents({
      ...base,
      limits: { ...base.limits, toolTimeoutMs: 20 },
    })
    const events = await collect(runQuery(root))
    const dispatch = events.find((event) => event.type === 'tool.completed' && event.callId === 'dispatch-1')

    expect(dispatch).toMatchObject({ type: 'tool.completed', result: { success: true } })
    if (dispatch?.type === 'tool.completed') {
      const results = (dispatch.result.data as { results: Array<{ status: string }> }).results
      expect(results.map((result) => result.status)).toEqual(['completed', 'completed'])
    }
  })

  it('aborts the entire tree when shared budget is exhausted', async () => {
    const base = context(provider())
    const root = enableSubAgents({ ...base, limits: { ...base.limits, maxTokens: 5 } })
    const events = await collect(runQuery(root))

    expect(events.at(-1)).toMatchObject({ type: 'run.exhausted', reason: 'max_tokens' })
    expect(events.some((event) => event.type === 'run.completed')).toBe(false)
    expect(root.taskTree?.budget.abortReason).toBe('budget_exhausted')
  })

  it('propagates parent cancellation without orphaned child runs', async () => {
    const controller = new AbortController()
    let started = 0
    let releaseStarted!: () => void
    const startedGate = new Promise<void>((resolve) => { releaseStarted = resolve })
    const runner = async function* (ctx: QueryContext): AsyncGenerator<QueryEvent> {
      started++
      if (started === 2) releaseStarted()
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve()
        else ctx.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      yield { type: 'run.failed', error: { kind: 'aborted', message: 'parent stopped' } }
    }
    const dispatch = dispatchSubAgents(context(provider()), [
      { id: 'one', role: 'researcher', task: 'A' },
      { id: 'two', role: 'researcher', task: 'B' },
      { id: 'three', role: 'researcher', task: 'C' },
    ], { concurrency: 2, runner, signal: controller.signal })

    await startedGate
    controller.abort()
    const results = await dispatch
    expect(results.map((result) => result.status)).toEqual(['aborted', 'aborted', 'aborted'])
    expect(started).toBe(2)
  })
})
