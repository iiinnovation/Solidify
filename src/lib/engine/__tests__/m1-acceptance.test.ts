import { afterEach, describe, expect, it, vi } from 'vitest'
import { runQuery } from '../query'
import { ProviderRegistry } from '../../model'
import { InMemoryState } from '../../memory'
import type { QueryContext, QueryEvent } from '../types'
import type {
  CompletionChunk,
  CompletionRequest,
  ModelProvider,
} from '../../model'
import type { Tool, ToolResult } from '../../tools/types'

const finalTurn: CompletionChunk[] = [
  { type: 'content_delta', delta: 'done' },
  {
    type: 'message_end',
    usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
    stopReason: 'end_turn',
  },
]

function toolTurn(id: string, input: unknown = {}): CompletionChunk[] {
  return [
    { type: 'tool_call_start', id, name: 'inspect' },
    { type: 'tool_call_end', id, input },
    {
      type: 'message_end',
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      stopReason: 'tool_use',
    },
  ]
}

function scriptedProvider(
  script: CompletionChunk[][],
  options: { supportsTools?: boolean; requests?: CompletionRequest[] } = {},
): ModelProvider {
  let turn = 0
  return {
    name: 'mock',
    metadata: {
      name: 'mock',
      displayName: 'Mock',
      supportsVision: false,
      supportsTools: options.supportsTools ?? true,
      supportsStreaming: true,
      defaultMaxTokens: 4096,
      models: ['mock-model'],
    },
    async *stream(request) {
      options.requests?.push(request)
      const chunks = script[Math.min(turn++, script.length - 1)]
      for (const chunk of chunks) {
        if (request.signal?.aborted) throw new Error('request aborted')
        yield chunk
      }
    },
  }
}

function inspectTool(
  execute: Tool['execute'] = async () => ({ success: true, content: 'inspected' }),
): Tool {
  return {
    name: 'inspect',
    description: 'Inspect one item',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    readOnly: true,
    concurrencySafe: false,
    destructive: false,
    requiresConfirmation: false,
    availability: 'always',
    permissions: [],
    execute,
    renderCall: () => 'inspect',
  }
}

function makeContext(
  provider: ModelProvider,
  overrides: Partial<QueryContext> = {},
): QueryContext {
  const providerRegistry = new ProviderRegistry()
  providerRegistry.register('mock', provider)
  return {
    runId: 'm1-acceptance',
    conversationId: 'm1-conversation',
    cwd: '/workspace',
    messages: [{ role: 'user', content: 'inspect the workspace' }],
    tools: [inspectTool()],
    memory: new InMemoryState(),
    model: { provider: 'mock', model: 'mock-model' },
    limits: {
      maxTurns: 8,
      maxTokens: 100_000,
      maxOutputTokens: 1000,
      maxToolCalls: 20,
      toolTimeoutMs: 1000,
    },
    signal: new AbortController().signal,
    providerRegistry,
    ...overrides,
  }
}

async function collect(generator: AsyncGenerator<QueryEvent>): Promise<QueryEvent[]> {
  const events: QueryEvent[] = []
  for await (const event of generator) events.push(event)
  return events
}

afterEach(() => {
  vi.useRealTimers()
})

