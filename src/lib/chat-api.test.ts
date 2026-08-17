import { describe, expect, it } from 'vitest'
import { normalizeProviderEndpoint } from './chat-api'

describe('model provider endpoint', () => {
  it('completes an OpenAI-compatible root or v1 URL', () => {
    expect(normalizeProviderEndpoint('https://example.com', 'openai'))
      .toBe('https://example.com/v1/chat/completions')
    expect(normalizeProviderEndpoint('https://example.com/v1', 'openai'))
      .toBe('https://example.com/v1/chat/completions')
  })

  it('completes an Anthropic-compatible root URL', () => {
    expect(normalizeProviderEndpoint('https://example.com/', 'anthropic'))
      .toBe('https://example.com/v1/messages')
  })

  it('preserves an explicit endpoint', () => {
    expect(normalizeProviderEndpoint('https://example.com/custom/chat', 'openai'))
      .toBe('https://example.com/custom/chat')
  })
})
