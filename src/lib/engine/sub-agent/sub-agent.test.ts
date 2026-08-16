import { describe, expect, it, vi } from 'vitest'
import { InMemoryState } from '../../memory'
import { ProviderRegistry } from '../../model'
import type { PermissionMap } from '../../harness/types'
import type { Tool } from '../../tools/types'
import type { QueryContext, QueryEvent } from '../types'
import { SharedTaskTreeBudget } from './budget'
import { SubAgentScheduler } from './scheduler'
import { createSubAgentContext, dispatchSubAgents } from './spawn'
import { applyRoleDefaults, resolveSubAgentRole } from './roles'

function tool(name: string, readOnly: boolean): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    readOnly,
    concurrencySafe: readOnly,
    destructive: !readOnly,
    requiresConfirmation: !readOnly,
    availability: 'always',
    permissions: readOnly ? ['fs:read'] : ['fs:write'],
    execute: async () => ({ success: true, content: 'ok' }),
    renderCall: () => name,
  }
}

function parentContext(overrides: Partial<QueryContext> = {}): QueryContext {
  return {
    runId: 'root-run',
    conversationId: 'conversation',
    cwd: '/workspace',
    messages: [{ role: 'user', content: 'delegate' }],
    tools: [tool('read_file', true), tool('write_file', false), tool('dispatch_agent', false)],
    memory: new InMemoryState(),
    model: { provider: 'mock', model: 'root-model' },
    limits: {
      maxTurns: 10,
      maxTokens: 10_000,
      maxOutputTokens: 1000,
      maxToolCalls: 20,
      toolTimeoutMs: 1000,
    },
    signal: new AbortController().signal,
    providerRegistry: new ProviderRegistry(),
    ...overrides,
  }
}

describe('SharedTaskTreeBudget', () => {
  it('tracks usage by run and aborts the whole tree when exhausted', () => {
    const budget = new SharedTaskTreeBudget(10)

    expect(budget.consume('root', 4)).toBe(true)
    expect(budget.consume('child', 6)).toBe(true)
    expect(budget.consume('child', 1)).toBe(false)
    expect(budget.signal.aborted).toBe(true)
    expect(budget.abortReason).toBe('budget_exhausted')
    expect(budget.snapshot()).toMatchObject({
      limit: 10,
      used: 11,
      remaining: 0,
      exhausted: true,
      byRun: { root: 4, child: 7 },
    })
  })

  it('propagates parent cancellation', () => {
    const parent = new AbortController()
    const budget = new SharedTaskTreeBudget(10, parent.signal)
    parent.abort()
    expect(budget.signal.aborted).toBe(true)
    expect(budget.abortReason).toBe('parent_aborted')
  })
})

describe('SubAgentScheduler', () => {
  it('enforces concurrency and isolates worker failures', async () => {
    const scheduler = new SubAgentScheduler(2)
    let active = 0
    let peak = 0
    const settled = await scheduler.run([0, 1, 2, 3, 4], async (value) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active--
      if (value === 2) throw new Error('expected failure')
      return value * 2
    })

    expect(peak).toBe(2)
    expect(settled.map((entry) => entry.status)).toEqual([
      'fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled',
    ])
    expect(settled[4]).toEqual({ status: 'fulfilled', value: 8 })
  })
})

