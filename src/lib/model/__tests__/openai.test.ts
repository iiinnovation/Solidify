/**
 * OpenAI Provider tests
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { OpenAIProvider } from '../openai'
import type { CompletionRequest } from '../types'

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

    // Access private method for testing (we'll make it work via type assertion)
    const convertedMessages = (provider as any).convertMessages(request.messages)
    expect(convertedMessages).toHaveLength(1)
    expect(convertedMessages[0].role).toBe('user')
    expect(convertedMessages[0].content).toBe('Hello')
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

    const convertedMessages = (provider as any).convertMessages(request.messages)
    expect(convertedMessages[0].content).toHaveLength(2)
  })

  it('should convert tools correctly', () => {
    const tools = [
      {
        name: 'get_weather',
        description: 'Get weather information',
        inputSchema: {
          type: 'object',
          properties: {
            location: { type: 'string' },
          },
          required: ['location'],
        },
      },
    ]

    const convertedTools = (provider as any).convertTools(tools)
    expect(convertedTools).toHaveLength(1)
    expect(convertedTools[0].type).toBe('function')
    expect(convertedTools[0].function.name).toBe('get_weather')
  })
})
