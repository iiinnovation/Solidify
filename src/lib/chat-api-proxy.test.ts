import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelProvider } from '@/stores/model-store'

afterEach(() => {
  vi.doUnmock('@supabase/supabase-js')
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('model provider proxy', () => {
  it('relays the SDK-resolved endpoint and native request body through Supabase', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://solidify.example')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    const createClient = vi.fn(() => ({
      auth: { getSession: async () => ({ data: { session: { access_token: 'session-token' } } }) },
    }))
    vi.doMock('@supabase/supabase-js', () => ({
      createClient,
    }))
    const upstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('stream'))
    vi.stubGlobal('fetch', upstream)

    const { createModelProviderFetch } = await import('./chat-api')
    const provider: ModelProvider = {
      id: 'provider-1',
      name: 'OpenAI compatible',
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'provider-key',
      modelId: 'model-1',
      format: 'openai',
      enabled: true,
    }
    const proxyFetch = createModelProviderFetch(provider)
    const targetUrl = 'https://api.example.com/v1/chat/completions'
    const request = (stream: boolean) => proxyFetch!(targetUrl, {
      method: 'POST',
      body: JSON.stringify({ model: 'model-1', messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function' }], stream }),
      signal: new AbortController().signal,
    })
    await request(true)
    await request(false)

    expect(createClient).toHaveBeenCalledOnce()
    expect(upstream).toHaveBeenCalledTimes(2)
    const [url, init] = upstream.mock.calls[0]
    expect(url).toBe('https://solidify.example/functions/v1/chat')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      targetUrl,
      provider: { apiKey: 'provider-key', modelId: 'model-1', format: 'openai' },
      nativeBody: { model: 'model-1', messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function' }], stream: true },
    })
    expect(JSON.parse(String(upstream.mock.calls[1][1]?.body)).nativeBody.stream).toBe(false)
  })
})
