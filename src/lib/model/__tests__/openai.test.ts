/**
 * OpenAI Provider tests
 */

import { describe, it, expect, beforeEach } from 'vitest'
import OpenAI from 'openai'
import { OpenAIProvider } from '../openai'
import { AnthropicProvider } from '../anthropic'
import { ProviderTransportError } from '../provider-transport'
import type { CompletionRequest, ToolDefinition } from '../types'

function installStream(provider: OpenAIProvider, chunks: unknown[]) {
  async function* stream() {
    yield* chunks
  }
  Object.defineProperty(provider, 'client', {
    value: {
      chat: {
        completions: {
          create: async () => stream(),
        },
      },
    },
  })
}

async function collectStream(provider: OpenAIProvider) {
  const events = []
  for await (const event of provider.stream({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
  })) {
    events.push(event)
  }
  return events
}

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider

  beforeEach(() => {
    provider = new OpenAIProvider({
      apiKey: 'test-key',
      timeout: 30000,
    })
  })

  it('should have correct metadata', () => {
    expect(provider.name).toBe('openai')
    expect(provider.metadata.displayName).toBe('OpenAI')
    expect(provider.metadata.supportsVision).toBe(true)
    expect(provider.metadata.supportsTools).toBe(true)
    expect(provider.metadata.supportsStreaming).toBe(true)
    expect(provider.metadata.defaultMaxTokens).toBe(4096)
  })

  it('honors an explicit no-tools capability declaration', () => {
    const textOnly = new OpenAIProvider({ apiKey: 'test-key', supportsTools: false })
    expect(textOnly.metadata.supportsTools).toBe(false)
    expect(new AnthropicProvider({ apiKey: 'test-key', supportsTools: false })
      .metadata.supportsTools).toBe(false)
  })

  it('should list available models', async () => {
    const models = await provider.listModels()
    expect(models).toContain('gpt-4-turbo')
    expect(models).toContain('gpt-3.5-turbo')
    expect(models).toContain('o1-preview')
  })

  it('surfaces a browser transport diagnostic wrapped by the SDK', async () => {
    const diagnostic = '无法连接模型服务。浏览器可能拦截了跨域请求（CORS）'
    Object.defineProperty(provider, 'client', {
      value: {
        chat: { completions: { create: async () => { throw new Error('Connection error.', { cause: new ProviderTransportError(diagnostic) }) } } },
      },
    })

    const events = await collectStream(provider)
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'network', type: 'network', message: diagnostic },
    })
  })

  it('marks gateway 5xx HTML responses as retryable upstream failures', async () => {
    const gateway = new OpenAI.APIError(504, undefined, '<html>Gateway time-out</html>', undefined)
    Object.defineProperty(provider, 'client', {
      value: {
        chat: { completions: { create: async () => { throw gateway } } },
      },
    })

    const events = await collectStream(provider)
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { code: '504', type: 'api_error', retryable: true },
    })
  })

  it('should convert messages correctly', () => {
    const request: CompletionRequest = {
      model: 'gpt-4-turbo',
      system: 'You are a helpful assistant',
      messages: [
        {
          role: 'user',
          content: 'Hello',
        },
      ],
      stream: true,
    }

    // Access public method for testing
    const convertedMessages = provider.convertMessages(request.messages)
    expect(convertedMessages).toHaveLength(1)
    expect(convertedMessages[0]).toHaveProperty('role', 'user')
    expect(convertedMessages[0]).toHaveProperty('content', 'Hello')
  })

  it('should handle multi-modal content', () => {
    const request: CompletionRequest = {
      model: 'gpt-4-turbo',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image', url: 'https://example.com/image.jpg' },
          ],
        },
      ],
      stream: true,
    }

    const convertedMessages = provider.convertMessages(request.messages)
    expect(Array.isArray(convertedMessages[0].content)).toBe(true)
    expect((convertedMessages[0].content as unknown[]).length).toBe(2)
  })

  it('preserves tool call/result pairing and the preview image', () => {
    const converted = provider.convertMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'call-1', name: 'capture_preview', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call-1', content: 'captured' },
          { type: 'image', url: 'data:image/png;base64,cGl4ZWxz' },
        ],
      },
    ])

    expect(converted).toHaveLength(3)
    expect(converted[0]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call-1', function: { name: 'capture_preview', arguments: '{}' } }],
    })
    expect(converted[1]).toEqual({ role: 'tool', tool_call_id: 'call-1', content: 'captured' })
    expect(converted[2]).toMatchObject({ role: 'user' })
    expect(converted[2].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,cGl4ZWxz' } },
    ])
  })

  it('should convert tools correctly', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'get_weather',
        description: 'Get weather information',
        inputSchema: {
          type: 'object' as const,
          properties: {
            location: { type: 'string' as const },
          },
          required: ['location'],
        },
      },
    ]

    const convertedTools = provider.convertTools(tools)
    expect(convertedTools).toHaveLength(1)
    expect(convertedTools[0]).toHaveProperty('type', 'function')

    // Type guard for function tool
    if ('function' in convertedTools[0]) {
      expect(convertedTools[0].function).toHaveProperty('name', 'get_weather')
    }
  })

  it('keeps usage from the choices-empty trailing chunk', async () => {
    installStream(provider, [
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      {
        choices: [],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      },
    ])

    const events = await collectStream(provider)
    expect(events.at(-1)).toEqual({
      type: 'message_end',
      usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
      stopReason: 'end_turn',
    })
  })

  it('maps finish_reason length to max_tokens', async () => {
    installStream(provider, [
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ])

    const events = await collectStream(provider)
    expect(events.at(-1)).toEqual({
      type: 'message_end',
      usage: undefined,
      stopReason: 'max_tokens',
    })
  })

  it('converts array content without duplicate push', () => {
    const converted = provider.convertMessages([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ])
    expect(converted).toHaveLength(1)
    expect(converted[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    })
  })

  it('passes the stable prefix key to OpenAI-compatible prompt caching', async () => {
    let captured: unknown
    async function* response() {
      yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }
      yield { choices: [], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }
    }
    Object.defineProperty(provider, 'client', {
      value: {
        chat: {
          completions: {
            create: async (params: unknown) => {
              captured = params
              return response()
            },
          },
        },
      },
    })

    for await (const _event of provider.stream({
      model: 'test-model',
      system: 'stable system',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      promptCache: { key: 'ctx-test', system: true, tools: false },
    })) { /* drain */ }

    expect(captured).toMatchObject({ prompt_cache_key: 'ctx-test' })
  })

  it('emits tool_call_end even if finish_reason is stop or missing', async () => {
    installStream(provider, [
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call-1',
              function: { name: 'search', arguments: '{"q":"test"}' },
            }],
          },
          finish_reason: 'stop',
        }],
      },
    ])

    const events = await collectStream(provider)
    expect(events.map((e) => e.type)).toContain('tool_call_start')
    expect(events.map((e) => e.type)).toContain('tool_call_end')
    const endEvent = events.find((e) => e.type === 'tool_call_end')
    expect(endEvent).toMatchObject({
      type: 'tool_call_end',
      id: 'call-1',
      input: { q: 'test' },
    })
    expect(events.at(-1)).toMatchObject({
      type: 'message_end',
      stopReason: 'tool_use',
    })
  })

  it('retains max_tokens stopReason when finish_reason is length even with tool calls', async () => {
    installStream(provider, [
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call-truncated',
              function: { name: 'gen', arguments: '{"partial":' },
            }],
          },
          finish_reason: 'length',
        }],
      },
    ])

    const events = await collectStream(provider)
    expect(events.at(-1)).toMatchObject({
      type: 'message_end',
      stopReason: 'max_tokens',
    })
  })

  it('yields timeout error when stream stalls beyond stallTimeoutMs and triggers abort', async () => {
    let aborted = false
    async function* stalledStream() {
      yield { choices: [{ delta: { content: 'chunk1' } }] }
      // Stall for longer than stallTimeoutMs
      await new Promise((resolve) => setTimeout(resolve, 50))
      yield { choices: [{ delta: { content: 'chunk2' } }] }
    }
    Object.defineProperty(provider, 'client', {
      value: {
        chat: {
          completions: {
            create: async (_params: unknown, options?: { signal?: AbortSignal }) => {
              options?.signal?.addEventListener('abort', () => { aborted = true })
              return stalledStream()
            },
          },
        },
      },
    })

    const events = []
    for await (const event of provider.stream({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      stallTimeoutMs: 20, // 20ms stall timeout for test
    })) {
      events.push(event)
    }

    expect(events[0]).toEqual({ type: 'content_delta', delta: 'chunk1' })
    const errorEvent = events.find((e) => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect(errorEvent).toMatchObject({
      type: 'error',
      error: {
        code: 'timeout',
        type: 'timeout',
        retryable: true,
      },
    })
    expect(aborted).toBe(true)
  })

  it('surfaces reasoning deltas that arrive beside empty content', async () => {
    // DeepSeek spent a whole 8k output window on reasoning_content while
    // delta.content stayed empty, so the run saw a turn that "returned nothing".
    installStream(provider, [
      { choices: [{ delta: { content: null, reasoning_content: '先分析架构层次' } }] },
      { choices: [{ delta: { reasoning_content: '再确定节点关系' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ])

    const events = await collectStream(provider)
    expect(events.filter((event) => event.type === 'reasoning_delta')).toEqual([
      { type: 'reasoning_delta', delta: '先分析架构层次' },
      { type: 'reasoning_delta', delta: '再确定节点关系' },
    ])
    expect(events.some((event) => event.type === 'content_delta')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'message_end', stopReason: 'max_tokens' })
  })

  it('reads the alternative reasoning field used by proxy gateways', async () => {
    installStream(provider, [
      { choices: [{ delta: { reasoning: 'OpenRouter 风格字段' } }] },
      { choices: [{ delta: { content: '正文' }, finish_reason: 'stop' }] },
    ])

    const events = await collectStream(provider)
    expect(events).toContainEqual({ type: 'reasoning_delta', delta: 'OpenRouter 风格字段' })
    expect(events).toContainEqual({ type: 'content_delta', delta: '正文' })
  })
})
