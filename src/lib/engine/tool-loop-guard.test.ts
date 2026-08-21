import { describe, expect, it } from 'vitest'
import { ToolLoopGuard, resultSignature, stableStringify } from './tool-loop-guard'
import type { QueryContext } from './types'
import type { Tool, ToolResult } from '../tools/types'
import { ProviderRegistry } from '../model'
import { InMemoryState } from '../memory'

function makeTool(name: string, key = name): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    readOnly: true,
    concurrencySafe: true,
    destructive: false,
    requiresConfirmation: false,
    availability: 'always',
    permissions: [],
    loopGroup: 'attachment-retrieval',
    loopKey: key,
    replaySafe: true,
    async execute(): Promise<ToolResult> {
      return { success: true, content: 'result' }
    },
    renderCall: () => name,
  }
}

function makeContext(): QueryContext {
  return {
    runId: 'loop-guard',
    conversationId: 'loop-guard-conversation',
    cwd: '/',
    messages: [{ role: 'user', content: 'read attachment' }],
    tools: [],
    memory: new InMemoryState(),
    model: { provider: 'mock', model: 'mock' },
    limits: {
      maxTurns: 10,
      maxTokens: 100_000,
      maxOutputTokens: 1_000,
      maxToolCalls: 20,
      toolTimeoutMs: 1_000,
      toolLoopBudgets: {
        'attachment-retrieval': { maxCalls: 5, softThreshold: 3, hardThreshold: 5 },
        'attachment-retrieval:search': { maxCalls: 3, softThreshold: 3, hardThreshold: 5 },
        'attachment-retrieval:read': { maxCalls: 4, softThreshold: 3, hardThreshold: 5 },
      },
    },
    signal: new AbortController().signal,
    providerRegistry: new ProviderRegistry(),
  }
}

