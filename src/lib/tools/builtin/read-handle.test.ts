import { describe, expect, it } from 'vitest'
import { InMemoryState } from '@/lib/memory'
import type { ToolUseContext } from '../types'
import { readHandleTool } from './read-handle'

function context(memory: InMemoryState, messages?: readonly unknown[]): ToolUseContext {
  return {
    runId: 'read-handle-test',
    cwd: '/workspace',
    workspace: {
      root: '/workspace',
      name: 'workspace',
      resolve: (path) => `/workspace/${path}`,
      contains: () => true,
    },
    memory,
    settings: {} as ToolUseContext['settings'],
    permissions: new Map(),
    platform: 'web',
    logger: {
      log: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      flush: async () => {},
      entries: () => [],
    },
    messages,
  }
}

describe('read_handle', () => {
  it('reuses a handle when the same result is assembled more than once', async () => {
    const memory = new InMemoryState()
    expect(await memory.store('same result')).toBe(await memory.store('same result'))
  })

  it('reads Unicode content in bounded chunks with a stable nextOffset', async () => {
    const memory = new InMemoryState()
    const handle = await memory.store('甲乙丙丁')
    const ctx = context(memory)
    const signal = new AbortController().signal

    const first = await readHandleTool.execute({ handle, limit: 2 }, ctx, signal)
    expect(first.content).toBe('甲乙')
    expect(first.data).toEqual({ handle, offset: 0, nextOffset: 2, total: 4 })

    const second = await readHandleTool.execute({ handle, offset: 2, limit: 2 }, ctx, signal)
    expect(second.content).toBe('丙丁')
    expect(second.data).toEqual({ handle, offset: 2, nextOffset: undefined, total: 4 })
  })

  it('returns a recoverable not_found error for an expired handle', async () => {
    const memory = new InMemoryState()
    const result = await readHandleTool.execute(
      { handle: 'missing' },
      context(memory),
      new AbortController().signal,
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatchObject({ kind: 'not_found', recoverable: true })
  })

  it('repairs a tool-name placeholder using the most recent stored result', async () => {
    const memory = new InMemoryState()
    const handle = await memory.store('large PPT source')
    const result = await readHandleTool.execute(
      { handle: 'read_handle' },
      context(memory, [{
        role: 'user',
        content: [{ type: 'tool_result', content: `Result stored as ${handle}: use read_handle to retrieve it.` }],
      }]),
      new AbortController().signal,
    )

    expect(result.success).toBe(true)
    expect(result.content).toBe('large PPT source')
    expect(result.data).toMatchObject({ handle })
  })

  it('explains how to recover when a placeholder has no matching result', async () => {
    const result = await readHandleTool.execute(
      { handle: 'read_handle' },
      context(new InMemoryState()),
      new AbortController().signal,
    )

    expect(result.error).toMatchObject({ kind: 'invalid_input', recoverable: true })
    expect(result.content).toContain('实际句柄')
  })

  it('keeps multibyte chunks below the handleization byte threshold', async () => {
    const memory = new InMemoryState()
    const handle = await memory.store('甲'.repeat(9000))
    const result = await readHandleTool.execute(
      { handle },
      context(memory),
      new AbortController().signal,
    )

    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(24_000)
    expect(result.data).toMatchObject({ offset: 0, nextOffset: 8000, total: 9000 })
  })
})
