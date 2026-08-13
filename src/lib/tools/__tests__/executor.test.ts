/**
 * M1-14/15/16: Tool executor tests
 * validate → execute → normalize, concurrency plan, timeout & retry
 * @see docs/specs/tool-interface.md §4, §5
 */

import { describe, it, expect } from 'vitest'
import {
  validateInput,
  prepareCall,
  executeCall,
  canRunInParallel,
} from '../executor'
import type { ExecuteCallOptions } from '../executor'
import type { Tool, ToolCall, ToolResult, ToolUseContext } from '../types'
import type { MemoryState } from '../../memory/types'
import type { Settings, RunLogger } from '../../harness/types'

// ============================================================================
// Helpers
// ============================================================================

const noopLogger: RunLogger = {
  log: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: async () => {},
  entries: () => [],
}

function makeToolCtx(): ToolUseContext {
  return {
    runId: 'r1',
    cwd: '/ws',
    workspace: {
      root: '/ws',
      name: 'ws',
      resolve: (p) => `/ws/${p}`,
      contains: () => true,
    },
    memory: {} as MemoryState,
    settings: {} as Settings,
    permissions: new Map(),
    platform: 'tauri',
    logger: noopLogger,
  }
}

function makeTool(overrides: Partial<Tool>): Tool {
  return {
    name: 'test_tool',
    description: 'test',
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
    renderCall: () => 'test_tool',
    ...overrides,
  }
}

function makeOpts(overrides: Partial<ExecuteCallOptions> = {}): ExecuteCallOptions {
  return {
    ctx: makeToolCtx(),
    signal: new AbortController().signal,
    defaultTimeoutMs: 5000,
    ...overrides,
  }
}

const call = (name = 'test_tool', input: unknown = {}): ToolCall => ({
  id: 'c1',
  name,
  input,
})

// ============================================================================
// Step ③: validateInput
// ============================================================================

describe('validateInput (M1-14)', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      path: { type: 'string' as const, minLength: 1 },
      depth: { type: 'number' as const, minimum: 0, maximum: 10 },
      mode: { type: 'string' as const, enum: ['fast', 'full'] },
      tags: { type: 'array' as const, items: { type: 'string' as const } },
    },
    required: ['path'],
  }

  it('accepts valid input', () => {
    const r = validateInput({ path: 'a.md', depth: 2, mode: 'fast', tags: ['x'] }, schema)
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('rejects missing required parameter', () => {
    const r = validateInput({}, schema)
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain("missing required parameter 'path'")
  })

  it('rejects wrong types', () => {
    const r = validateInput({ path: 123 }, schema)
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('expected string, got number')
  })

  it('rejects enum violations', () => {
    const r = validateInput({ path: 'a', mode: 'turbo' }, schema)
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('must be one of')
  })

  it('rejects out-of-range numbers and bad array items', () => {
    const r = validateInput({ path: 'a', depth: 99, tags: [1] }, schema)
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('<= 10'))).toBe(true)
    expect(r.errors.some((e) => e.includes('$.tags[0]'))).toBe(true)
  })

  it('rejects non-object root when schema requires object', () => {
    const r = validateInput('not an object', schema)
    expect(r.ok).toBe(false)
  })
})

// ============================================================================
// Steps ①②③: prepareCall
// ============================================================================

describe('prepareCall (M1-14)', () => {
  it('① unknown tool → tombstone + available tools feedback', () => {
    const prep = prepareCall(call('missing_tool'), [makeTool({})], 'tauri')
    expect(prep.ok).toBe(false)
    if (!prep.ok) {
      expect(prep.tombstone?.reason).toBe('unknown_tool')
      expect(prep.result.content).toContain('test_tool') // lists available
      expect(prep.result.error?.recoverable).toBe(true)
    }
  })

  it('② tauri-only tool on web → permission_denied, no tombstone', () => {
    const tool = makeTool({ availability: 'tauri-only' })
    const prep = prepareCall(call(), [tool], 'web')
    expect(prep.ok).toBe(false)
    if (!prep.ok) {
      expect(prep.tombstone).toBeUndefined()
      expect(prep.result.error?.kind).toBe('permission_denied')
    }
  })

  it('② availability check skipped when platform unknown', () => {
    const tool = makeTool({ availability: 'tauri-only' })
    const prep = prepareCall(call(), [tool])
    expect(prep.ok).toBe(true)
  })

  it('③ invalid input → tombstone + validation errors feedback', () => {
    const tool = makeTool({
      inputSchema: { type: 'object', required: ['path'] },
    })
    const prep = prepareCall(call('test_tool', {}), [tool], 'tauri')
    expect(prep.ok).toBe(false)
    if (!prep.ok) {
      expect(prep.tombstone?.reason).toBe('invalid_tool_args')
      expect(prep.result.content).toContain('path')
    }
  })

  it('valid call passes through', () => {
    const prep = prepareCall(call(), [makeTool({})], 'tauri')
    expect(prep.ok).toBe(true)
  })
})