describe('ToolLoopGuard', () => {
  /**
   * capture_preview succeeds or fails on render state, not on arguments, so a
   * repeat of the same call can never produce a new answer. The budget allows
   * exactly one retarget before closing the group.
   */
  it('closes artifact capture on a repeat but still allows one retarget', () => {
    const context = makeContext()
    const guard = new ToolLoopGuard({
      ...context,
      limits: {
        ...context.limits,
        toolLoopBudgets: {
          ...context.limits.toolLoopBudgets,
          'artifact-capture': { maxCalls: 2, softThreshold: 2, hardThreshold: 2 },
        },
      },
    })
    const tool: Tool = { ...makeTool('capture_preview'), loopGroup: 'artifact-capture', loopKey: undefined, replaySafe: false }
    const miss = { success: false, content: '当前没有已渲染的 artifact 预览' }
    const first = { id: '1', name: 'capture_preview', input: {} }

    expect(guard.inspect(first, tool)).toEqual({ kind: 'allow' })
    guard.observe(first, tool, miss)

    // A different target is a genuinely new question, so it still runs.
    const retarget = { id: '2', name: 'capture_preview', input: { page_index: 1 } }
    expect(guard.inspect(retarget, tool)).toEqual({ kind: 'allow' })
    guard.observe(retarget, tool, miss)

    // Budget spent: no further capture attempt reaches the DOM.
    expect(guard.inspect({ id: '3', name: 'capture_preview', input: {} }, tool)).toMatchObject({ kind: 'close' })
    expect(guard.isClosed('artifact-capture')).toBe(true)
  })

  it('spends a keyless tool budget once per call, not twice', () => {
    const context = makeContext()
    const guard = new ToolLoopGuard({
      ...context,
      limits: {
        ...context.limits,
        toolLoopBudgets: { ...context.limits.toolLoopBudgets, keyless: { maxCalls: 3, softThreshold: 9, hardThreshold: 9 } },
      },
    })
    const tool: Tool = { ...makeTool('probe'), loopGroup: 'keyless', loopKey: undefined, replaySafe: false }
    const result = { success: true, content: 'result' }

    // Without a loopKey the group is its own budget key; a single call must
    // not consume two slots of maxCalls.
    for (const id of ['1', '2', '3']) {
      const call = { id, name: 'probe', input: { seq: id } }
      expect(guard.inspect(call, tool)).toEqual({ kind: 'allow' })
      guard.observe(call, tool, { ...result, content: `result-${id}` })
    }
    expect(guard.inspect({ id: '4', name: 'probe', input: { seq: '4' } }, tool)).toMatchObject({ kind: 'close' })
  })

  it('canonicalizes object key order and result signatures deterministically', () => {
    expect(stableStringify({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}')
    expect(resultSignature('same')).toBe(resultSignature('same'))
    expect(resultSignature('same')).not.toBe(resultSignature('different'))
  })

  it('replays safe duplicate reads and then closes the no-progress loop', () => {
    const guard = new ToolLoopGuard(makeContext())
    const tool = makeTool('read_attachment', 'read')
    const call = { id: '1', name: 'read_attachment', input: { attachmentId: 'a', offset: 0, limit: 100 } }
    const result = { success: true, content: 'same attachment section' }

    expect(guard.inspect(call, tool)).toEqual({ kind: 'allow' })
    guard.observe(call, tool, result)
    expect(guard.inspect({ ...call, id: '2' }, tool)).toEqual({ kind: 'allow' })
    guard.observe({ ...call, id: '2' }, tool, result)
    expect(guard.inspect({ ...call, id: '3' }, tool)).toMatchObject({ kind: 'replay' })
    guard.observe({ ...call, id: '3' }, tool, result)
    expect(guard.inspect({ ...call, id: '4' }, tool)).toMatchObject({ kind: 'replay' })
    guard.observe({ ...call, id: '4' }, tool, result)
    expect(guard.inspect({ ...call, id: '5' }, tool)).toMatchObject({ kind: 'close' })
    expect(guard.isClosed('attachment-retrieval')).toBe(true)
  })

  it('does not classify changing pages as a loop', () => {
    const guard = new ToolLoopGuard(makeContext())
    const tool = makeTool('read_attachment', 'read')
    const call = (offset: number, id: string) => ({ id, name: 'read_attachment', input: { attachmentId: 'a', offset, limit: 100 } })
    const first = call(0, '1')
    const second = call(100, '2')
    const third = call(200, '3')
    expect(guard.inspect(first, tool)).toEqual({ kind: 'allow' })
    guard.observe(first, tool, { success: true, content: 'page 1' })
    expect(guard.inspect(second, tool)).toEqual({ kind: 'allow' })
    guard.observe(second, tool, { success: true, content: 'page 2' })
    expect(guard.inspect(third, tool)).toEqual({ kind: 'allow' })
  })

  it('closes a per-tool budget before the global group budget', () => {
    const guard = new ToolLoopGuard(makeContext())
    const tool = makeTool('search_attachments', 'search')
    for (let index = 0; index < 3; index++) {
      const call = { id: String(index), name: tool.name, input: { query: `q-${index}` } }
      expect(guard.inspect(call, tool)).toEqual({ kind: 'allow' })
      guard.observe(call, tool, { success: true, content: `hit-${index}` })
    }
    expect(guard.inspect({ id: '4', name: tool.name, input: { query: 'q-4' } }, tool)).toMatchObject({ kind: 'close' })
  })

  it('closes semantic no-progress when the model changes queries but evidence is unchanged', () => {
    const guard = new ToolLoopGuard(makeContext())
    const tool = makeTool('search_attachments', 'varied')
    for (let index = 0; index < 5; index++) {
      const call = { id: String(index), name: tool.name, input: { query: `different query ${index}` } }
      expect(guard.inspect(call, tool)).toEqual({ kind: 'allow' })
      guard.observe(call, tool, { success: true, content: 'the same single search hit' })
    }
    expect(guard.isClosed('attachment-retrieval')).toBe(true)
    expect(guard.inspect({ id: '6', name: tool.name, input: { query: 'one more query' } }, tool)).toMatchObject({ kind: 'close' })
  })

  it('detects a result-stable A-B-A-B ping-pong before the group budget is exhausted', () => {
    const guard = new ToolLoopGuard(makeContext())
    const tool = makeTool('search_attachments', 'ping-pong')
    const call = (query: string, id: string) => ({ id, name: tool.name, input: { query } })
    const result = { success: true, content: 'same result for both strategies' }
    const a1 = call('architecture', 'a1')
    const b1 = call('technical-route', 'b1')
    const a2 = call('architecture', 'a2')
    const b2 = call('technical-route', 'b2')

    expect(guard.inspect(a1, tool)).toEqual({ kind: 'allow' })
    guard.observe(a1, tool, result)
    expect(guard.inspect(b1, tool)).toEqual({ kind: 'allow' })
    guard.observe(b1, tool, result)
    expect(guard.inspect(a2, tool)).toEqual({ kind: 'allow' })
    guard.observe(a2, tool, result)
    // Each strategy repeats after the other one; the cached result hash makes
    // the no-progress ping-pong clear without waiting for the global budget.
    expect(guard.inspect(b2, tool)).toMatchObject({ kind: 'close' })
  })
})
