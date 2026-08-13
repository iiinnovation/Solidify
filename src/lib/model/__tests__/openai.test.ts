/**
 * OpenAI Provider tests
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { OpenAIProvider } from '../openai'
import { AnthropicProvider } from '../anthropic'
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
})
