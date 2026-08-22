import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryState } from '../../memory'
import { ProviderRegistry } from '../../model'
import type { CompletionChunk, CompletionRequest, ModelProvider } from '../../model'
import { answerApproval, subscribeApproval } from '../../harness/approval-channel'
import { createHarnessRuntime } from '../../harness/builtin-hooks'
import { resetFlagCache, setFlagOverride } from '../../harness/flags'
import { RunLedger } from '../../harness/ledger'
import type { Tool, ToolResult } from '../../tools/types'
import { activateSkillTool } from '../../tools/builtin/activate-skill'
import { runQuery } from '../query'
import type { QueryContext, QueryEvent } from '../types'

const finalTurn: CompletionChunk[] = [
  { type: 'content_delta', delta: 'done' },
  {
    type: 'message_end',
    usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
    stopReason: 'end_turn',
  },
]

function toolTurn(calls: Array<{ id: string; name: string; input?: unknown }>): CompletionChunk[] {
  return [
    ...calls.flatMap<CompletionChunk>((call) => [
      { type: 'tool_call_start', id: call.id, name: call.name },
      { type: 'tool_call_end', id: call.id, input: call.input ?? {} },
    ]),
    { type: 'message_end', stopReason: 'tool_use' },
  ]
}

function scriptedProvider(script: CompletionChunk[][], requests: CompletionRequest[] = []): ModelProvider {
  let turn = 0
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
    async *stream(request) {
      requests.push(request)
      yield* script[Math.min(turn++, script.length - 1)]
    },
  }
}

function makeTool(name: string, execute: Tool['execute'], confirmation = false): Tool {
  return {
    name,
    description: `Run ${name}`,
    inputSchema: { type: 'object' },
    readOnly: !confirmation,
    concurrencySafe: false,
    destructive: confirmation,
    requiresConfirmation: confirmation,
    availability: 'always',
    permissions: [],
    execute,
    renderCall: () => name,
  }
}

function makeContext(runId: string, provider: ModelProvider, tools: Tool[], signal = new AbortController().signal): QueryContext {
  const providerRegistry = new ProviderRegistry()
  providerRegistry.register('mock', provider)
  return {
    runId,
    conversationId: `${runId}-conversation`,
    cwd: '/workspace',
    messages: [{ role: 'user', content: 'run the tools' }],
    tools,
    memory: new InMemoryState(),
    model: { provider: 'mock', model: 'mock-model' },
    limits: {
      maxTurns: 5,
      maxTokens: 100_000,
      maxOutputTokens: 1000,
      maxToolCalls: 10,
      toolTimeoutMs: 1000,
    },
    signal,
    providerRegistry,
  }
}

async function collect(ctx: QueryContext): Promise<QueryEvent[]> {
  const events: QueryEvent[] = []
  for await (const event of runQuery(ctx)) events.push(event)
  return events
}

beforeEach(() => {
  localStorage.clear()
  setFlagOverride('harness', true)
})

afterEach(() => {
  localStorage.clear()
  resetFlagCache()
})

