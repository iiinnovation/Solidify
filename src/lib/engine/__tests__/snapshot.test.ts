/**
 * M1-13: Session snapshot & restore tests
 * @see docs/specs/agent-loop.md §4
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  serializeSnapshot,
  parseSnapshotLine,
  readLatestSnapshot,
  LocalStorageSnapshotStore,
} from '../snapshot'
import { runQuery } from '../query'
import type { QueryContext, TurnSnapshot, SnapshotStore } from '../types'
import { ProviderRegistry } from '../../model'
import type { ModelProvider } from '../../model'
import type { CompletionChunk, CompletionRequest } from '../../model/types'
import type { Tool, ToolResult } from '../../tools/types'
import type { MemoryState } from '../../memory/types'
import { InMemoryState } from '../../memory'
import { readHandleTool } from '../../tools/builtin/read-handle'

// ============================================================================
// Helpers
// ============================================================================

function makeSnapshot(turn: number): TurnSnapshot {
  return {
    runId: 'test-run',
    turn,
    messages: [{ role: 'user', content: `turn ${turn}` }],
    usage: {
      inputTokens: 10 * turn,
      outputTokens: 5 * turn,
      totalTokens: 15 * turn,
      turns: turn,
      toolCalls: 0,
    },
    ts: '2026-08-13T00:00:00.000Z',
  }
}

// ============================================================================
// Serialization
// ============================================================================

describe('snapshot serialization (M1-13)', () => {
  it('roundtrips through serialize → parse', () => {
    const snapshot = makeSnapshot(3)
    const line = serializeSnapshot(snapshot)
    expect(line).not.toContain('\n')
    expect(parseSnapshotLine(line)).toEqual(snapshot)
  })

  it('rejects corrupt and shape-invalid lines', () => {
    expect(parseSnapshotLine('{"turn":1,"messages"')).toBeNull() // torn write
    expect(parseSnapshotLine('not json')).toBeNull()
    expect(parseSnapshotLine('{"foo":1}')).toBeNull() // wrong shape
    expect(parseSnapshotLine('{"turn":"x","messages":[],"ts":"t"}')).toBeNull()
  })

  it('readLatestSnapshot returns the last valid line', () => {
    const content =
      serializeSnapshot(makeSnapshot(1)) + '\n' +
      serializeSnapshot(makeSnapshot(2)) + '\n'
    expect(readLatestSnapshot(content)?.turn).toBe(2)
  })

  it('readLatestSnapshot skips a torn trailing line', () => {
    const content =
      serializeSnapshot(makeSnapshot(1)) + '\n' +
      '{"turn":2,"messa' // crash mid-write
    expect(readLatestSnapshot(content)?.turn).toBe(1)
  })

  it('readLatestSnapshot returns null for empty content', () => {
    expect(readLatestSnapshot('')).toBeNull()
    expect(readLatestSnapshot('\n\n')).toBeNull()
  })
})

// ============================================================================
// LocalStorage store
// ============================================================================

describe('LocalStorageSnapshotStore (M1-13)', () => {
  let store: LocalStorageSnapshotStore

  beforeEach(() => {
    localStorage.clear()
    store = new LocalStorageSnapshotStore()
  })

  it('appends and loads the latest snapshot', async () => {
    await store.append('conv-1', makeSnapshot(1))
    await store.append('conv-1', makeSnapshot(2))

    const latest = await store.loadLatest('conv-1')
    expect(latest?.turn).toBe(2)
  })

  it('isolates conversations', async () => {
    await store.append('conv-a', makeSnapshot(1))
    await store.append('conv-b', makeSnapshot(9))

    expect((await store.loadLatest('conv-a'))?.turn).toBe(1)
    expect((await store.loadLatest('conv-b'))?.turn).toBe(9)
  })

  it('returns null when nothing stored', async () => {
    expect(await store.loadLatest('missing')).toBeNull()
  })

  it('clear removes the conversation history', async () => {
    await store.append('conv-1', makeSnapshot(1))
    await store.clear('conv-1')
    expect(await store.loadLatest('conv-1')).toBeNull()
  })

  it('trims history to the cap to respect quota', async () => {
    for (let i = 1; i <= 30; i++) {
      await store.append('conv-1', makeSnapshot(i))
    }
    const raw = localStorage.getItem('solidify:snapshots:conv-1') ?? ''
    const lineCount = raw.split('\n').filter(Boolean).length
    expect(lineCount).toBeLessThanOrEqual(20)
    // Latest is still the newest
    expect((await store.loadLatest('conv-1'))?.turn).toBe(30)
  })

  it('sanitizes path-unsafe conversation ids', async () => {
    await store.append('../evil/../../id', makeSnapshot(7))
    expect((await store.loadLatest('../evil/../../id'))?.turn).toBe(7)
    // Key contains no path separators
    const keys = Object.keys(localStorage)
    expect(keys.some((k) => k.includes('/') || k.includes('..'))).toBe(false)
  })
})

// ============================================================================
// Loop integration: snapshot written after each tool turn
// ============================================================================

const echoTool: Tool = {
  name: 'echo',
  description: 'Echo input back',
  inputSchema: { type: 'object' },
  readOnly: true,
  concurrencySafe: true,
  destructive: false,
  requiresConfirmation: false,
  availability: 'always',
  permissions: [],
  async execute(): Promise<ToolResult> {
    return { success: true, content: 'ok' }
  },
  renderCall: () => 'echo',
}

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

class RecordingSnapshotStore implements SnapshotStore {
  appended: Array<{ conversationId: string; snapshot: TurnSnapshot }> = []
  failNext = false

  async append(conversationId: string, snapshot: TurnSnapshot): Promise<void> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('disk full')
    }
    this.appended.push({ conversationId, snapshot })
  }

  async loadLatest(): Promise<TurnSnapshot | null> {
    return this.appended.length > 0
      ? this.appended[this.appended.length - 1].snapshot
      : null
  }

  async clear(): Promise<void> {
    this.appended = []
  }
}

function makeCtx(
  provider: ModelProvider,
  snapshots: SnapshotStore,
): QueryContext {
  const registry = new ProviderRegistry()
  registry.register('mock', provider)

  return {
    runId: 'test-run',
    conversationId: 'conv-snap',
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
    signal: new AbortController().signal,
    providerRegistry: registry,
    snapshots,
  }
}

const toolTurn: CompletionChunk[] = [
  { type: 'tool_call_start', id: 't1', name: 'echo' },
  { type: 'tool_call_end', id: 't1', input: { value: 1 } },
  {
    type: 'message_end',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    stopReason: 'tool_use',
  },
]

const finalTurn: CompletionChunk[] = [
  { type: 'content_delta', delta: 'done' },
  {
    type: 'message_end',
    usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
    stopReason: 'end_turn',
  },
]

describe('runQuery snapshot integration (M1-13)', () => {
  it('writes one snapshot per tool turn with full history', async () => {
    const store = new RecordingSnapshotStore()
    const ctx = makeCtx(makeMockProvider([toolTurn, finalTurn]), store)

    const events = []
    for await (const ev of runQuery(ctx)) events.push(ev)

    // One tool turn → one snapshot (final text turn ends the run, no snapshot)
    expect(store.appended).toHaveLength(1)
    const { conversationId, snapshot } = store.appended[0]
    expect(conversationId).toBe('conv-snap')
    expect(snapshot.turn).toBe(1)
    expect(snapshot.ts).toBeTruthy()

    // Snapshot history includes user msg + assistant tool_use + tool_result
    expect(snapshot.messages).toHaveLength(3)
    const assistant = snapshot.messages[1]
    expect(assistant.role).toBe('assistant')
    const toolResults = snapshot.messages[2]
    expect(toolResults.role).toBe('user')

    // Run still completed
    expect(events[events.length - 1].type).toBe('run.completed')
  })

  it('clears a previous run snapshot before starting a fresh run', async () => {
    const store = new RecordingSnapshotStore()
    await store.append('conv-snap', {
      runId: 'previous-run',
      turn: 4,
      messages: [{ role: 'user', content: 'previous run' }],
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, turns: 4, toolCalls: 2 },
      ts: new Date().toISOString(),
    })

    const ctx = makeCtx(makeMockProvider([toolTurn, finalTurn]), store)
    for await (const _ of runQuery(ctx)) { /* consume */ }

    expect(store.appended).toHaveLength(1)
    expect(JSON.stringify(store.appended[0].snapshot.messages)).not.toContain('previous run')
    expect(store.appended[0].snapshot.turn).toBe(1)
  })

  it('snapshot failure does not kill the run', async () => {
    const store = new RecordingSnapshotStore()
    store.failNext = true
    const ctx = makeCtx(makeMockProvider([toolTurn, finalTurn]), store)

    const events = []
    for await (const ev of runQuery(ctx)) events.push(ev)

    expect(events.some((e) => e.type === 'run.failed')).toBe(false)
    expect(events[events.length - 1].type).toBe('run.completed')
  })

  it('resume from snapshot continues with restored messages', async () => {
    const store = new RecordingSnapshotStore()
    const ctx = makeCtx(makeMockProvider([toolTurn, finalTurn]), store)

    for await (const _ of runQuery(ctx)) { /* run to completion */ }

    // Simulate app restart: rebuild ctx from latest snapshot
    const latest = await store.loadLatest()
    expect(latest).not.toBeNull()

    const resumedCtx = makeCtx(makeMockProvider([finalTurn]), store)
    const resumed: QueryContext = {
      ...resumedCtx,
      messages: [{ role: 'user', content: 'stale context must not win' }],
      restoreSnapshot: true,
    }

    const events = []
    for await (const ev of runQuery(resumed)) events.push(ev)

    expect(events.some((e) => e.type === 'message.completed')).toBe(true)
    expect(events[events.length - 1].type).toBe('run.completed')
    expect(store.appended).toHaveLength(0)
  })

  it('feeds an expired in-memory handle back and re-runs the source tool after restart', async () => {
    const requests: CompletionRequest[] = []
    const provider = makeMockProvider([
      [
        { type: 'tool_call_start', id: 'read-old-handle', name: 'read_handle' },
        { type: 'tool_call_end', id: 'read-old-handle', input: { handle: 'handle-1' } },
        { type: 'message_end', stopReason: 'tool_use' },
      ],
      [
        { type: 'tool_call_start', id: 'rerun-source', name: 'read_source' },
        { type: 'tool_call_end', id: 'rerun-source', input: { path: 'large.txt' } },
        { type: 'message_end', stopReason: 'tool_use' },
      ],
      finalTurn,
    ])
    const originalStream = provider.stream.bind(provider)
    provider.stream = async function* (request) {
      requests.push(request)
      yield* originalStream(request)
    }

    let sourceReads = 0
    const sourceTool: Tool = {
      name: 'read_source',
      description: 'Read the original source again when cached content is unavailable',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      readOnly: true,
      concurrencySafe: true,
      destructive: false,
      requiresConfirmation: false,
      availability: 'always',
      permissions: [],
      async execute(input): Promise<ToolResult> {
        const { path } = input as { path: string }
        sourceReads++
        return { success: true, content: `fresh content from ${path}` }
      },
      renderCall: (input) => `read ${(input as { path: string }).path}`,
    }

    const store = new RecordingSnapshotStore()
    await store.append('conv-snap', {
      runId: 'test-run',
      turn: 1,
      messages: [
        { role: 'user', content: 'Read and summarize large.txt' },
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'original-source',
            name: 'read_source',
            input: { path: 'large.txt' },
          }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'original-source',
            content: 'Result stored as handle-1. Use read_handle to retrieve it.',
          }],
        },
      ],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, turns: 1, toolCalls: 1 },
      ts: new Date().toISOString(),
    })

    const events = []
    for await (const event of runQuery({
      ...makeCtx(provider, store),
      memory: new InMemoryState(),
      tools: [readHandleTool as Tool, sourceTool],
      restoreSnapshot: true,
    })) events.push(event)

    const completed = events.filter(
      (event) => event.type === 'tool.completed',
    )
    expect(completed[0]).toMatchObject({
      callId: 'read-old-handle',
      result: {
        success: false,
        error: { kind: 'not_found', recoverable: true },
      },
    })
    expect(JSON.stringify(requests[1].messages.at(-1))).toContain('句柄不存在或已过期')
    expect(sourceReads).toBe(1)
    expect(completed[1]).toMatchObject({
      callId: 'rerun-source',
      result: { success: true, content: 'fresh content from large.txt' },
    })
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  it('does not restore a stale snapshot for a normal new request', async () => {
    const requests: CompletionRequest[] = []
    const provider = makeMockProvider([finalTurn])
    const originalStream = provider.stream.bind(provider)
    provider.stream = async function* (request) {
      requests.push(request)
      yield* originalStream(request)
    }
    const store = new RecordingSnapshotStore()
    await store.append('conv-snap', {
      runId: 'previous-run',
      turn: 2,
      messages: [{ role: 'user', content: 'old snapshot' }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 2, toolCalls: 1 },
      ts: new Date().toISOString(),
    })

    const ctx = makeCtx(provider, store)
    for await (const _ of runQuery(ctx)) { /* consume */ }

    expect(JSON.stringify(requests[0].messages)).toContain('hi')
    expect(JSON.stringify(requests[0].messages)).not.toContain('old snapshot')
  })

  it('fails recovery without calling the model when no snapshot exists', async () => {
    const requests: CompletionRequest[] = []
    const provider = makeMockProvider([finalTurn])
    const originalStream = provider.stream.bind(provider)
    provider.stream = async function* (request) {
      requests.push(request)
      yield* originalStream(request)
    }
    const store = new RecordingSnapshotStore()
    const ctx = { ...makeCtx(provider, store), restoreSnapshot: true }

    const events = []
    for await (const event of runQuery(ctx)) events.push(event)

    expect(requests).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      error: { kind: 'internal', message: 'No recoverable Agent snapshot was found' },
    })
  })

  it('rejects a snapshot owned by another run', async () => {
    const requests: CompletionRequest[] = []
    const provider = makeMockProvider([finalTurn])
    const originalStream = provider.stream.bind(provider)
    provider.stream = async function* (request) {
      requests.push(request)
      yield* originalStream(request)
    }
    const store = new RecordingSnapshotStore()
    await store.append('conv-snap', {
      ...makeSnapshot(1),
      runId: 'different-run',
    })

    const events = []
    for await (const event of runQuery({
      ...makeCtx(provider, store),
      restoreSnapshot: true,
    })) events.push(event)

    expect(requests).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      error: { message: 'The recoverable Agent snapshot belongs to a different run' },
    })
  })
})