describe('sub-agent context and dispatch', () => {
  it('allows only a parent tool subset and removes recursive dispatch', () => {
    const parent = parentContext()
    const child = createSubAgentContext(parent, {
      id: 'reader',
      role: 'researcher',
      task: 'Read source A',
      allowedTools: ['read_file'],
      maxTokens: 500,
    }, 'root-run:reader')

    expect(child.parentRunId).toBe(parent.runId)
    expect(child.tools.map((item) => item.name)).toEqual(['read_file'])
    expect(child.limits.maxTokens).toBe(500)
    expect(child.messages).toEqual([{ role: 'user', content: 'Read source A' }])
    expect(child.harnessContext?.join('\n')).toContain('researcher sub-agent')
  })

  it('drops irrelevant permissions and requires child runs to re-approve inherited grants', () => {
    const permissions: PermissionMap = new Map([
      ['fs:read', { scope: 'fs:read', status: 'granted' }],
      ['fs:write', { scope: 'fs:write', status: 'granted' }],
    ])
    const parent = parentContext({ permissions })
    const child = createSubAgentContext(parent, {
      id: 'reader',
      role: 'reader',
      task: 'Read only',
      allowedTools: ['read_file'],
    }, 'root-run:reader')

    expect([...child.permissions?.keys() ?? []]).toEqual(['fs:read'])
    expect(child.permissions?.get('fs:read')).toMatchObject({ status: 'prompt' })
    expect(parent.permissions?.get('fs:read')).toMatchObject({ status: 'granted' })
  })

  it('does not resolve role names through Object.prototype', () => {
    expect(resolveSubAgentRole('constructor')).toBeUndefined()
    expect(applyRoleDefaults({ role: 'constructor', task: 'inspect' })).toEqual({
      role: 'constructor',
      task: 'inspect',
    })
  })

  it('rejects permission widening and nested dispatch', async () => {
    const parent = parentContext()
    await expect(dispatchSubAgents(parent, [{
      role: 'researcher',
      task: 'escape',
      allowedTools: ['unknown_tool'],
    }])).rejects.toThrow("not available to the parent")

    await expect(dispatchSubAgents({ ...parent, parentRunId: 'ancestor' }, [{
      role: 'researcher',
      task: 'nested',
    }])).rejects.toThrow('cannot dispatch another sub-agent')
  })

  it('returns isolated results in input order', async () => {
    let active = 0
    let peak = 0
    const runner = async function* (ctx: QueryContext): AsyncGenerator<QueryEvent> {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, ctx.runId.endsWith('slow') ? 8 : 2))
      active--
      if (ctx.runId.endsWith('failed')) {
        yield { type: 'run.failed', error: { kind: 'api_error', message: 'provider failed' } }
        return
      }
      yield { type: 'message.completed', content: `result:${ctx.runId}` }
      yield {
        type: 'run.completed',
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, turns: 1, toolCalls: 0 },
      }
    }
    const progress: string[] = []
    const results = await dispatchSubAgents(parentContext(), [
      { id: 'slow', role: 'reader', task: 'A' },
      { id: 'failed', role: 'checker', task: 'B' },
      { id: 'fast', role: 'formatter', task: 'C' },
    ], {
      concurrency: 2,
      runner,
      onProgress: (event) => progress.push(`${event.agentId}:${event.status}`),
    })

    expect(peak).toBe(2)
    expect(results.map((result) => result.agentId)).toEqual(['slow', 'failed', 'fast'])
    expect(results.map((result) => result.status)).toEqual(['completed', 'failed', 'completed'])
    expect(results[1].error).toBe('provider failed')
    expect(progress).toEqual(expect.arrayContaining([
      'slow:running', 'slow:completed',
      'failed:running', 'failed:failed',
      'fast:running', 'fast:completed',
    ]))
  })

  it('reports metered token usage when a child fails before a completed event', async () => {
    const budget = new SharedTaskTreeBudget(100)
    const parent = parentContext({ taskTree: { rootRunId: 'root-run', depth: 0, budget } })
    const runner = async function* (ctx: QueryContext): AsyncGenerator<QueryEvent> {
      budget.consume(ctx.runId, 7)
      yield { type: 'run.failed', error: { kind: 'api_error', message: 'provider failed' } }
    }

    const [result] = await dispatchSubAgents(parent, [
      { id: 'failed', role: 'reader', task: 'Fail after usage' },
    ], { runner })

    expect(result.status).toBe('failed')
    expect(result.usage.totalTokens).toBe(7)
  })

  it('removes combined abort listeners after a child finishes normally', async () => {
    const dispatchController = new AbortController()
    const budget = new SharedTaskTreeBudget(100)
    const parent = parentContext({ taskTree: { rootRunId: 'root-run', depth: 0, budget } })
    const dispatchRemove = vi.spyOn(dispatchController.signal, 'removeEventListener')
    const budgetRemove = vi.spyOn(budget.signal, 'removeEventListener')
    const runner = async function* (): AsyncGenerator<QueryEvent> {
      yield { type: 'run.completed', usage: { ...EMPTY_TEST_USAGE, totalTokens: 1 } }
    }

    await dispatchSubAgents(parent, [
      { id: 'done', role: 'reader', task: 'Finish' },
    ], { runner, signal: dispatchController.signal })

    expect(dispatchRemove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(budgetRemove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})

const EMPTY_TEST_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  turns: 0,
  toolCalls: 0,
}
