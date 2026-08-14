import { describe, expect, it } from 'vitest'
import { prepareCall } from '../executor'
import { sessionGrantKey, hardGuard } from '@/lib/harness/builtin-hooks'
import type { Tool, ToolCall } from '../types'
import type { QueryContext } from '@/lib/engine/types'

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'probe',
    description: 'probe',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    readOnly: true, concurrencySafe: true, destructive: false, requiresConfirmation: false,
    availability: 'always', permissions: ['fs:read'],
    execute: async () => ({ success: true, content: 'ok' }),
    renderCall: () => 'probe',
    ...overrides,
  } as Tool
}

function call(input: unknown, name = 'probe'): ToolCall {
  return { id: 'c1', name, input: input as Record<string, unknown> }
}

function prepare(t: Tool, input: unknown) {
  return prepareCall(call(input), [t], 'tauri')
}

describe('schema validation reaches nested and untyped nodes', () => {
  it('enforces required inside a node that omits an explicit type', () => {
    const nested = tool({
      inputSchema: {
        type: 'object',
        properties: { opts: { properties: { must: { type: 'string' } }, required: ['must'] } },
        required: ['opts'],
      },
    })
    expect(prepare(nested, { opts: {} }).ok).toBe(false)
    expect(prepare(nested, { opts: { must: 'x' } }).ok).toBe(true)
  })

  it('rejects fractional values for integer parameters', () => {
    const t = tool({
      inputSchema: { type: 'object', properties: { offset: { type: 'integer', minimum: 0 } }, required: ['offset'] },
    })
    expect(prepare(t, { offset: 3.7 }).ok).toBe(false)
    expect(prepare(t, { offset: 3 }).ok).toBe(true)
  })

  it('does not satisfy required from the prototype chain', () => {
    const t = tool({ inputSchema: { type: 'object', properties: {}, required: ['toString'] } })
    expect(prepare(t, {}).ok).toBe(false)
  })

  it('honours additionalProperties: false', () => {
    const t = tool({
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    })
    expect(prepare(t, { path: 'a', evil: 'b' }).ok).toBe(false)
    expect(prepare(t, { path: 'a' }).ok).toBe(true)
  })
})

describe('run-scoped approval grants stay as narrow as the prompt', () => {
  it('scopes a filesystem grant to the exact approved path', () => {
    const write = tool({ name: 'write_file', permissions: ['fs:write'], readOnly: false, destructive: true })
    const approved = sessionGrantKey(write, call({ path: '03-交付物/需求规格.md' }, 'write_file'))
    const other = sessionGrantKey(write, call({ path: '../../.zshrc' }, 'write_file'))
    expect(approved).not.toBe(other)
    expect(approved).toContain('03-交付物/需求规格.md')
  })

  it('still scopes network grants by domain', () => {
    const fetchTool = tool({ name: 'fetch', permissions: ['net:http'] })
    expect(sessionGrantKey(fetchTool, call({ url: 'https://example.com/a' }, 'fetch')))
      .toBe(sessionGrantKey(fetchTool, call({ url: 'https://example.com/b' }, 'fetch')))
  })
})

describe('the workspace hard guard is not tied to one parameter name', () => {
  const ctx = {
    platform: 'tauri',
    workspace: { root: '/ws', name: 'ws', resolve: (p: string) => p, contains: (p: string) => !p.startsWith('..') },
  } as unknown as QueryContext

  it('denies an escaping path supplied under an alternate key', () => {
    const move = tool({ name: 'move_file', permissions: ['fs:write'], readOnly: false })
    const decision = hardGuard(ctx, move, call({ source: 'a.md', destination: '../../etc/passwd' }, 'move_file'))
    expect(decision.kind).toBe('deny')
  })

  it('abstains when every supplied path is inside the workspace', () => {
    const move = tool({ name: 'move_file', permissions: ['fs:write'], readOnly: false })
    expect(hardGuard(ctx, move, call({ source: 'a.md', destination: 'b.md' }, 'move_file')).kind).toBe('abstain')
  })
})
