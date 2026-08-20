import { describe, expect, it } from 'vitest'
import { normalizeProviderEndpoint, providerBaseURL } from './provider-url'

describe('providerBaseURL', () => {
  it('removes the OpenAI chat completion endpoint and keeps /v1', () => {
    expect(providerBaseURL('https://api.deepseek.com/v1/chat/completions', 'openai'))
      .toBe('https://api.deepseek.com/v1')
  })

  it('removes the Anthropic messages endpoint', () => {
    expect(providerBaseURL('https://api.anthropic.com/v1/messages', 'anthropic'))
      .toBe('https://api.anthropic.com')
  })

  it('adds the standard OpenAI v1 base path to a bare origin', () => {
    expect(providerBaseURL('https://proxy.example/', 'openai'))
      .toBe('https://proxy.example/v1')
  })

  it('keeps an explicit OpenAI v1 base path', () => {
    expect(providerBaseURL('https://proxy.example/v1', 'openai'))
      .toBe('https://proxy.example/v1')
  })

  it('preserves custom base paths and strips query data', () => {
    expect(providerBaseURL('https://proxy.example/api/chat/completions?key=secret', 'openai'))
      .toBe('https://proxy.example/api')
  })

  it('rejects an empty endpoint with an actionable error', () => {
    expect(() => providerBaseURL('  ', 'openai')).toThrow('模型 API URL 不能为空')
  })

  it('rejects malformed and non-http endpoints', () => {
    expect(() => normalizeProviderEndpoint('not a URL', 'openai'))
      .toThrow('模型 API URL 无效')
    expect(() => normalizeProviderEndpoint('ftp://models.example/v1', 'openai'))
      .toThrow('必须使用 http:// 或 https://')
  })

  it('normalizes standard endpoint paths before deriving the SDK base URL', () => {
    expect(normalizeProviderEndpoint('https://proxy.example/v1', 'openai'))
      .toBe('https://proxy.example/v1/chat/completions')
    expect(normalizeProviderEndpoint('https://proxy.example/v1', 'anthropic'))
      .toBe('https://proxy.example/v1/messages')
  })
})
