import { describe, expect, it } from 'vitest'
import { providerBaseURL } from './provider-url'

describe('providerBaseURL', () => {
  it('removes the OpenAI chat completion endpoint and keeps /v1', () => {
    expect(providerBaseURL('https://api.deepseek.com/v1/chat/completions', 'openai'))
      .toBe('https://api.deepseek.com/v1')
  })

  it('removes the Anthropic messages endpoint', () => {
    expect(providerBaseURL('https://api.anthropic.com/v1/messages', 'anthropic'))
      .toBe('https://api.anthropic.com')
  })

  it('preserves custom base paths and strips query data', () => {
    expect(providerBaseURL('https://proxy.example/api/chat/completions?key=secret', 'openai'))
      .toBe('https://proxy.example/api')
  })

  it('uses the SDK default for an empty endpoint', () => {
    expect(providerBaseURL('  ', 'openai')).toBeUndefined()
  })
})
