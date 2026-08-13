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

// ============================================================================
// Helpers
// ============================================================================

function makeSnapshot(turn: number): TurnSnapshot {
  return {
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
    const resumed: QueryContext = { ...resumedCtx, messages: latest!.messages }

    const events = []
    for await (const ev of runQuery(resumed)) events.push(ev)

    expect(events.some((e) => e.type === 'message.completed')).toBe(true)
    expect(events[events.length - 1].type).toBe('run.completed')
  })
})
