/**
 * M1-14/15: Loop ↔ executor integration
 * Real execution through the loop, parallel path, mixed tombstone batch
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { runQuery } from '../query'
import type { QueryContext, QueryEvent } from '../types'
import { ProviderRegistry } from '../../model'
import type { ModelProvider } from '../../model'
import type { CompletionChunk, CompletionRequest } from '../../model/types'
import type { Tool, ToolResult } from '../../tools/types'
import type { MemoryState } from '../../memory/types'
import { clearFlagOverrides, setFlagOverride } from '../../harness/flags'
import { readAttachmentTool } from '../../tools/builtin/attachments'
import { readHandleTool } from '../../tools/builtin/read-handle'
import { chooseAttachmentContextMode, formatInlineAttachments } from '../../attachments/types'
import { modelContextWindow } from '../../model/capabilities'
import { createChatQueryContext } from '../chat-context'
import type { ModelProvider as ModelProviderConfig } from '../../../stores/model-store'

function makeMockProvider(script: CompletionChunk[][], requests?: CompletionRequest[]): ModelProvider {
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
    async *stream(request: CompletionRequest): AsyncGenerator<CompletionChunk> {
      requests?.push(request)
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

const drawioArtifact = '<solidify-artifact type="drawio" title="Architecture"><mxfile><diagram><mxGraphModel><root /></mxGraphModel></diagram></mxfile></solidify-artifact>'
const drawioFinalTurn: CompletionChunk[] = [
  { type: 'content_delta', delta: drawioArtifact },
  {
    type: 'message_end',
    usage: { inputTokens: 20, outputTokens: 20, totalTokens: 40 },
    stopReason: 'end_turn',
  },
]

describe('runQuery tool execution (M1-14/15)', () => {
  beforeEach(() => {
    // Match production: canonical Skill V2 enables Harness through feature
    // dependencies. Parallel tests must exercise that real path.
    setFlagOverride('skillV2', true)
  })

  afterEach(() => clearFlagOverrides())

  it('runs the logged qwen3.8 Draw.io attachment case in one tool-free model round', async () => {
    const attachment = {
      id: 'att-qwen-drawio',
      name: '审计AI综合场景建设技术方案.md',
      size: 77_600,
      text: `${'数'.repeat(28_700)}总体五层技术架构：业务应用层、AI能力层、模型服务层、数据支撑层、安全治理。`,
    }
    const prompt = '根据文档内容生成一份系统架构图。'
    const contextWindow = modelContextWindow('qwen3.8')
    const attachmentMode = chooseAttachmentContextMode({
      resources: [attachment],
      userContent: prompt,
      contextWindow,
      reservedTokens: 4_000,
    })
    const requests: CompletionRequest[] = []
    const mock = makeMockProvider([drawioFinalTurn], requests)
    const registry = new ProviderRegistry()
    registry.register('openai', mock)
    const configuredProvider: ModelProviderConfig = {
      id: 'qwen-internal', name: '内网 qwen3.8', apiUrl: 'https://example.com/v1/chat/completions',
      apiKey: 'test-key', modelId: 'qwen3.8', format: 'openai', enabled: true,
    }
    const context = createChatQueryContext({
      runId: 'qwen-drawio-real-path',
      conversationId: 'qwen-drawio-conversation',
      messages: [{ role: 'user', content: `${prompt}${formatInlineAttachments([attachment])}` }],
      provider: configuredProvider,
      signal: new AbortController().signal,
      attachments: [attachment],
      attachmentMode,
      loadedSkill: {
        metadata: { name: 'drawio-diagram', version: '2.1.0', description: 'Draw.io diagram' },
        content: 'Return one valid Draw.io Artifact.',
        path: 'builtin://drawio-diagram/SKILL.md',
      },
    })
    const events: QueryEvent[] = []
    for await (const event of runQuery({ ...context, providerRegistry: registry })) events.push(event)

    expect(contextWindow).toBe(128_000)
    expect(attachmentMode).toBe('inline')
    expect(context.tools).toEqual([])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ toolChoice: 'none' })
    expect(requests[0]).not.toHaveProperty('reasoningMode')
    expect(requests[0].tools).toBeUndefined()
    expect(requests[0].system).not.toContain('/no_think')
    expect(JSON.stringify(requests[0].messages)).toContain('总体五层技术架构')
    expect(events.filter((event) => event.type === 'tool.requested')).toHaveLength(0)
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  it('emits a generator-owned artifact directly without a second model turn', async () => {
    let providerCalls = 0
    const provider: ModelProvider = {
      ...makeMockProvider([]),
      async *stream(): AsyncGenerator<CompletionChunk> {
        providerCalls++
        yield { type: 'tool_call_start', id: 'deck-1', name: 'generate_pptd' }
        yield { type: 'tool_call_end', id: 'deck-1', input: {} }
        yield {
          type: 'message_end',
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          stopReason: 'tool_use',
        }
      },
    }
    const stored = new Map<string, string>()
    const memory: MemoryState = {
      async store(data) { stored.set('mem-deck', data); return 'mem-deck' },
      async retrieve(handle) { return stored.get(handle) ?? null },
      async search() { return [] },
      async clear() { stored.clear() },
    }
    const artifact = '<solidify-artifact title="Deck" type="slides" path="03-交付物/deck.pptd">{}</solidify-artifact>'
    const generator: Tool = {
      name: 'generate_pptd', description: 'generate', inputSchema: { type: 'object' },
      readOnly: true, concurrencySafe: false, destructive: false,
      requiresConfirmation: false, terminalOnFailure: true, availability: 'always', permissions: [],
      async execute(): Promise<ToolResult> {
        const contentHandle = await memory.store(artifact)
        return {
          success: true,
          content: 'generated',
          data: {
            directAssistantContent: true,
            contentHandle,
            artifact: { title: 'Deck', type: 'slides', path: '03-交付物/deck.pptd' },
            usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
          },
        }
      },
      renderCall: () => 'generate',
    }
    const ctx = { ...makeCtx(provider, [generator]), memory }
    const events: QueryEvent[] = []
    for await (const event of runQuery(ctx)) events.push(event)

    expect(providerCalls).toBe(1)
    expect(events).toContainEqual({ type: 'message.delta', text: artifact })
    expect(events.find((event) => event.type === 'run.completed')).toMatchObject({
      usage: { inputTokens: 40, outputTokens: 22, totalTokens: 62, toolCalls: 1 },
    })
  })

  it('terminates after a one-shot PPTD generator fails instead of retrying it', async () => {
    let providerCalls = 0
    const provider: ModelProvider = {
      ...makeMockProvider([]),
      async *stream(): AsyncGenerator<CompletionChunk> {
        providerCalls++
        yield { type: 'tool_call_start', id: `deck-${providerCalls}`, name: 'generate_pptd' }
        yield { type: 'tool_call_end', id: `deck-${providerCalls}`, input: { brief: 'deck' } }
        yield { type: 'message_end', stopReason: 'tool_use' }
      },
    }
    const generator: Tool = {
      name: 'generate_pptd', description: 'generate', inputSchema: { type: 'object' },
      readOnly: true, concurrencySafe: false, destructive: false,
      requiresConfirmation: false, terminalOnFailure: true, availability: 'always', permissions: [],
      async execute(): Promise<ToolResult> {
        throw new Error('PPTD page 输出达到 token 上限')
      },
      renderCall: () => 'generate',
    }
    const events: QueryEvent[] = []
    for await (const event of runQuery({ ...makeCtx(provider, [generator]) })) events.push(event)

    expect(providerCalls).toBe(1)
    expect(events.filter((event) => event.type === 'tool.requested')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      error: { kind: 'internal', message: 'PPTD page 输出达到 token 上限' },
    })
  })

  it('blocks a fourth execution after three consecutive failures', async () => {
    const scripts: CompletionChunk[][] = [0, 1, 2, 3].map((index) => [
      { type: 'tool_call_start' as const, id: `read-${index}`, name: 'flaky_read' },
      { type: 'tool_call_end' as const, id: `read-${index}`, input: {} },
      { type: 'message_end' as const, stopReason: 'tool_use' as const },
    ])
    scripts.push(finalTurn)
    let executions = 0
    const provider = makeMockProvider(scripts)
    const flaky: Tool = {
      name: 'flaky_read', description: 'flaky read', inputSchema: { type: 'object' },
      readOnly: true, concurrencySafe: false, destructive: false,
      requiresConfirmation: false, availability: 'always', permissions: [],
      async execute(): Promise<ToolResult> {
        executions++
        throw new Error('temporary failure')
      },
      renderCall: () => 'flaky read',
    }

    const events: QueryEvent[] = []
    for await (const event of runQuery(makeCtx(provider, [flaky]))) events.push(event)

    expect(executions).toBe(3)
    expect(events.filter((event) => event.type === 'tool.requested')).toHaveLength(4)
    expect(events.filter((event) => event.type === 'tool.completed').at(-1)).toMatchObject({
      result: {
        success: false,
        error: { kind: 'circuit_breaker', recoverable: false, message: expect.stringContaining('连续失败 3 次') },
      },
    })
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      error: { message: expect.stringContaining('连续失败 3 次') },
    })
  })

  it('closes a no-progress attachment loop and lets the model finish without attachment tools', async () => {
    const repeatedRead = (index: number): CompletionChunk[] => [
      { type: 'tool_call_start', id: `attachment-${index}`, name: 'read_attachment' },
      { type: 'tool_call_end', id: `attachment-${index}`, input: { attachmentId: 'att-a', offset: 0, limit: 100 } },
      { type: 'message_end', stopReason: 'tool_use' },
    ]
    const requests: CompletionRequest[] = []
    const provider = makeMockProvider([
      repeatedRead(1), repeatedRead(2), repeatedRead(3), repeatedRead(4), repeatedRead(5), finalTurn,
    ], requests)
    let executions = 0
    const attachmentReader: Tool = {
      name: 'read_attachment', description: 'read attachment', inputSchema: { type: 'object' },
      readOnly: true, concurrencySafe: true, destructive: false, requiresConfirmation: false,
      availability: 'always', permissions: [], loopGroup: 'attachment-retrieval', loopKey: 'read', replaySafe: true,
      async execute(): Promise<ToolResult> {
        executions++
        return { success: true, content: 'same attachment section '.repeat(20) }
      },
      renderCall: () => 'read attachment',
    }

    const events: QueryEvent[] = []
    const context = makeCtx(provider, [attachmentReader])
    for await (const event of runQuery({ ...context, limits: { ...context.limits, maxTurns: 6 } })) events.push(event)

    expect(executions).toBe(2)
    expect(events.filter((event) => event.type === 'tool.requested')).toHaveLength(5)
    expect(events.some((event) => event.type === 'tool.completed' && event.result.error?.kind === 'budget_exhausted')).toBe(true)
    expect(events.at(-1)?.type).toBe('run.completed')
    const finalRequest = requests.at(-1)
    expect(finalRequest?.tools ?? []).toEqual([])
  })

  it('terminates a model that ignores the closed retrieval phase', async () => {
    const repeatedRead = (index: number): CompletionChunk[] => [
      { type: 'tool_call_start', id: `stubborn-${index}`, name: 'read_attachment' },
      { type: 'tool_call_end', id: `stubborn-${index}`, input: { attachmentId: 'att-a', offset: 0 } },
      { type: 'message_end', stopReason: 'tool_use' },
    ]
    const provider = makeMockProvider(Array.from({ length: 8 }, (_, index) => repeatedRead(index)))
    const attachmentReader: Tool = {
      name: 'read_attachment', description: 'read attachment', inputSchema: { type: 'object' },
      readOnly: true, concurrencySafe: true, destructive: false, requiresConfirmation: false,
      availability: 'always', permissions: [], loopGroup: 'attachment-retrieval', loopKey: 'read', replaySafe: true,
      async execute(): Promise<ToolResult> { return { success: true, content: 'same attachment section '.repeat(20) } },
      renderCall: () => 'read attachment',
    }
    const context = makeCtx(provider, [attachmentReader])
    const events: QueryEvent[] = []
    for await (const event of runQuery({ ...context, limits: { ...context.limits, maxTurns: 8 } })) events.push(event)

    expect(events.at(-1)).toMatchObject({ type: 'run.exhausted', reason: 'tool_loop' })
  })

  it('generates Draw.io from full inline attachment text on the first zero-tool turn', async () => {
    const requests: CompletionRequest[] = []
    const provider = makeMockProvider([drawioFinalTurn], requests)
    const unrelatedTool: Tool = {
      name: 'dispatch_agent', description: 'unrelated runtime tool', inputSchema: { type: 'object' },
      readOnly: true, concurrencySafe: true, destructive: false, requiresConfirmation: false,
      availability: 'always', permissions: [],
      async execute(): Promise<ToolResult> { return { success: true, content: 'not used' } },
      renderCall: () => 'dispatch',
    }
    const base = makeCtx(provider, [unrelatedTool])
    const events: QueryEvent[] = []
    for await (const event of runQuery({
      ...base,
      attachmentMode: 'inline',
      attachments: [{ id: 'att-a', name: 'brief.md', size: 100, text: 'architecture evidence' }],
      messages: [{ role: 'user', content: 'Draw the architecture.\n<attachments_inline>architecture evidence</attachments_inline>' }],
      skill: {
        metadata: { name: 'drawio-diagram', version: '2.1.0', description: 'draw diagram' },
        content: 'Generate the diagram from attachment evidence.',
        path: 'builtin://drawio-diagram/SKILL.md',
      },
    })) events.push(event)

    expect(requests).toHaveLength(1)
    expect(requests[0].tools ?? []).toEqual([])
    expect(requests[0].toolChoice).toBe('none')
    expect(requests[0].temperature).toBe(0.2)
    expect(requests[0].system).toContain('all tools are intentionally unavailable')
    expect(events.some((event) => event.type === 'tool.requested')).toBe(false)
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  it('keeps Draw.io retrieval available after valid evidence and rejects malformed follow-up input', async () => {
    const requests: CompletionRequest[] = []
    const provider = makeMockProvider([
      [
        { type: 'tool_call_start', id: 'search-valid', name: 'search_attachments' },
        { type: 'tool_call_end', id: 'search-valid', input: { query: 'system architecture', limit: 6 } },
        { type: 'message_end', stopReason: 'tool_use' },
      ],
      [
        // Reproduce the malformed Qwen call from the ledger. The common
        // runtime keeps retrieval available but rejects the bad integer type.
        { type: 'tool_call_start', id: 'search-hidden-invalid', name: 'search_attachments' },
        { type: 'tool_call_end', id: 'search-hidden-invalid', input: { query: 'model layer', limit: '6' } },
        { type: 'message_end', stopReason: 'tool_use' },
      ],
      drawioFinalTurn,
    ], requests)
    let executions = 0
    const searchTool: Tool = {
      name: 'search_attachments',
      description: 'search attachment',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer' },
        },
      },
      readOnly: true,
      concurrencySafe: true,
      destructive: false,
      requiresConfirmation: false,
      availability: 'always',
      permissions: [],
      loopGroup: 'attachment-retrieval',
      loopKey: 'search',
      replaySafe: true,
      async execute(): Promise<ToolResult> {
        executions++
        return {
          success: true,
          content: '[brief.md 0-100]\narchitecture evidence',
          data: { hits: [{ attachmentId: 'att-a', start: 0, end: 100 }] },
        }
      },
      renderCall: () => 'search attachment',
    }
    const base = makeCtx(provider, [searchTool])
    const events: QueryEvent[] = []
    for await (const event of runQuery({
      ...base,
      attachments: [{ id: 'att-a', name: 'brief.md', size: 100, text: 'architecture evidence' }],
      skill: {
        metadata: { name: 'drawio-diagram', version: '2.1.0', description: 'draw diagram' },
        content: 'Generate the diagram from attachment evidence.',
        path: 'builtin://drawio-diagram/SKILL.md',
      },
    })) events.push(event)

    expect(executions).toBe(1)
    expect(requests.map((request) => request.tools?.map((tool) => tool.name) ?? []))
      .toEqual([['search_attachments'], ['search_attachments'], ['search_attachments']])
    expect(events.find((event) => event.type === 'tool.completed' && event.callId === 'search-hidden-invalid'))
      .toMatchObject({ result: { error: { kind: 'invalid_input' } } })
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  it('keeps retrieval schemas stable after an inline evidence pack is prepared', async () => {
    const requests: CompletionRequest[] = []
    const provider = makeMockProvider([
      [
        { type: 'tool_call_start', id: 'prepare-inline', name: 'prepare_attachment_evidence' },
        { type: 'tool_call_end', id: 'prepare-inline', input: { attachmentIds: ['att-a'], maxChars: 8_000 } },
        { type: 'message_end', stopReason: 'tool_use' },
      ],
      drawioFinalTurn,
    ], requests)
    const evidenceTool: Tool = {
      name: 'prepare_attachment_evidence',
      description: 'prepare evidence',
      inputSchema: { type: 'object' },
      readOnly: true,
      concurrencySafe: true,
      destructive: false,
      requiresConfirmation: false,
      availability: 'always',
      permissions: [],
      loopGroup: 'attachment-retrieval',
      loopKey: 'evidence',
      replaySafe: true,
      async execute(): Promise<ToolResult> {
        return {
          success: true,
          content: '[source attachment:att-a]\ncomplete architecture evidence',
          data: { entries: [{ attachmentId: 'att-a', offset: 0, end: 100 }] },
        }
      },
      renderCall: () => 'prepare evidence',
    }
    const base = makeCtx(provider, [evidenceTool])
    for await (const _event of runQuery({
      ...base,
      attachments: [{ id: 'att-a', name: 'brief.md', size: 100, text: 'complete architecture evidence' }],
      skill: {
        metadata: { name: 'drawio-diagram', version: '2.1.0', description: 'draw diagram' },
        content: 'Generate the diagram from attachment evidence.',
        path: 'builtin://drawio-diagram/SKILL.md',
      },
    })) { /* drain */ }

    expect(requests.map((request) => request.tools?.map((tool) => tool.name) ?? []))
      .toEqual([['prepare_attachment_evidence'], ['prepare_attachment_evidence']])
  })

  it('recovers tagged Qwen pagination calls without prematurely closing retrieval', async () => {
    const requests: CompletionRequest[] = []
    const taggedRead = [
      'I need one bounded section.',
      '<tool_call> <function=read_attachment>',
      '<parameter=attachmentId> att-a </parameter>',
      '<parameter=offset> 10 </parameter>',
      '<parameter=limit> 760 </parameter>',
      '</function> </tool_call>',
    ].join('\n')
    const leakedClosedCall = '<tool_call> <function=read_attachment> <parameter=attachmentId> att-a </parameter> <parameter=offset> 6149 </parameter> <parameter=limit> 760 </parameter> </function> </tool_call>'
    const provider = makeMockProvider([
      [{ type: 'content_delta', delta: taggedRead }, { type: 'message_end', stopReason: 'end_turn' }],
      [{ type: 'content_delta', delta: leakedClosedCall }, { type: 'message_end', stopReason: 'end_turn' }],
      drawioFinalTurn,
    ], requests)
    let executions = 0
    const readTool: Tool<{ attachmentId: string; offset: number; limit: number }> = {
      name: 'read_attachment',
      description: 'read attachment',
      inputSchema: {
        type: 'object',
        required: ['attachmentId'],
        properties: {
          attachmentId: { type: 'string' },
          offset: { type: 'integer' },
          limit: { type: 'integer' },
        },
        additionalProperties: false,
      },
      readOnly: true,
      concurrencySafe: true,
      destructive: false,
      requiresConfirmation: false,
      availability: 'always',
      permissions: [],
      loopGroup: 'attachment-retrieval',
      loopKey: 'read',
      replaySafe: true,
      async execute(input): Promise<ToolResult> {
        executions++
        expect(input).toMatchObject({ attachmentId: 'att-a', limit: 760 })
        return {
          success: true,
          content: `[attachment:att-a offset:${input.offset}]\nmodel layer evidence`,
          data: { attachmentId: 'att-a', offset: input.offset, total: 7_000 },
        }
      },
      renderCall: () => 'read attachment',
    }
    const base = makeCtx(provider, [readTool as Tool])
    const events: QueryEvent[] = []
    for await (const event of runQuery({
      ...base,
      attachments: [{ id: 'att-a', name: 'brief.md', size: 7_000, text: 'model layer evidence' }],
      skill: {
        metadata: { name: 'drawio-diagram', version: '2.1.0', description: 'draw diagram' },
        content: 'Generate the diagram from attachment evidence.',
        path: 'builtin://drawio-diagram/SKILL.md',
      },
    })) events.push(event)

    expect(executions).toBe(2)
    expect(requests.map((request) => request.tools?.map((tool) => tool.name) ?? []))
      .toEqual([['read_attachment'], ['read_attachment'], ['read_attachment']])
    expect(events.filter((event) => event.type === 'tool.requested')).toHaveLength(2)
    const streamed = events.filter((event): event is Extract<QueryEvent, { type: 'message.delta' }> => event.type === 'message.delta')
      .map((event) => event.text).join('')
    expect(streamed).toBe(drawioArtifact)
    expect(streamed).not.toContain('<tool_call>')
    expect(events.find((event) => event.type === 'message.completed')).toEqual({
      type: 'message.completed',
      content: drawioArtifact,
    })
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  it('fails instead of completing when Draw.io delivery remains invalid after repair', async () => {
    const invalid = '<tool_call> <function=read_attachment> <parameter=attachmentId> att-a </parameter> </function> </tool_call>'
    const provider = makeMockProvider([
      [{ type: 'content_delta', delta: invalid }, { type: 'message_end', stopReason: 'end_turn' }],
      [{ type: 'content_delta', delta: 'Still not an artifact.' }, { type: 'message_end', stopReason: 'end_turn' }],
    ])
    const base = makeCtx(provider, [])
    const events: QueryEvent[] = []
    for await (const event of runQuery({
      ...base,
      skill: {
        metadata: { name: 'drawio-diagram', version: '2.1.0', description: 'draw diagram' },
        content: 'Generate one Draw.io artifact.',
        path: 'builtin://drawio-diagram/SKILL.md',
      },
    })) events.push(event)

    expect(events.some((event) => event.type === 'message.delta')).toBe(false)
    expect(events.some((event) => event.type === 'message.completed')).toBe(false)
    expect(events.some((event) => event.type === 'run.completed')).toBe(false)
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      error: { message: expect.stringContaining('未生成有效的 Draw.io') },
    })
  })

  it('keeps targeted retrieval available when an evidence pack was handleized', async () => {
    const requests: CompletionRequest[] = []
    const provider = makeMockProvider([
      [
        { type: 'tool_call_start', id: 'prepare-handle', name: 'prepare_attachment_evidence' },
        { type: 'tool_call_end', id: 'prepare-handle', input: { attachmentIds: ['att-a'], maxChars: 48_000 } },
        { type: 'message_end', stopReason: 'tool_use' },
      ],
      drawioFinalTurn,
    ], requests)
    const evidenceTool: Tool = {
      name: 'prepare_attachment_evidence',
      description: 'prepare evidence',
      inputSchema: { type: 'object' },
      readOnly: true,
      concurrencySafe: true,
      destructive: false,
      requiresConfirmation: false,
      availability: 'always',
      permissions: [],
      loopGroup: 'attachment-retrieval',
      loopKey: 'evidence',
      replaySafe: true,
      async execute(): Promise<ToolResult> {
        return {
          success: true,
          content: '[source attachment:att-a]\npreview only\n\n[Result stored as mem-evidence: 48000 bytes. Use read_handle to retrieve it.]',
          data: { entries: [{ attachmentId: 'att-a', offset: 0, end: 48_000 }] },
          handle: 'mem-evidence',
          truncated: true,
        }
      },
      renderCall: () => 'prepare evidence',
    }
    const base = makeCtx(provider, [evidenceTool, readHandleTool as Tool])
    for await (const _event of runQuery({
      ...base,
      attachments: [{ id: 'att-a', name: 'brief.md', size: 48_000, text: 'large architecture evidence' }],
      skill: {
        metadata: { name: 'drawio-diagram', version: '2.1.0', description: 'draw diagram' },
        content: 'Generate the diagram from attachment evidence.',
        path: 'builtin://drawio-diagram/SKILL.md',
      },
    })) { /* drain */ }

    expect(requests.map((request) => request.tools?.map((tool) => tool.name) ?? []))
      .toEqual([
        ['prepare_attachment_evidence'],
        ['prepare_attachment_evidence', 'read_handle'],
      ])
  })

  it('enforces the provider-reported token hard cap separately from progress budget', async () => {
    const callTurn = (index: number): CompletionChunk[] => [
      { type: 'tool_call_start', id: `budget-${index}`, name: 'read_budgeted' },
      { type: 'tool_call_end', id: `budget-${index}`, input: {} },
      { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 60, outputTokens: 1, totalTokens: 61 } },
    ]
    const provider = makeMockProvider([callTurn(1), callTurn(2), finalTurn])
    const tool: Tool = {
      name: 'read_budgeted', description: 'read', inputSchema: { type: 'object' },
      readOnly: true, concurrencySafe: false, destructive: false, requiresConfirmation: false,
      availability: 'always', permissions: [],
      async execute(): Promise<ToolResult> { return { success: true, content: 'ok' } },
      renderCall: () => 'read',
    }
    const context = makeCtx(provider, [tool])
    const events: QueryEvent[] = []
    for await (const event of runQuery({
      ...context,
      limits: { ...context.limits, maxTokens: 100_000, maxProviderTokens: 100 },
    })) events.push(event)

    expect(events.at(-1)).toMatchObject({ type: 'run.exhausted', reason: 'max_tokens' })
    expect(events.find((event) => event.type === 'run.exhausted')).toMatchObject({ usage: { totalTokens: 122 } })
  })

  it('lets the model correct invalid generate_pptd arguments before the pipeline starts', async () => {
    const provider = makeMockProvider([
      [
        { type: 'tool_call_start', id: 'deck-invalid', name: 'generate_pptd' },
        { type: 'tool_call_end', id: 'deck-invalid', input: { brief: 'deck' } },
        { type: 'message_end', stopReason: 'tool_use' },
      ],
      [
        { type: 'tool_call_start', id: 'deck-valid', name: 'generate_pptd' },
        { type: 'tool_call_end', id: 'deck-valid', input: { brief: 'deck', attachmentIds: ['att-a'] } },
        { type: 'message_end', stopReason: 'tool_use' },
      ],
      finalTurn,
    ])
    let executions = 0
    const generator: Tool = {
      name: 'generate_pptd', description: 'generate',
      inputSchema: {
        type: 'object', required: ['brief', 'attachmentIds'],
        properties: {
          brief: { type: 'string' },
          attachmentIds: { type: 'array', items: { type: 'string', enum: ['att-a'] } },
        },
      },
      readOnly: true, concurrencySafe: false, destructive: false,
      requiresConfirmation: false, availability: 'always', permissions: [],
      async execute(): Promise<ToolResult> {
        executions++
        return { success: true, content: 'generated' }
      },
      renderCall: () => 'generate',
    }
    const events: QueryEvent[] = []
    for await (const event of runQuery(makeCtx(provider, [generator]))) events.push(event)

    expect(executions).toBe(1)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.completed',
      callId: 'deck-invalid',
      result: expect.objectContaining({ error: expect.objectContaining({ kind: 'invalid_input' }) }),
    }))
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  it('feeds capture results back as an image in the next model turn', async () => {
    const requests: CompletionRequest[] = []
    let turn = 0
    const provider: ModelProvider = {
      name: 'mock',
      metadata: {
        name: 'mock', displayName: 'Mock', supportsVision: true,
        supportsTools: true, supportsStreaming: true,
        defaultMaxTokens: 4096, models: ['mock-model'],
      },
      async *stream(request: CompletionRequest): AsyncGenerator<CompletionChunk> {
        requests.push(request)
        if (turn++ === 0) {
          yield { type: 'tool_call_start', id: 'preview-1', name: 'capture_preview' }
          yield { type: 'tool_call_end', id: 'preview-1', input: {} }
          yield { type: 'message_end', stopReason: 'tool_use' }
        } else {
          yield* finalTurn
        }
      },
    }
    const capture: Tool = {
      name: 'capture_preview', description: 'capture', inputSchema: { type: 'object' },
      readOnly: true, concurrencySafe: false, destructive: false,
      requiresConfirmation: false, availability: 'always', permissions: [],
      async execute(): Promise<ToolResult> {
        return {
          success: true,
          content: 'captured',
          data: { imageDataUrl: 'data:image/png;base64,cGl4ZWxz' },
        }
      },
      renderCall: () => 'capture',
    }

    for await (const _event of runQuery(makeCtx(provider, [capture]))) {
      // consume the run
    }

    expect(requests).toHaveLength(2)
    const lastMessage = requests[1].messages.at(-1)
    expect(lastMessage?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'preview-1' }),
      { type: 'image', url: 'data:image/png;base64,cGl4ZWxz' },
    ]))
  })

  it('exposes pagination metadata to the next model turn for handle reads', async () => {
    const requests: CompletionRequest[] = []
    const provider = makeMockProvider([
      [
        { type: 'tool_call_start', id: 'handle-1', name: 'read_handle' },
        { type: 'tool_call_end', id: 'handle-1', input: { handle: 'handle-1' } },
        { type: 'message_end', stopReason: 'tool_use' },
      ],
      finalTurn,
    ], requests)
    const reader: Tool = {
      name: 'read_handle', description: 'read handle', inputSchema: { type: 'object' },
      readOnly: true, concurrencySafe: true, destructive: false,
      requiresConfirmation: false, availability: 'always', permissions: [],
      async execute(): Promise<ToolResult> {
        return { success: true, content: 'page', data: { offset: 0, nextOffset: 4, total: 8 } }
      },
      renderCall: () => 'read',
    }

    for await (const _event of runQuery(makeCtx(provider, [reader]))) {
      // consume the run
    }

    const nextTurn = requests[1]
    const lastContent = nextTurn.messages.at(-1)?.content
    const toolResult = Array.isArray(lastContent)
      ? lastContent.find((part) => part.type === 'tool_result')
      : undefined
    expect(toolResult).toMatchObject({ content: expect.stringContaining('offset=4') })
  })

  it('does not append an attachment pagination instruction to a handleized result', async () => {
    const requests: CompletionRequest[] = []
    const provider = makeMockProvider([
      [
        { type: 'tool_call_start', id: 'large-page', name: 'read_attachment' },
        { type: 'tool_call_end', id: 'large-page', input: { attachmentId: 'att-a', offset: 0, limit: 8_000 } },
        { type: 'message_end', stopReason: 'tool_use' },
      ],
      finalTurn,
    ], requests)
    const reader: Tool = {
      name: 'read_attachment', description: 'read attachment', inputSchema: { type: 'object' },
      readOnly: true, concurrencySafe: true, destructive: false,
      requiresConfirmation: false, availability: 'always', permissions: [],
      async execute(): Promise<ToolResult> {
        return {
          success: true,
          content: '[Result stored as mem-large-page: 40000 bytes. Use read_handle to retrieve it.]',
          handle: 'mem-large-page',
          truncated: true,
          data: { attachmentId: 'att-a', offset: 0, nextOffset: 8_000, total: 20_000 },
        }
      },
      renderCall: () => 'read attachment',
    }
    const ctx = makeCtx(provider, [reader])
    for await (const _event of runQuery({
      ...ctx,
      attachments: [{ id: 'att-a', name: 'large.md', size: 20_000, text: 'x'.repeat(20_000) }],
      attachmentMode: 'retrieval',
    })) { /* drain */ }

    const lastContent = requests[1].messages.at(-1)?.content
    const toolResult = Array.isArray(lastContent)
      ? lastContent.find((part) => part.type === 'tool_result')
      : undefined
    expect(toolResult).toMatchObject({ content: expect.stringContaining('mem-large-page') })
    expect(JSON.stringify(toolResult)).not.toContain('[分页提示]')
    expect(JSON.stringify(toolResult)).not.toContain('read_attachment 并使用 offset=8000')
  })

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

  it('keeps a conversation-stable cache key and caches message history between tool rounds', async () => {
    const requests: CompletionRequest[] = []
    const trace: string[] = []
    const reader = makeSlowReadTool('reader', 1, trace)
    const toolTurn: CompletionChunk[] = [
      { type: 'tool_call_start', id: 'cache-read', name: 'reader' },
      { type: 'tool_call_end', id: 'cache-read', input: {} },
      { type: 'message_end', stopReason: 'tool_use' },
    ]
    const scripted = makeMockProvider([toolTurn, finalTurn], requests)
    const cacheProvider: ModelProvider = {
      ...scripted,
      metadata: { ...scripted.metadata, supportsPromptCache: true },
    }

    for await (const _event of runQuery(makeCtx(cacheProvider, [reader]))) {
      // drain
    }

    expect(requests).toHaveLength(2)
    expect(requests[0].promptCache?.messages).toBe(true)
    expect(requests[1].promptCache?.messages).toBe(true)
    expect(requests[0].promptCache?.key).toMatch(/^conversation-/)
    expect(requests[1].promptCache?.key).toBe(requests[0].promptCache?.key)
    expect(requests[1].tools?.map((tool) => tool.name)).toEqual(['reader'])
  })

  it('covers a 70K attachment in one parallel tool round plus the final model round', async () => {
    const text = '数'.repeat(70_000)
    const requests: CompletionRequest[] = []
    const reads: CompletionChunk[] = Array.from({ length: 9 }, (_, index) => [
      { type: 'tool_call_start' as const, id: `page-${index}`, name: 'read_attachment' },
      {
        type: 'tool_call_end' as const,
        id: `page-${index}`,
        input: { attachmentId: 'att-large', offset: index * 8_000, limit: 8_000 },
      },
    ]).flat()
    reads.push({ type: 'message_end', stopReason: 'tool_use' })
    const ctx = makeCtx(makeMockProvider([reads, finalTurn], requests), [readAttachmentTool as Tool])
    const events: QueryEvent[] = []
    for await (const event of runQuery({
      ...ctx,
      attachments: [{ id: 'att-large', name: 'large.md', size: text.length, text }],
      attachmentMode: 'retrieval',
      model: { ...ctx.model, contextWindow: 200_000 },
      limits: {
        ...ctx.limits,
        maxToolCalls: 20,
        toolLoopBudgets: {
          'attachment-retrieval': { maxCalls: 13, softThreshold: 3, hardThreshold: 5 },
          'attachment-retrieval:read': { maxCalls: 9, softThreshold: 3, hardThreshold: 5 },
        },
      },
    })) events.push(event)

    expect(requests).toHaveLength(2)
    expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(9)
    const secondPrompt = JSON.stringify(requests[1].messages)
    expect(secondPrompt).not.toContain('re-read if needed')
    expect(secondPrompt).not.toContain('Result stored as')
    expect(events.at(-1)?.type).toBe('run.completed')
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
    expect(unknown.result.content).not.toContain('reader')
    expect(unknown.result.content).toContain('current tool definitions')

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

  it('appends safety circuit breaker warning when same tool fails 3 consecutive times', async () => {
    const failingTool: Tool = {
      name: 'fail_tool',
      description: 'always fails',
      inputSchema: { type: 'object' },
      readOnly: true,
      concurrencySafe: true,
      destructive: false,
      requiresConfirmation: false,
      availability: 'always',
      permissions: [],
      async execute(): Promise<ToolResult> {
        return { success: false, content: 'failed to do work' }
      },
      renderCall: () => 'fail_tool',
    }

    const failTurn = (id: string): CompletionChunk[] => [
      { type: 'tool_call_start', id, name: 'fail_tool' },
      { type: 'tool_call_end', id, input: {} },
      { type: 'message_end', stopReason: 'tool_use' },
    ]

    const requests: CompletionRequest[] = []
    const ctx = makeCtx(
      makeMockProvider([failTurn('f1'), failTurn('f2'), failTurn('f3'), finalTurn], requests),
      [failingTool],
    )

    const events: QueryEvent[] = []
    for await (const ev of runQuery(ctx)) events.push(ev)

    expect(events.filter((e) => e.type === 'tool.completed')).toHaveLength(3)
    expect(events.at(-1)?.type).toBe('run.completed')

    // The warning has to reach the model, so assert on what the provider was
    // actually sent: silent until the third consecutive failure, then present.
    const sent = requests.map((request) => JSON.stringify(request.messages))
    expect(sent).toHaveLength(4)
    expect(sent[1]).not.toContain('安全熔断')
    expect(sent[2]).not.toContain('安全熔断')
    expect(sent[3]).toContain('安全熔断')
    expect(sent[3]).toContain('fail_tool')
  })

  it('does not count loop_detected guidance as an execution failure streak', async () => {
    let executions = 0
    const loopAwareTool: Tool = {
      name: 'loop_aware_read',
      description: 'reports a repeated page',
      inputSchema: { type: 'object' },
      readOnly: true,
      concurrencySafe: false,
      destructive: false,
      requiresConfirmation: false,
      availability: 'always',
      permissions: [],
      async execute(): Promise<ToolResult> {
        executions++
        return {
          success: false,
          content: '不要重复读取同一页，请继续下一页。',
          error: { kind: 'loop_detected', message: 'duplicate page', recoverable: true },
        }
      },
      renderCall: () => 'loop-aware read',
    }
    const repeatedTurn = (id: string): CompletionChunk[] => [
      { type: 'tool_call_start', id, name: 'loop_aware_read' },
      { type: 'tool_call_end', id, input: { id } },
      { type: 'message_end', stopReason: 'tool_use' },
    ]
    const requests: CompletionRequest[] = []
    const ctx = makeCtx(makeMockProvider([
      repeatedTurn('loop-1'),
      repeatedTurn('loop-2'),
      repeatedTurn('loop-3'),
      repeatedTurn('loop-4'),
      finalTurn,
    ], requests), [loopAwareTool])

    const events: QueryEvent[] = []
    for await (const event of runQuery(ctx)) events.push(event)

    expect(executions).toBe(4)
    expect(requests).toHaveLength(5)
    expect(JSON.stringify(requests)).not.toContain('安全熔断')
    expect(events.some((event) => event.type === 'run.failed')).toBe(false)
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  it('resets the failure streak once the tool succeeds again', async () => {
    let attempt = 0
    const flakyTool: Tool = {
      name: 'flaky_tool',
      description: 'fails, then succeeds, then fails',
      inputSchema: { type: 'object' },
      readOnly: true,
      concurrencySafe: true,
      destructive: false,
      requiresConfirmation: false,
      availability: 'always',
      permissions: [],
      async execute(): Promise<ToolResult> {
        attempt++
        return attempt === 2
          ? { success: true, content: 'recovered' }
          : { success: false, content: 'failed to do work' }
      },
      renderCall: () => 'flaky_tool',
    }

    const callTurn = (id: string): CompletionChunk[] => [
      { type: 'tool_call_start', id, name: 'flaky_tool' },
      { type: 'tool_call_end', id, input: {} },
      { type: 'message_end', stopReason: 'tool_use' },
    ]

    const requests: CompletionRequest[] = []
    const ctx = makeCtx(
      makeMockProvider([callTurn('k1'), callTurn('k2'), callTurn('k3'), callTurn('k4'), finalTurn], requests),
      [flakyTool],
    )

    for await (const _ev of runQuery(ctx)) { /* drain */ }

    // fail, succeed, fail, fail — the streak restarts at the success, so two
    // later failures must not trip a breaker meant for three in a row.
    expect(requests.every((request) => !JSON.stringify(request.messages).includes('安全熔断'))).toBe(true)
  })

  it('compacts and retries a reasoning-only turn without exposing deliberation', async () => {
    // Reproduces the ledger from the drawio run: the turn came back with
    // text:"", toolCalls:[], outputTokens:8192, stopReason:"max_tokens". The
    // old code ended it as run.exhausted/max_tokens, which said nothing useful.
    let calls = 0
    const systems: string[] = []
    const privateReasoning = '思考架构分层'.repeat(50)
    const provider: ModelProvider = {
      ...makeMockProvider([]),
      async *stream(request): AsyncGenerator<CompletionChunk> {
        calls++
        systems.push(request.system ?? '')
        yield { type: 'message_start' }
        yield { type: 'reasoning_delta', delta: privateReasoning }
        yield {
          type: 'message_end',
          usage: { inputTokens: 17_079, outputTokens: 8_192, totalTokens: 25_271 },
          stopReason: 'max_tokens',
        }
      },
    }

    const events: QueryEvent[] = []
    for await (const event of runQuery(makeCtx(provider, []))) events.push(event)

    // The engine retries once with compact input. Reasoning is represented only
    // by aggregate progress and never enters the answer/event payload.
    expect(calls).toBe(2)
    expect(systems[0]).not.toContain('previous model turn')
    expect(systems[1]).toContain('previous model turn')
    expect(events.some((event) => event.type === 'message.delta')).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({ type: 'model.progress', phase: 'reasoning' }))
    expect(JSON.stringify(events)).not.toContain(privateReasoning)
    expect(events.at(-1)).toMatchObject({
      type: 'run.exhausted',
      reason: 'max_output_tokens',
    })
  })

  it('keeps a Draw.io reasoning-only recovery in generation mode instead of reopening retrieval', async () => {
    const requests: CompletionRequest[] = []
    const thoughtOnly: CompletionChunk[] = [
      { type: 'reasoning_delta', delta: '内部规划'.repeat(100) },
      {
        type: 'message_end',
        usage: { inputTokens: 10_457, outputTokens: 8_192, totalTokens: 18_649 },
        stopReason: 'max_tokens',
      },
    ]
    const reader = makeSlowReadTool('read_attachment', 1, [])
    const base = makeCtx(makeMockProvider([thoughtOnly, drawioFinalTurn], requests), [reader])
    const events: QueryEvent[] = []
    for await (const event of runQuery({
      ...base,
      model: { ...base.model, model: 'qwen3.8' },
      attachments: [{ id: 'att-a', name: 'large.md', size: 40_000, text: 'evidence' }],
      attachmentMode: 'retrieval',
      skill: {
        metadata: { name: 'drawio-diagram', version: '2.1.0', description: 'Draw.io diagram' },
        content: 'Return one Draw.io Artifact.',
        path: 'builtin://drawio-diagram/SKILL.md',
      },
    })) events.push(event)

    expect(requests).toHaveLength(2)
    expect(requests[0].tools?.map((tool) => tool.name)).toEqual(['read_attachment'])
    expect(requests[0]).not.toHaveProperty('reasoningMode')
    expect(requests[1].tools).toBeUndefined()
    expect(requests[1]).toMatchObject({ toolChoice: 'none' })
    expect(requests[1]).not.toHaveProperty('reasoningMode')
    expect(events.filter((event) => event.type === 'tool.requested')).toHaveLength(0)
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  it('still continues a truncated turn that produced real text alongside reasoning', async () => {
    let call = 0
    const provider: ModelProvider = {
      ...makeMockProvider([]),
      async *stream(): AsyncGenerator<CompletionChunk> {
        call++
        yield { type: 'message_start' }
        if (call === 1) {
          yield { type: 'reasoning_delta', delta: '先想一下' }
          yield { type: 'content_delta', delta: '前半段' }
          yield { type: 'message_end', stopReason: 'max_tokens' }
          return
        }
        yield { type: 'content_delta', delta: '后半段' }
        yield { type: 'message_end', stopReason: 'end_turn' }
      },
    }

    const events: QueryEvent[] = []
    for await (const event of runQuery(makeCtx(provider, []))) events.push(event)

    // Reasoning next to real text must not block the existing continuation.
    expect(call).toBe(2)
    expect(events.at(-1)?.type).toBe('run.completed')
  })
})
