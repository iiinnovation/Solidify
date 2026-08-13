/**
 * M1-14/15: Loop ↔ executor integration
 * Real execution through the loop, parallel path, mixed tombstone batch
 */

import { describe, it, expect } from 'vitest'
import { runQuery } from '../query'
import type { QueryContext, QueryEvent } from '../types'
import { ProviderRegistry } from '../../model'
import type { ModelProvider } from '../../model'
import type { CompletionChunk, CompletionRequest } from '../../model/types'
import type { Tool, ToolResult } from '../../tools/types'
import type { MemoryState } from '../../memory/types'

function makeMockProvider(script: CompletionChunk[][]): ModelProvider {
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
    async *stream(_request: CompletionRequest): AsyncGenerator<CompletionChunk> {
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
    expect(unknown.result.content).toContain('reader') // lists available tools

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
})