describe('M1-27 agent loop acceptance', () => {
  it('1. completes three consecutive tool calls in event order', async () => {
    const provider = scriptedProvider([
      toolTurn('call-1', { path: 'a' }),
      toolTurn('call-2', { path: 'b' }),
      toolTurn('call-3', { path: 'c' }),
      finalTurn,
    ])

    const events = await collect(runQuery(makeContext(provider)))
    const lifecycle = events
      .filter((event) => [
        'tool.requested',
        'tool.progress',
        'tool.completed',
      ].includes(event.type))
      .map((event) => event.type)

    expect(lifecycle).toEqual([
      'tool.requested', 'tool.progress', 'tool.completed',
      'tool.requested', 'tool.progress', 'tool.completed',
      'tool.requested', 'tool.progress', 'tool.completed',
    ])
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  it('2. tombstones malformed arguments, feeds validation back, and self-corrects', async () => {
    const requests: CompletionRequest[] = []
    const malformedTurn: CompletionChunk[] = [
      { type: 'tool_call_start', id: 'bad-call', name: 'inspect' },
      {
        type: 'error',
        error: {
          code: 'tool_input_parse_error',
          message: 'malformed JSON',
          type: 'unknown',
          retryable: false,
          kind: 'parse',
          recoverable: true,
        },
      },
      { type: 'tool_call_end', id: 'bad-call', input: null },
      { type: 'message_end', stopReason: 'tool_use' },
    ]
    const provider = scriptedProvider([
      malformedTurn,
      toolTurn('fixed-call', { path: 'fixed.txt' }),
      finalTurn,
    ], { requests })

    const events = await collect(runQuery(makeContext(provider)))
    const completed = events.filter(
      (event): event is Extract<QueryEvent, { type: 'tool.completed' }> =>
        event.type === 'tool.completed',
    )

    expect(events.some((event) => event.type === 'tombstone')).toBe(true)
    expect(completed[0].result.error?.kind).toBe('invalid_input')
    expect(completed[1].result.success).toBe(true)
    expect(JSON.stringify(requests[1].messages.at(-1))).toContain('expected object')
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  it('3. aborts during turn two while retaining completed tool results', async () => {
    const controller = new AbortController()
    const requests: CompletionRequest[] = []
    const provider = scriptedProvider([
      toolTurn('kept-call', { path: 'kept.txt' }),
      [
        { type: 'content_delta', delta: 'second turn started' },
        { type: 'content_delta', delta: 'must not be consumed' },
      ],
    ], { requests })
    const events: QueryEvent[] = []

    for await (const event of runQuery(makeContext(provider, { signal: controller.signal }))) {
      events.push(event)
      if (event.type === 'message.delta') controller.abort()
    }

    const completed = events.filter((event) => event.type === 'tool.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ callId: 'kept-call', result: { success: true } })
    expect(events.at(-1)).toMatchObject({ type: 'run.failed', error: { kind: 'aborted' } })
    expect(requests[1].signal?.aborted).toBe(true)
    expect(events.filter((event) => event.type === 'message.delta')).toHaveLength(1)
  })

  it('4. emits run.exhausted when maxTurns is reached', async () => {
    const provider = scriptedProvider([
      toolTurn('call-1', { path: 'a' }),
      toolTurn('call-2', { path: 'b' }),
    ])
    const context = makeContext(provider, {
      limits: {
        maxTurns: 2,
        maxTokens: 100_000,
        maxOutputTokens: 1000,
        maxToolCalls: 20,
        toolTimeoutMs: 1000,
      },
    })

    const events = await collect(runQuery(context))
    expect(events.at(-1)).toMatchObject({ type: 'run.exhausted', reason: 'max_turns' })
  })

  it('5. falls back to text-only for a provider without tools', async () => {
    const requests: CompletionRequest[] = []
    const provider = scriptedProvider([finalTurn], {
      supportsTools: false,
      requests,
    })

    const events = await collect(runQuery(makeContext(provider)))

    expect(requests[0].tools).toBeUndefined()
    expect(requests[0].system).not.toContain('# Available Tools')
    expect(requests[0].system).toContain('No tools are available')
    expect(requests[0].system).not.toContain('type="document"')
    expect(requests[0].system).toContain('type="ARTIFACT_TYPE"')
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  it('6. handleizes a 10MB result without expanding the next context', async () => {
    const fullContent = 'x'.repeat(10 * 1024 * 1024)
    const requests: CompletionRequest[] = []
    const memory = new InMemoryState()
    const provider = scriptedProvider([
      toolTurn('large-call', { path: 'large.txt' }),
      finalTurn,
    ], { requests })
    const tool = inspectTool(async (): Promise<ToolResult> => ({
      success: true,
      content: fullContent,
      data: { content: fullContent },
    }))

    const events = await collect(runQuery(makeContext(provider, {
      tools: [tool],
      memory,
    })))
    const completed = events.find(
      (event): event is Extract<QueryEvent, { type: 'tool.completed' }> =>
        event.type === 'tool.completed',
    )

    expect(completed?.result.truncated).toBe(true)
    expect(completed?.result.handle).toBeDefined()
    expect(completed?.result.data).toBeUndefined()
    expect(await memory.retrieve(completed!.result.handle!)).toBe(fullContent)
    expect(JSON.stringify(completed).length).toBeLessThan(20_000)
    const nextContext = JSON.stringify(requests[1].messages)
    expect(nextContext).toContain('Result stored as')
    expect(nextContext.length).toBeLessThan(20_000)
  })

  it('7. applies backpressure while the consumer pauses five seconds', async () => {
    vi.useFakeTimers()
    let produced = 0
    const provider: ModelProvider = {
      ...scriptedProvider([finalTurn]),
      async *stream() {
        for (let index = 0; index < 1000; index++) {
          produced++
          yield { type: 'content_delta', delta: String(index) }
        }
        yield { type: 'message_end', stopReason: 'end_turn' }
      },
    }
    const generator = runQuery(makeContext(provider))

    expect((await generator.next()).value).toMatchObject({ type: 'run.started' })
    expect((await generator.next()).value).toMatchObject({ type: 'message.delta' })
    expect(produced).toBe(1)

    await vi.advanceTimersByTimeAsync(5000)
    expect(produced).toBe(1)

    await generator.return(undefined)
  })
})
