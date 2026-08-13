/**
 * M1-12: Abort semantics tests for the query loop
 * - AbortSignal threads through model request and tool execution
 * - Completed tool results are preserved on abort, no rollback
 * - gen.return() triggers finally cleanup (in-flight work cancelled)
 * @see docs/specs/agent-loop.md §4
 */

import { describe, it, expect } from 'vitest'
import { runQuery } from '../query'
import type { QueryContext, QueryEvent } from '../types'
import { ProviderRegistry } from '../../model'
import type { ModelProvider } from '../../model'
import type { CompletionChunk, CompletionRequest } from '../../model/types'
import type { Tool, ToolResult } from '../../tools/types'
import type { MemoryState } from '../../memory/types'

// ============================================================================
// Test helpers
// ============================================================================

/**
 * Mock provider that replays scripted chunks per stream() call.
 * Mimics SDK behavior: throws when request.signal fires mid-stream.
 */
function makeMockProvider(script: CompletionChunk[][]) {
  let callIndex = 0
  let capturedSignal: AbortSignal | undefined

  const provider: ModelProvider = {
    name: 'mock',
    metadata: {
      name: 'mock',
      displayName: 'Mock',
      supportsVision: false,
      supportsTools: true,
      supportsStreaming: true,
      defaultMaxTokens: 4096,
      models: ['mock-model'],
    },
    async *stream(request: CompletionRequest): AsyncGenerator<CompletionChunk> {
      capturedSignal = request.signal
      const chunks = script[Math.min(callIndex++, script.length - 1)]
      yield { type: 'message_start' }
      for (const chunk of chunks) {
        // SDKs abort the HTTP stream when signal fires
        if (request.signal?.aborted) {
          throw new Error('Request was aborted')
        }
        yield chunk
      }
    },
  }

  return {
    provider,
    getCapturedSignal: () => capturedSignal,
  }
}

/** Minimal tool stub so tool calls pass the M1-11 existence check.
 *  concurrencySafe: false forces the serial execution path — the
 *  between-tools abort semantics under test only exist there (M1-15). */
const echoTool: Tool = {
  name: 'echo',
  description: 'Echo input back',
  inputSchema: { type: 'object' },
  readOnly: true,
  concurrencySafe: false,
  destructive: false,
  requiresConfirmation: false,
  availability: 'always',
  permissions: [],
  async execute(): Promise<ToolResult> {
    return { success: true, content: 'ok' }
  },
  renderCall: () => 'echo',
}

function makeCtx(
  provider: ModelProvider,
  signal: AbortSignal,
  overrides: Partial<QueryContext> = {},
): QueryContext {
  const registry = new ProviderRegistry()
  registry.register('mock', provider)

  return {
    runId: 'test-run',
    conversationId: 'test-conv',
    cwd: '/tmp',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [echoTool],
    memory: {} as MemoryState,
    model: { provider: 'mock', model: 'mock-model' },
    limits: {
      maxTurns: 5,
      maxTokens: 100_000,
      maxOutputTokens: 1000,
      maxToolCalls: 10,
      toolTimeoutMs: 1000,
    },
    signal,
    providerRegistry: registry,
    ...overrides,
  }
}

/** Consume the generator, invoking onEvent after each event */
async function collect(
  gen: AsyncGenerator<QueryEvent>,
  onEvent?: (ev: QueryEvent) => void,
): Promise<QueryEvent[]> {
  const events: QueryEvent[] = []
  for await (const ev of gen) {
    events.push(ev)
    onEvent?.(ev)
  }
  return events
}

const textTurn: CompletionChunk[] = [
  { type: 'content_delta', delta: 'Hello ' },
  { type: 'content_delta', delta: 'world' },
  {
    type: 'message_end',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    stopReason: 'end_turn',
  },
]

