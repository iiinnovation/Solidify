import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryState } from '../../memory'
import { ProviderRegistry } from '../../model'
import type { CompletionChunk, CompletionRequest, ModelProvider } from '../../model'
import { answerApproval, subscribeApproval } from '../../harness/approval-channel'
import { resetFlagCache, setFlagOverride } from '../../harness/flags'
import { RunLedger } from '../../harness/ledger'
import type { Tool, ToolResult } from '../../tools/types'
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
  it('persists the successful tool lifecycle in authoritative order', async () => {
    const runId = 'm2-read-success'
    const execute = vi.fn(async (): Promise<ToolResult> => ({ success: true, content: 'read complete' }))
    const provider = scriptedProvider([
      toolTurn([{ id: 'read-1', name: 'read_item' }]),
      finalTurn,
    ])

    const events = await collect(makeContext(runId, provider, [makeTool('read_item', execute)]))
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
      request: {
        model: 'mock-model',
        maxTokens: 1000,
        stream: true,
      },
    })
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
