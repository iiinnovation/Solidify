/**
 * M1-14/15: Loop ↔ executor integration
 * Real execution through the loop, parallel path, mixed tombstone batch
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { runQuery } from '../query'
import type { QueryContext, QueryEvent } from '../types'
import { ProviderRegistry } from '../../model'
import type { ModelProvider } from '../../model'
import type { CompletionChunk, CompletionRequest } from '../../model/types'
import type { Tool, ToolResult } from '../../tools/types'
import type { MemoryState } from '../../memory/types'
import { clearFlagOverrides, setFlagOverride } from '../../harness/flags'

function makeMockProvider(script: CompletionChunk[][], requests?: CompletionRequest[]): ModelProvider {
  let callIndex = 0
  return {
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
      requests?.push(request)
      const chunks = script[Math.min(callIndex++, script.length - 1)]
      yield { type: 'message_start' }
      yield* chunks
    },
  }
}

/** Read-only concurrency-safe tool that records execution interleaving */
function makeSlowReadTool(
  name: string,
  delayMs: number,
  trace: string[],
): Tool {
  return {
    name,
    description: 'slow read',
    inputSchema: { type: 'object' },
    readOnly: true,
    concurrencySafe: true,
    destructive: false,
    requiresConfirmation: false,
    availability: 'always',
    permissions: [],
    async execute(): Promise<ToolResult> {
      trace.push(`${name}:start`)
      await new Promise((r) => setTimeout(r, delayMs))
      trace.push(`${name}:end`)
      return { success: true, content: `${name} done` }
    },
    renderCall: () => name,
  }
}

function makeCtx(provider: ModelProvider, tools: Tool[]): QueryContext {
  const registry = new ProviderRegistry()
  registry.register('mock', provider)

  return {
    runId: 'test-run',
    conversationId: 'conv-tools',
    cwd: '/tmp',
    messages: [{ role: 'user', content: 'hi' }],
    tools,
    memory: {} as MemoryState,
    model: { provider: 'mock', model: 'mock-model' },
    limits: {
      maxTurns: 5,
      maxTokens: 100_000,
      maxOutputTokens: 1000,
      maxToolCalls: 10,
      toolTimeoutMs: 1000,
    },
    signal: new AbortController().signal,
    providerRegistry: registry,
  }
}

const finalTurn: CompletionChunk[] = [
  { type: 'content_delta', delta: 'done' },
  {
    type: 'message_end',
    usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
    stopReason: 'end_turn',
  },
]