const twoToolCallsTurn: CompletionChunk[] = [
  { type: 'tool_call_start', id: 't1', name: 'echo' },
  { type: 'tool_call_end', id: 't1', input: { value: 1 } },
  { type: 'tool_call_start', id: 't2', name: 'echo' },
  { type: 'tool_call_end', id: 't2', input: { value: 2 } },
  {
    type: 'message_end',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    stopReason: 'tool_use',
  },
]

// ============================================================================
// Tests
// ============================================================================

describe('runQuery abort semantics (M1-12)', () => {
  it('aborts before first turn → run.failed{aborted}', async () => {
    const { provider } = makeMockProvider([textTurn])
    const controller = new AbortController()
    controller.abort()

    const events = await collect(runQuery(makeCtx(provider, controller.signal)))

    expect(events[0]).toEqual({ type: 'run.started', runId: 'test-run' })
    const last = events[events.length - 1]
    expect(last.type).toBe('run.failed')
    if (last.type === 'run.failed') {
      expect(last.error.kind).toBe('aborted')
    }
  })

  it('abort mid-stream cancels the model request → run.failed{aborted}', async () => {
    const { provider, getCapturedSignal } = makeMockProvider([textTurn])
    const controller = new AbortController()

    const events = await collect(
      runQuery(makeCtx(provider, controller.signal)),
      (ev) => {
        if (ev.type === 'message.delta') {
          controller.abort()
        }
      },
    )

    const last = events[events.length - 1]
    expect(last.type).toBe('run.failed')
    if (last.type === 'run.failed') {
      expect(last.error.kind).toBe('aborted')
    }
    // No completed message on abort
    expect(events.some((e) => e.type === 'message.completed')).toBe(false)
    // External abort propagated into the request signal (HTTP would be cancelled)
    expect(getCapturedSignal()?.aborted).toBe(true)
  })

  it('abort between tools preserves completed results, aborts the rest', async () => {
    const { provider } = makeMockProvider([twoToolCallsTurn])
    const controller = new AbortController()

    const events = await collect(
      runQuery(makeCtx(provider, controller.signal)),
      (ev) => {
        // Abort as soon as the first tool finishes
        if (ev.type === 'tool.completed' && ev.callId === 't1') {
          controller.abort()
        }
      },
    )

    const completed = events.filter(
      (e): e is Extract<QueryEvent, { type: 'tool.completed' }> =>
        e.type === 'tool.completed',
    )
    expect(completed).toHaveLength(2)

    // First tool ran (stub executor → runtime error, but NOT aborted): preserved
    expect(completed[0].callId).toBe('t1')
    expect(completed[0].result.error?.kind).not.toBe('aborted')

    // Second tool never ran: synthetic aborted result keeps history well-formed
    expect(completed[1].callId).toBe('t2')
    expect(completed[1].result.error?.kind).toBe('aborted')

    const last = events[events.length - 1]
    expect(last.type).toBe('run.failed')
    if (last.type === 'run.failed') {
      expect(last.error.kind).toBe('aborted')
    }
  })

  it('gen.return() triggers finally cleanup and cancels in-flight request', async () => {
    const { provider, getCapturedSignal } = makeMockProvider([textTurn])
    const controller = new AbortController()

    const gen = runQuery(makeCtx(provider, controller.signal))

    // Consume until the stream is in-flight
    let sawDelta = false
    for await (const ev of gen) {
      if (ev.type === 'message.delta') {
        sawDelta = true
        break // for-await break calls gen.return() → finally runs
      }
    }

    expect(sawDelta).toBe(true)
    // Internal controller aborted in finally, even though external never fired
    expect(controller.signal.aborted).toBe(false)
    expect(getCapturedSignal()?.aborted).toBe(true)
  })

  it('completes normally when signal never fires', async () => {
    const { provider } = makeMockProvider([textTurn])
    const controller = new AbortController()

    const events = await collect(runQuery(makeCtx(provider, controller.signal)))

    expect(events.some((e) => e.type === 'message.completed')).toBe(true)
    const last = events[events.length - 1]
    expect(last.type).toBe('run.completed')
  })
})