// ============================================================================
// Steps ⑥⑦: executeCall — timeout, retry, abort, normalization (M1-16)
// ============================================================================

describe('executeCall (M1-14/16)', () => {
  it('executes and fills durationMs', async () => {
    const result = await executeCall(makeTool({}), call(), makeOpts())
    expect(result.success).toBe(true)
    expect(result.content).toBe('ok')
    expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('times out tools that hang, even if they ignore the signal', async () => {
    const tool = makeTool({
      timeoutMs: 30,
      async execute() {
        return new Promise<ToolResult>(() => {}) // never settles
      },
    })
    const result = await executeCall(tool, call(), makeOpts())
    expect(result.success).toBe(false)
    expect(result.error?.kind).toBe('timeout')
    expect(result.error?.recoverable).toBe(true)
    expect(result.content).toContain('30ms')
  })

  it('external abort → kind aborted, not timeout', async () => {
    const controller = new AbortController()
    const tool = makeTool({
      timeoutMs: 5000,
      async execute() {
        return new Promise<ToolResult>(() => {}) // hangs until aborted
      },
    })
    setTimeout(() => controller.abort(), 20)
    const result = await executeCall(tool, call(), makeOpts({ signal: controller.signal }))
    expect(result.error?.kind).toBe('aborted')
  })

  it('retries transient failures per declared policy', async () => {
    let attempts = 0
    const tool = makeTool({
      retry: { maxAttempts: 3, backoffMs: 1 },
      async execute(): Promise<ToolResult> {
        attempts++
        if (attempts < 3) {
          return {
            success: false,
            content: 'flaky',
            error: { kind: 'runtime', message: 'flaky', recoverable: true },
          }
        }
        return { success: true, content: 'recovered' }
      },
    })
    const result = await executeCall(tool, call(), makeOpts())
    expect(attempts).toBe(3)
    expect(result.success).toBe(true)
    expect(result.content).toBe('recovered')
  })

  it('does not retry non-transient failures', async () => {
    let attempts = 0
    const tool = makeTool({
      retry: { maxAttempts: 3, backoffMs: 1 },
      async execute(): Promise<ToolResult> {
        attempts++
        return {
          success: false,
          content: 'bad input',
          error: { kind: 'invalid_input', message: 'bad', recoverable: true },
        }
      },
    })
    const result = await executeCall(tool, call(), makeOpts())
    expect(attempts).toBe(1)
    expect(result.success).toBe(false)
  })

  it('retries thrown exceptions and reports runtime error when exhausted', async () => {
    let attempts = 0
    const tool = makeTool({
      retry: { maxAttempts: 2, backoffMs: 1 },
      async execute(): Promise<ToolResult> {
        attempts++
        throw new Error('boom')
      },
    })
    const result = await executeCall(tool, call(), makeOpts())
    expect(attempts).toBe(2)
    expect(result.success).toBe(false)
    expect(result.error?.kind).toBe('runtime')
    expect(result.content).toContain('boom')
  })

  it('⑦ handleizes oversized content and sets truncated', async () => {
    const tool = makeTool({
      async execute(): Promise<ToolResult> {
        return { success: true, content: 'x'.repeat(10_000) }
      },
    })
    const result = await executeCall(tool, call(), makeOpts())
    expect(result.truncated).toBe(true)
    expect(result.content.length).toBeLessThan(10_000)
  })
})

// ============================================================================
// M1-15: canRunInParallel (spec §5)
// ============================================================================

describe('canRunInParallel (M1-15)', () => {
  const roTool = makeTool({ name: 'ro', readOnly: true, concurrencySafe: true })
  const writeTool = makeTool({ name: 'w', readOnly: false, concurrencySafe: false })
  const tools = [roTool, writeTool]

  it('parallel when every call is readOnly && concurrencySafe', () => {
    const calls = [call('ro'), { ...call('ro'), id: 'c2' }]
    expect(canRunInParallel(calls, tools)).toBe(true)
  })

  it('serial when any call is a write tool', () => {
    const calls = [call('ro'), { ...call('w'), id: 'c2' }]
    expect(canRunInParallel(calls, tools)).toBe(false)
  })

  it('single call is not parallel', () => {
    expect(canRunInParallel([call('ro')], tools)).toBe(false)
  })

  it('unknown tool disables parallel', () => {
    const calls = [call('ro'), { ...call('missing'), id: 'c2' }]
    expect(canRunInParallel(calls, tools)).toBe(false)
  })
})