describe('runQuery tool execution (M1-14/15)', () => {
  beforeEach(() => {
    setFlagOverride('skillV2', false)
    setFlagOverride('harness', false)
  })

  afterEach(() => clearFlagOverrides())

  it('emits a generator-owned artifact directly without a second model turn', async () => {
    let providerCalls = 0
    const provider: ModelProvider = {
      ...makeMockProvider([]),
      async *stream(): AsyncGenerator<CompletionChunk> {
        providerCalls++
        yield { type: 'tool_call_start', id: 'deck-1', name: 'generate_pptd' }
        yield { type: 'tool_call_end', id: 'deck-1', input: {} }
        yield {
          type: 'message_end',
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          stopReason: 'tool_use',
        }
      },
    }
    const stored = new Map<string, string>()
    const memory: MemoryState = {
      async store(data) { stored.set('mem-deck', data); return 'mem-deck' },
      async retrieve(handle) { return stored.get(handle) ?? null },
      async search() { return [] },
      async clear() { stored.clear() },
    }
    const artifact = '<solidify-artifact title="Deck" type="slides" path="03-交付物/deck.pptd">{}</solidify-artifact>'
    const generator: Tool = {
      name: 'generate_pptd', description: 'generate', inputSchema: { type: 'object' },
      readOnly: true, concurrencySafe: false, destructive: false,
      requiresConfirmation: false, terminalOnFailure: true, availability: 'always', permissions: [],
      async execute(): Promise<ToolResult> {
        const contentHandle = await memory.store(artifact)
        return {
          success: true,
          content: 'generated',
          data: {
            directAssistantContent: true,
            contentHandle,
            artifact: { title: 'Deck', type: 'slides', path: '03-交付物/deck.pptd' },
            usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
          },
        }
      },
      renderCall: () => 'generate',
    }
    const ctx = { ...makeCtx(provider, [generator]), memory }
    const events: QueryEvent[] = []
    for await (const event of runQuery(ctx)) events.push(event)

    expect(providerCalls).toBe(1)
    expect(events).toContainEqual({ type: 'message.delta', text: artifact })
    expect(events.find((event) => event.type === 'run.completed')).toMatchObject({
      usage: { inputTokens: 40, outputTokens: 22, totalTokens: 62, toolCalls: 1 },
    })
  })

  it('terminates after a one-shot PPTD generator fails instead of retrying it', async () => {
    let providerCalls = 0
    const provider: ModelProvider = {
      ...makeMockProvider([]),
      async *stream(): AsyncGenerator<CompletionChunk> {
        providerCalls++
        yield { type: 'tool_call_start', id: `deck-${providerCalls}`, name: 'generate_pptd' }
        yield { type: 'tool_call_end', id: `deck-${providerCalls}`, input: { brief: 'deck' } }
        yield { type: 'message_end', stopReason: 'tool_use' }
      },
    }
    const generator: Tool = {
      name: 'generate_pptd', description: 'generate', inputSchema: { type: 'object' },
      readOnly: true, concurrencySafe: false, destructive: false,
      requiresConfirmation: false, terminalOnFailure: true, availability: 'always', permissions: [],
      async execute(): Promise<ToolResult> {
        throw new Error('PPTD page 输出达到 token 上限')
      },
      renderCall: () => 'generate',
    }
    const events: QueryEvent[] = []
    for await (const event of runQuery({ ...makeCtx(provider, [generator]) })) events.push(event)

    expect(providerCalls).toBe(1)
    expect(events.filter((event) => event.type === 'tool.requested')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      error: { kind: 'internal', message: 'PPTD page 输出达到 token 上限' },
    })
  })

  it('blocks a fourth execution after three consecutive failures', async () => {
    const scripts: CompletionChunk[][] = [0, 1, 2, 3].map((index) => [
      { type: 'tool_call_start' as const, id: `read-${index}`, name: 'flaky_read' },
      { type: 'tool_call_end' as const, id: `read-${index}`, input: {} },
      { type: 'message_end' as const, stopReason: 'tool_use' as const },
    ])
    scripts.push(finalTurn)
    let executions = 0
    const provider = makeMockProvider(scripts)
    const flaky: Tool = {
      name: 'flaky_read', description: 'flaky read', inputSchema: { type: 'object' },
      readOnly: true, concurrencySafe: false, destructive: false,
      requiresConfirmation: false, availability: 'always', permissions: [],
      async execute(): Promise<ToolResult> {
        executions++
        throw new Error('temporary failure')
      },
      renderCall: () => 'flaky read',
    }

    const events: QueryEvent[] = []
    for await (const event of runQuery(makeCtx(provider, [flaky]))) events.push(event)

    expect(executions).toBe(3)
    expect(events.filter((event) => event.type === 'tool.requested')).toHaveLength(4)
    expect(events.filter((event) => event.type === 'tool.completed').at(-1)).toMatchObject({
      result: {
        success: false,
        error: { kind: 'circuit_breaker', recoverable: false, message: expect.stringContaining('连续失败 3 次') },
      },
    })
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      error: { message: expect.stringContaining('连续失败 3 次') },
    })
  })

  it('closes a no-progress attachment loop and lets the model finish without attachment tools', async () => {
    const repeatedRead = (index: number): CompletionChunk[] => [
      { type: 'tool_call_start', id: `attachment-${index}`, name: 'read_attachment' },
      { type: 'tool_call_end', id: `attachment-${index}`, input: { attachmentId: 'att-a', offset: 0, limit: 100 } },
      { type: 'message_end', stopReason: 'tool_use' },
    ]
    const requests: CompletionRequest[] = []
    const provider = makeMockProvider([
      repeatedRead(1), repeatedRead(2), repeatedRead(3), repeatedRead(4), repeatedRead(5), finalTurn,
    ], requests)
    let executions = 0
    const attachmentReader: Tool = {
      name: 'read_attachment', description: 'read attachment', inputSchema: { type: 'object' },
      readOnly: true, concurrencySafe: true, destructive: false, requiresConfirmation: false,
      availability: 'always', permissions: [], loopGroup: 'attachment-retrieval', loopKey: 'read', replaySafe: true,
      async execute(): Promise<ToolResult> {
        executions++
        return { success: true, content: 'same attachment section '.repeat(20) }
      },
      renderCall: () => 'read attachment',
    }

    const events: QueryEvent[] = []
    const context = makeCtx(provider, [attachmentReader])
    for await (const event of runQuery({ ...context, limits: { ...context.limits, maxTurns: 6 } })) events.push(event)

    expect(executions).toBe(2)
    expect(events.filter((event) => event.type === 'tool.requested')).toHaveLength(5)
    expect(events.some((event) => event.type === 'tool.completed' && event.result.error?.kind === 'budget_exhausted')).toBe(true)
    expect(events.at(-1)?.type).toBe('run.completed')
    const finalRequest = requests.at(-1)
    expect(finalRequest?.tools ?? []).toEqual([])
  })

  it('terminates a model that ignores the closed retrieval phase', async () => {
    const repeatedRead = (index: number): CompletionChunk[] => [
      { type: 'tool_call_start', id: `stubborn-${index}`, name: 'read_attachment' },
      { type: 'tool_call_end', id: `stubborn-${index}`, input: { attachmentId: 'att-a', offset: 0 } },
      { type: 'message_end', stopReason: 'tool_use' },
    ]
    const provider = makeMockProvider(Array.from({ length: 8 }, (_, index) => repeatedRead(index)))
    const attachmentReader: Tool = {
      name: 'read_attachment', description: 'read attachment', inputSchema: { type: 'object' },
      readOnly: true, concurrencySafe: true, destructive: false, requiresConfirmation: false,
      availability: 'always', permissions: [], loopGroup: 'attachment-retrieval', loopKey: 'read', replaySafe: true,
      async execute(): Promise<ToolResult> { return { success: true, content: 'same attachment section '.repeat(20) } },
      renderCall: () => 'read attachment',
    }
    const context = makeCtx(provider, [attachmentReader])
    const events: QueryEvent[] = []
    for await (const event of runQuery({ ...context, limits: { ...context.limits, maxTurns: 8 } })) events.push(event)

    expect(events.at(-1)).toMatchObject({ type: 'run.exhausted', reason: 'tool_loop' })
  })

  it('enforces the provider-reported token hard cap separately from progress budget', async () => {
    const callTurn = (index: number): CompletionChunk[] => [
      { type: 'tool_call_start', id: `budget-${index}`, name: 'read_budgeted' },
      { type: 'tool_call_end', id: `budget-${index}`, input: {} },
      { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 60, outputTokens: 1, totalTokens: 61 } },
    ]
    const provider = makeMockProvider([callTurn(1), callTurn(2), finalTurn])
    const tool: Tool = {
      name: 'read_budgeted', description: 'read', inputSchema: { type: 'object' },
      readOnly: true, concurrencySafe: false, destructive: false, requiresConfirmation: false,
      availability: 'always', permissions: [],
      async execute(): Promise<ToolResult> { return { success: true, content: 'ok' } },
      renderCall: () => 'read',
    }
    const context = makeCtx(provider, [tool])
    const events: QueryEvent[] = []
    for await (const event of runQuery({
      ...context,
      limits: { ...context.limits, maxTokens: 100_000, maxProviderTokens: 100 },
    })) events.push(event)

    expect(events.at(-1)).toMatchObject({ type: 'run.exhausted', reason: 'max_tokens' })
    expect(events.find((event) => event.type === 'run.exhausted')).toMatchObject({ usage: { totalTokens: 122 } })
  })

  it('lets the model correct invalid generate_pptd arguments before the pipeline starts', async () => {
    const provider = makeMockProvider([
      [
        { type: 'tool_call_start', id: 'deck-invalid', name: 'generate_pptd' },
        { type: 'tool_call_end', id: 'deck-invalid', input: { brief: 'deck' } },
        { type: 'message_end', stopReason: 'tool_use' },
      ],
      [
        { type: 'tool_call_start', id: 'deck-valid', name: 'generate_pptd' },
        { type: 'tool_call_end', id: 'deck-valid', input: { brief: 'deck', attachmentIds: ['att-a'] } },
        { type: 'message_end', stopReason: 'tool_use' },
      ],
      finalTurn,
    ])
    let executions = 0
    const generator: Tool = {
      name: 'generate_pptd', description: 'generate',
      inputSchema: {
        type: 'object', required: ['brief', 'attachmentIds'],
        properties: {
          brief: { type: 'string' },
          attachmentIds: { type: 'array', items: { type: 'string', enum: ['att-a'] } },
        },
      },
      readOnly: true, concurrencySafe: false, destructive: false,
      requiresConfirmation: false, availability: 'always', permissions: [],
      async execute(): Promise<ToolResult> {
        executions++
        return { success: true, content: 'generated' }
      },
      renderCall: () => 'generate',
    }
    const events: QueryEvent[] = []
    for await (const event of runQuery(makeCtx(provider, [generator]))) events.push(event)

    expect(executions).toBe(1)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.completed',
      callId: 'deck-invalid',
      result: expect.objectContaining({ error: expect.objectContaining({ kind: 'invalid_input' }) }),
    }))
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  it('feeds capture results back as an image in the next model turn', async () => {
    const requests: CompletionRequest[] = []
    let turn = 0
    const provider: ModelProvider = {
      name: 'mock',
      metadata: {
        name: 'mock', displayName: 'Mock', supportsVision: true,
        supportsTools: true, supportsStreaming: true,
        defaultMaxTokens: 4096, models: ['mock-model'],
      },
      async *stream(request: CompletionRequest): AsyncGenerator<CompletionChunk> {
        requests.push(request)
        if (turn++ === 0) {
          yield { type: 'tool_call_start', id: 'preview-1', name: 'capture_preview' }
          yield { type: 'tool_call_end', id: 'preview-1', input: {} }
          yield { type: 'message_end', stopReason: 'tool_use' }
        } else {
          yield* finalTurn
        }
      },
    }
    const capture: Tool = {
      name: 'capture_preview', description: 'capture', inputSchema: { type: 'object' },
      readOnly: true, concurrencySafe: false, destructive: false,
      requiresConfirmation: false, availability: 'always', permissions: [],
      async execute(): Promise<ToolResult> {
        return {
          success: true,
          content: 'captured',
          data: { imageDataUrl: 'data:image/png;base64,cGl4ZWxz' },
        }
      },
      renderCall: () => 'capture',
    }

    for await (const _event of runQuery(makeCtx(provider, [capture]))) {
      // consume the run
    }

    expect(requests).toHaveLength(2)
    const lastMessage = requests[1].messages.at(-1)
    expect(lastMessage?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'preview-1' }),
      { type: 'image', url: 'data:image/png;base64,cGl4ZWxz' },
    ]))
  })

  it('runs read-only concurrency-safe tools in parallel', async () => {
    const trace: string[] = []
    const slowA = makeSlowReadTool('slow_a', 40, trace)
    const slowB = makeSlowReadTool('slow_b', 5, trace)

    const toolTurn: CompletionChunk[] = [
      { type: 'tool_call_start', id: 't1', name: 'slow_a' },
      { type: 'tool_call_end', id: 't1', input: {} },
      { type: 'tool_call_start', id: 't2', name: 'slow_b' },
      { type: 'tool_call_end', id: 't2', input: {} },
      { type: 'message_end', stopReason: 'tool_use' },
    ]

    const ctx = makeCtx(makeMockProvider([toolTurn, finalTurn]), [slowA, slowB])

    const events: QueryEvent[] = []
    for await (const ev of runQuery(ctx)) events.push(ev)

    // Parallel: slow_b starts before slow_a finishes
    expect(trace.indexOf('slow_b:start')).toBeLessThan(trace.indexOf('slow_a:end'))

    // Completions yielded in model-returned order regardless of finish order
    const completed = events.filter(
      (e): e is Extract<QueryEvent, { type: 'tool.completed' }> =>
        e.type === 'tool.completed',
    )
    expect(completed.map((c) => c.callId)).toEqual(['t1', 't2'])
    expect(completed.every((c) => c.result.success)).toBe(true)

    expect(events[events.length - 1].type).toBe('run.completed')
  })

  it('tombstones unknown tool in a batch while executing the valid one', async () => {
    const trace: string[] = []
    const reader = makeSlowReadTool('reader', 1, trace)

    const toolTurn: CompletionChunk[] = [
      { type: 'tool_call_start', id: 't1', name: 'nonexistent' },
      { type: 'tool_call_end', id: 't1', input: {} },
      { type: 'tool_call_start', id: 't2', name: 'reader' },
      { type: 'tool_call_end', id: 't2', input: {} },
      { type: 'message_end', stopReason: 'tool_use' },
    ]

    const ctx = makeCtx(makeMockProvider([toolTurn, finalTurn]), [reader])

    const events: QueryEvent[] = []
    for await (const ev of runQuery(ctx)) events.push(ev)

    // Tombstone emitted for the unknown tool
    const tombstones = events.filter((e) => e.type === 'tombstone')
    expect(tombstones).toHaveLength(1)

    // Both calls got results: feedback for unknown, real execution for reader
    const completed = events.filter(
      (e): e is Extract<QueryEvent, { type: 'tool.completed' }> =>
        e.type === 'tool.completed',
    )
    expect(completed).toHaveLength(2)
    const unknown = completed.find((c) => c.callId === 't1')!
    expect(unknown.result.success).toBe(false)
    expect(unknown.result.content).not.toContain('reader')
    expect(unknown.result.content).toContain('current tool definitions')

    const executed = completed.find((c) => c.callId === 't2')!
    expect(executed.result.success).toBe(true)
    expect(trace).toContain('reader:end')

    // Session survives (tombstone principle) and completes
    expect(events[events.length - 1].type).toBe('run.completed')
  })

  it('feeds validation errors back so the model can self-correct', async () => {
    const strictTool: Tool = {
      name: 'strict',
      description: 'needs path',
      inputSchema: { type: 'object', required: ['path'] },
      readOnly: true,
      concurrencySafe: true,
      destructive: false,
      requiresConfirmation: false,
      availability: 'always',
      permissions: [],
      async execute(): Promise<ToolResult> {
        return { success: true, content: 'read it' }
      },
      renderCall: () => 'strict',
    }

    // Turn 1: invalid args → turn 2: corrected args → final
    const badTurn: CompletionChunk[] = [
      { type: 'tool_call_start', id: 't1', name: 'strict' },
      { type: 'tool_call_end', id: 't1', input: {} },
      { type: 'message_end', stopReason: 'tool_use' },
    ]
    const goodTurn: CompletionChunk[] = [
      { type: 'tool_call_start', id: 't2', name: 'strict' },
      { type: 'tool_call_end', id: 't2', input: { path: 'a.md' } },
      { type: 'message_end', stopReason: 'tool_use' },
    ]

    const ctx = makeCtx(
      makeMockProvider([badTurn, goodTurn, finalTurn]),
      [strictTool],
    )

    const events: QueryEvent[] = []
    for await (const ev of runQuery(ctx)) events.push(ev)

    const tombstones = events.filter((e) => e.type === 'tombstone')
    expect(tombstones).toHaveLength(1)

    const completed = events.filter(
      (e): e is Extract<QueryEvent, { type: 'tool.completed' }> =>
        e.type === 'tool.completed',
    )
    expect(completed).toHaveLength(2)
    expect(completed[0].result.success).toBe(false)
    expect(completed[0].result.content).toContain('path')
    expect(completed[1].result.success).toBe(true)

    expect(events[events.length - 1].type).toBe('run.completed')
  })

  it('appends safety circuit breaker warning when same tool fails 3 consecutive times', async () => {
    const failingTool: Tool = {
      name: 'fail_tool',
      description: 'always fails',
      inputSchema: { type: 'object' },
      readOnly: true,
      concurrencySafe: true,
      destructive: false,
      requiresConfirmation: false,
      availability: 'always',
      permissions: [],
      async execute(): Promise<ToolResult> {
        return { success: false, content: 'failed to do work' }
      },
      renderCall: () => 'fail_tool',
    }

    const failTurn = (id: string): CompletionChunk[] => [
      { type: 'tool_call_start', id, name: 'fail_tool' },
      { type: 'tool_call_end', id, input: {} },
      { type: 'message_end', stopReason: 'tool_use' },
    ]

    const requests: CompletionRequest[] = []
    const ctx = makeCtx(
      makeMockProvider([failTurn('f1'), failTurn('f2'), failTurn('f3'), finalTurn], requests),
      [failingTool],
    )

    const events: QueryEvent[] = []
    for await (const ev of runQuery(ctx)) events.push(ev)

    expect(events.filter((e) => e.type === 'tool.completed')).toHaveLength(3)
    expect(events.at(-1)?.type).toBe('run.completed')

    // The warning has to reach the model, so assert on what the provider was
    // actually sent: silent until the third consecutive failure, then present.
    const sent = requests.map((request) => JSON.stringify(request.messages))
    expect(sent).toHaveLength(4)
    expect(sent[1]).not.toContain('安全熔断')
    expect(sent[2]).not.toContain('安全熔断')
    expect(sent[3]).toContain('安全熔断')
    expect(sent[3]).toContain('fail_tool')
  })

  it('resets the failure streak once the tool succeeds again', async () => {
    let attempt = 0
    const flakyTool: Tool = {
      name: 'flaky_tool',
      description: 'fails, then succeeds, then fails',
      inputSchema: { type: 'object' },
      readOnly: true,
      concurrencySafe: true,
      destructive: false,
      requiresConfirmation: false,
      availability: 'always',
      permissions: [],
      async execute(): Promise<ToolResult> {
        attempt++
        return attempt === 2
          ? { success: true, content: 'recovered' }
          : { success: false, content: 'failed to do work' }
      },
      renderCall: () => 'flaky_tool',
    }

    const callTurn = (id: string): CompletionChunk[] => [
      { type: 'tool_call_start', id, name: 'flaky_tool' },
      { type: 'tool_call_end', id, input: {} },
      { type: 'message_end', stopReason: 'tool_use' },
    ]

    const requests: CompletionRequest[] = []
    const ctx = makeCtx(
      makeMockProvider([callTurn('k1'), callTurn('k2'), callTurn('k3'), callTurn('k4'), finalTurn], requests),
      [flakyTool],
    )

    for await (const _ev of runQuery(ctx)) { /* drain */ }

    // fail, succeed, fail, fail — the streak restarts at the success, so two
    // later failures must not trip a breaker meant for three in a row.
    expect(requests.every((request) => !JSON.stringify(request.messages).includes('安全熔断'))).toBe(true)
  })

  it('compacts and retries a reasoning-only turn without exposing deliberation', async () => {
    // Reproduces the ledger from the drawio run: the turn came back with
    // text:"", toolCalls:[], outputTokens:8192, stopReason:"max_tokens". The
    // old code ended it as run.exhausted/max_tokens, which said nothing useful.
    let calls = 0
    const systems: string[] = []
    const privateReasoning = '思考架构分层'.repeat(50)
    const provider: ModelProvider = {
      ...makeMockProvider([]),
      async *stream(request): AsyncGenerator<CompletionChunk> {
        calls++
        systems.push(request.system ?? '')
        yield { type: 'message_start' }
        yield { type: 'reasoning_delta', delta: privateReasoning }
        yield {
          type: 'message_end',
          usage: { inputTokens: 17_079, outputTokens: 8_192, totalTokens: 25_271 },
          stopReason: 'max_tokens',
        }
      },
    }

    const events: QueryEvent[] = []
    for await (const event of runQuery(makeCtx(provider, []))) events.push(event)

    // The engine retries once with compact input. Reasoning is represented only
    // by aggregate progress and never enters the answer/event payload.
    expect(calls).toBe(2)
    expect(systems[0]).not.toContain('previous model turn')
    expect(systems[1]).toContain('previous model turn')
    expect(events.some((event) => event.type === 'message.delta')).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({ type: 'model.progress', phase: 'reasoning' }))
    expect(JSON.stringify(events)).not.toContain(privateReasoning)
    expect(events.at(-1)).toMatchObject({
      type: 'run.exhausted',
      reason: 'max_output_tokens',
    })
  })

  it('still continues a truncated turn that produced real text alongside reasoning', async () => {
    let call = 0
    const provider: ModelProvider = {
      ...makeMockProvider([]),
      async *stream(): AsyncGenerator<CompletionChunk> {
        call++
        yield { type: 'message_start' }
        if (call === 1) {
          yield { type: 'reasoning_delta', delta: '先想一下' }
          yield { type: 'content_delta', delta: '前半段' }
          yield { type: 'message_end', stopReason: 'max_tokens' }
          return
        }
        yield { type: 'content_delta', delta: '后半段' }
        yield { type: 'message_end', stopReason: 'end_turn' }
      },
    }

    const events: QueryEvent[] = []
    for await (const event of runQuery(makeCtx(provider, []))) events.push(event)

    // Reasoning next to real text must not block the existing continuation.
    expect(call).toBe(2)
    expect(events.at(-1)?.type).toBe('run.completed')
  })
})
