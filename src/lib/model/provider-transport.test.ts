import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDirectProviderFetch,
  formatProviderFetchError,
  providerTransportErrorMessage,
} from './provider-transport'

afterEach(() => vi.unstubAllGlobals())

describe('provider transport diagnostics', () => {
  it('explains likely CORS failures for cross-origin model endpoints', () => {
    const error = formatProviderFetchError(new TypeError('Failed to fetch'), 'https://models.example/v1/chat/completions')

    expect(error?.message).toContain('跨域请求（CORS）')
    expect(error?.message).toContain('Access-Control-Allow-Origin')
  })

  it('survives SDK-style connection-error wrapping', () => {
    const diagnostic = formatProviderFetchError(new TypeError('Load failed'), 'https://models.example/v1/messages')!
    const wrapped = new Error('Connection error.', { cause: diagnostic })

    expect(providerTransportErrorMessage(wrapped)).toBe(diagnostic.message)
  })

  it('does not relabel an unrelated programming TypeError as CORS', () => {
    expect(formatProviderFetchError(
      new TypeError("Cannot read properties of undefined (reading 'map')"),
      'https://models.example/v1/chat/completions',
    )).toBeNull()
  })

  it('wraps a direct browser fetch failure with the actionable diagnostic', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))

    await expect(createDirectProviderFetch()('https://models.example/v1/chat/completions'))
      .rejects.toThrow('CORS')
  })
})