describe('M2 Harness query integration', () => {
  it('prepares workspace memory and the Skill index concurrently', async () => {
    let memoryStarted = false
    let skillsStarted = false
    let releaseMemory!: () => void
    let releaseSkills!: () => void
    const memoryGate = new Promise<void>((resolve) => { releaseMemory = resolve })
    const skillsGate = new Promise<void>((resolve) => { releaseSkills = resolve })
    const base = makeContext('m2-parallel-context', scriptedProvider([finalTurn]), [])
    const context: QueryContext = {
      ...base,
      memory: {
        store: async () => 'handle',
        retrieve: async () => null,
        clear: async () => undefined,
        search: async () => {
          memoryStarted = true
          await memoryGate
          return []
        },
      },
    }
    const runtime = createHarnessRuntime(context, {
      skillRegistry: {
        load: async () => { throw new Error('not used') },
        resolve: async () => null,
        list: async () => {
          skillsStarted = true
          await skillsGate
          return []
        },
      },
    })
    const pending = runtime.hooks.waterfall('before_query', { messages: context.messages }, {
      type: 'before_query',
      runId: context.runId,
      signal: context.signal,
    })

    await Promise.resolve()
    await Promise.resolve()
    const startedTogether = memoryStarted && skillsStarted
    releaseMemory()
    releaseSkills()
    await pending
    expect(startedTogether).toBe(true)
  })

  it('uses the de-duplicated progress budget instead of cumulative prompt telemetry', async () => {
    const expensiveToolTurn = (id: string): CompletionChunk[] => [
      { type: 'tool_call_start', id, name: 'read_item' },
      { type: 'tool_call_end', id, input: {} },
      {
        type: 'message_end',
        usage: { inputTokens: 60_000, outputTokens: 1, totalTokens: 60_001 },
        stopReason: 'tool_use',
      },
    ]
    const provider = scriptedProvider([
      expensiveToolTurn('read-1'),
      expensiveToolTurn('read-2'),
      finalTurn,
    ])
    const events = await collect(makeContext('m2-progress-budget', provider, [makeTool('read_item', async () => ({ success: true, content: 'ok' }))]))

    expect(events.at(-1)?.type).toBe('run.completed')
    expect(events.map(event => event.type)).not.toContain('run.failed')
  })

  it('reports a budget guard stop as exhausted rather than failed', async () => {
    // The normal query check is not involved here: the before-model guard sees
    // the zero-sized run budget and exercises its terminal error path.
    const context = makeContext('m2-budget-guard-zero', scriptedProvider([finalTurn]), [])
    const guarded = await collect({ ...context, limits: { ...context.limits, maxTokens: 0 } })

    expect(guarded.at(-1)?.type).toBe('run.exhausted')
    expect(guarded.map(event => event.type)).not.toContain('run.failed')
  })

  it('persists the successful tool lifecycle in authoritative order', async () => {
    const runId = 'm2-read-success'
    const execute = vi.fn(async (): Promise<ToolResult> => ({ success: true, content: 'read complete' }))
    const provider = scriptedProvider([
      toolTurn([{ id: 'read-1', name: 'read_item' }]),
      finalTurn,
    ])

    const events = await collect({
      ...makeContext(runId, provider, [makeTool('read_item', execute)]),
      requestStartedAt: Date.now() - 10,
    })
    const ledger = new RunLedger(runId)
    const types = ledger.events().map((event) => event.type)

    expect(execute).toHaveBeenCalledOnce()
    expect(events.at(-1)?.type).toBe('run.completed')
    expect(types).toEqual([
      'run.started',
      'model.called',
      'tool.requested',
      'model.completed',
      'tool.completed',
      'model.called',
      'model.completed',
      'run.completed',
    ])
    expect(ledger.find('tool.completed')[0].payload).toMatchObject({
      callId: 'read-1',
      success: true,
      content: 'read complete',
    })
    expect(ledger.find('model.called')[0].payload).toMatchObject({
      localGapMs: expect.any(Number),
      request: {
        model: 'mock-model',
        maxTokens: 1000,
        stream: true,
      },
      contextStats: {
        slots: {
          systemTokens: expect.any(Number),
          toolsTokens: expect.any(Number),
          historyTokens: expect.any(Number),
          attachmentTokens: expect.any(Number),
          currentTaskTokens: expect.any(Number),
        },
        fixedPrefixFingerprint: expect.stringMatching(/^ctx-/),
      },
    })
    expect(ledger.find('model.completed')).toHaveLength(2)
    expect(ledger.find('model.completed').every((event) => {
      const value = (event.payload as { firstChunkAt?: unknown }).firstChunkAt
      return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    })).toBe(true)
    expect(ledger.find('run.started')[0].payload).toMatchObject({
      conversationId: `${runId}-conversation`,
      startupDelayMs: expect.any(Number),
      model: { provider: 'mock', model: 'mock-model' },
      skill: null,
    })
  })

  it('does not scan the full Skill index when a Skill is already bound', async () => {
    const context = {
      ...makeContext('m4r-06-bound-skill', scriptedProvider([finalTurn]), []),
      skill: {
        metadata: { name: 'demo-code', version: '1.0.0', description: 'demo' },
        content: '生成 demo',
        path: 'builtin://demo-code/SKILL.md',
      },
    } satisfies QueryContext
    const list = vi.fn(async () => [{ name: 'other', version: '1.0.0', description: 'other' }])
    const runtime = createHarnessRuntime(context, {
      skillRegistry: { load: async () => { throw new Error('not used') }, resolve: async () => null, list },
    })
    await runtime.hooks.waterfall('before_query', { messages: context.messages }, {
      type: 'before_query', runId: context.runId, signal: context.signal,
    })
    expect(list).not.toHaveBeenCalled()
  })

  it('keeps the fixed context fingerprint stable when only the user task changes', async () => {
    await collect({
      ...makeContext('m4r-01-fingerprint-a', scriptedProvider([finalTurn]), []),
      messages: [{ role: 'user', content: '请整理需求' }],
    })
    await collect({
      ...makeContext('m4r-01-fingerprint-b', scriptedProvider([finalTurn]), []),
      messages: [{ role: 'user', content: '请解释幂等性' }],
    })
    const fingerprint = (runId: string) => {
      const payload = new RunLedger(runId).find('model.called')[0].payload as { contextStats?: { fixedPrefixFingerprint?: string } }
      return payload.contextStats?.fixedPrefixFingerprint
    }
    expect(fingerprint('m4r-01-fingerprint-a')).toBe(fingerprint('m4r-01-fingerprint-b'))
  })

  it('activates a trusted Skill on the next model turn without expanding permissions', async () => {
    const runId = 'm4r-11-activate-skill'
    const provider = scriptedProvider([
      toolTurn([{ id: 'activate-1', name: 'activate_skill', input: { skillName: 'demo-code' } }]),
      finalTurn,
    ])
    const context = {
      ...makeContext(runId, provider, [activateSkillTool as Tool]),
      skillRegistry: {
        load: async () => { throw new Error('not used') },
        list: async () => [],
        resolve: async (name: string) => name === 'demo-code'
          ? { metadata: { name, version: '1.0.0', description: 'demo', allowedTools: ['read_file'] }, content: 'demo rules', path: 'builtin://demo-code/SKILL.md' }
          : null,
      },
    } satisfies QueryContext
    const events = await collect(context)
    expect(events).toContainEqual({ type: 'skill.activated', name: 'demo-code', version: '1.0.0' })
    expect(new RunLedger(runId).find('skill.activated')).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  it('keeps caller-injected runtime tools when a Skill is activated', async () => {
    const requests: CompletionRequest[] = []
    const runtimeTool = makeTool('dispatch_agent', async () => ({ success: true, content: 'runtime' }))
    const provider = scriptedProvider([
      toolTurn([{ id: 'activate-runtime', name: 'activate_skill', input: { skillName: 'demo-code' } }]),
      finalTurn,
    ], requests)
    const context = {
      ...makeContext('m4r-11-runtime-tools', provider, [activateSkillTool as Tool, runtimeTool]),
      skillRegistry: {
        load: async () => { throw new Error('not used') },
        list: async () => [],
        resolve: async (name: string) => name === 'demo-code'
          ? { metadata: { name, version: '1.0.0', description: 'demo', allowedTools: ['read_file'] }, content: 'demo rules', path: 'builtin://demo-code/SKILL.md' }
          : null,
      },
    } satisfies QueryContext

    await collect(context)
    expect(requests[1]?.tools?.map((tool) => tool.name)).toContain('dispatch_agent')
  })

  it('records null when a model turn yields no non-ping chunk', async () => {
    const runId = 'm4r-02-no-chunk'
    const events = await collect({
      ...makeContext(runId, scriptedProvider([[{ type: 'ping' }]]), []),
    })
    expect(events.at(-1)?.type).toBe('run.completed')
    const completed = new RunLedger(runId).find('model.completed')[0]
    expect(completed.payload).toMatchObject({ firstChunkAt: null })
  })

  it('records the selected Skill identity and version at run start', async () => {
    const runId = 'm4-skill-ledger'
    const context: QueryContext = {
      ...makeContext(runId, scriptedProvider([finalTurn]), []),
      skill: {
        metadata: { name: 'requirement-analysis', version: '2.0.0', description: 'requirements' },
        content: '# Requirements',
        path: 'builtin://requirement-analysis/SKILL.md',
        source: 'builtin',
      },
    }

    await collect(context)

    expect(new RunLedger(runId).find('run.started')[0].payload).toMatchObject({
      skill: { name: 'requirement-analysis', version: '2.0.0', source: 'builtin' },
    })
  })

  it('allows a selected Skill virtual resource through the real harness execution path', async () => {
    const path = '.solidify/skills/demo/reference/guide.md'
    const read = vi.fn(async (): Promise<ToolResult> => ({ success: true, content: '# Guide' }))
    const tool = {
      ...makeTool('read_file', read),
      availability: 'tauri-or-skill-resource' as const,
      permissions: ['fs:read' as const],
    }
    const context: QueryContext = {
      ...makeContext('m4-virtual-resource-policy', scriptedProvider([
        toolTurn([{ id: 'read-skill', name: 'read_file', input: { path } }]),
        finalTurn,
      ]), [tool]),
      platform: 'web',
      skillResources: {
        virtualRoot: '.solidify/skills/demo',
        canRead: (candidate) => candidate === path,
        read: async () => ({ content: '# Guide', bytes: 7, truncated: false }),
      },
    }

    const events = await collect(context)
    const completed = events.find(
      (event): event is Extract<QueryEvent, { type: 'tool.completed' }> => event.type === 'tool.completed',
    )

    expect(read).toHaveBeenCalledOnce()
    expect(completed?.result).toMatchObject({ success: true, content: '# Guide' })
  })

  it('freezes the authoritative tool call before exposing its ledgered input', async () => {
    const execute = vi.fn(async (input: { path: string }): Promise<ToolResult> => ({
      success: true,
      content: input.path,
    }))
    const tool = makeTool('read_item', execute) as Tool
    const events: QueryEvent[] = []

    for await (const event of runQuery(makeContext(
      'm2-frozen-tool-call',
      scriptedProvider([toolTurn([{ id: 'read-1', name: 'read_item', input: { path: 'original.txt' } }]), finalTurn]),
      [tool],
    ))) {
      events.push(event)
      if (event.type === 'tool.requested') {
        expect(() => { event.call.input.path = 'tampered.txt' }).toThrow()
      }
    }

    expect(execute).toHaveBeenCalledWith(
      { path: 'original.txt' },
      expect.any(Object),
      expect.any(AbortSignal),
      expect.any(Function),
    )
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  it('feeds a denied approval back to the model as a failed tool result', async () => {
    const requests: CompletionRequest[] = []
    const execute = vi.fn(async (): Promise<ToolResult> => ({ success: true, content: 'should not run' }))
    const unsubscribe = subscribeApproval((request) => {
      if (request) answerApproval(request.requestId, 'deny')
    })
    try {
      const events = await collect(makeContext(
        'm2-denied-approval',
        scriptedProvider([toolTurn([{ id: 'write-1', name: 'write_item' }]), finalTurn], requests),
        [makeTool('write_item', execute, true)],
      ))

      expect(execute).not.toHaveBeenCalled()
      expect(events).toContainEqual(expect.objectContaining({ type: 'permission.resolved', outcome: 'rejected' }))
      expect(JSON.stringify(requests[1].messages.at(-1))).toContain('用户未授权该操作')
      expect(JSON.stringify(requests[1].messages.at(-1))).toContain('"is_error":true')
    } finally {
      unsubscribe()
    }
  })

  it('does not enter later tool execution after cancellation during approval', async () => {
    const controller = new AbortController()
    const firstExecute = vi.fn(async (): Promise<ToolResult> => ({ success: true, content: 'first' }))
    const secondExecute = vi.fn(async (): Promise<ToolResult> => ({ success: true, content: 'second' }))
    const unsubscribe = subscribeApproval((request) => {
      if (request) controller.abort()
    })
    try {
      const runId = 'm2-cancel-approval'
      const events = await collect(makeContext(
        runId,
        scriptedProvider([toolTurn([
          { id: 'first', name: 'first_write' },
          { id: 'second', name: 'second_write' },
        ])]),
        [
          makeTool('first_write', firstExecute, true),
          makeTool('second_write', secondExecute, true),
        ],
        controller.signal,
      ))

      expect(firstExecute).not.toHaveBeenCalled()
      expect(secondExecute).not.toHaveBeenCalled()
      expect(events.at(-1)).toMatchObject({ type: 'run.failed', error: { kind: 'aborted' } })
      expect(new RunLedger(runId).find('tool.completed')).toHaveLength(2)
    } finally {
      unsubscribe()
    }
  })
})
