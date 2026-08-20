import { describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../anthropic'
import { ProviderTransportError } from '../provider-transport'

describe('AnthropicProvider', () => {
  const provider = new AnthropicProvider({
    apiKey: 'test-key',
    baseURL: 'https://api.anthropic.com',
  })

  it('surfaces a browser transport diagnostic wrapped by the SDK', async () => {
    const localProvider = new AnthropicProvider({ apiKey: 'test-key' })
    const diagnostic = '无法连接模型服务。浏览器可能拦截了跨域请求（CORS）'
    Object.defineProperty(localProvider, 'client', {
      value: {
        messages: { create: async () => { throw new Error('Connection error.', { cause: new ProviderTransportError(diagnostic) }) } },
      },
    })

    const events = []
    for await (const event of localProvider.stream({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    })) events.push(event)

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'network', type: 'network', message: diagnostic },
    })
  })

  it('yields timeout error when stream stalls beyond stallTimeoutMs and triggers abort', async () => {
    let aborted = false
    async function* stalledStream() {
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'chunk1' } }
      // Stall for longer than stallTimeoutMs
      await new Promise((resolve) => setTimeout(resolve, 50))
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'chunk2' } }
    }

    Object.defineProperty(provider, 'client', {
      value: {
        messages: {
          create: async (_params: unknown, options?: { signal?: AbortSignal }) => {
            options?.signal?.addEventListener('abort', () => { aborted = true })
            return stalledStream()
          },
        },
      },
    })

    const events = []
    for await (const event of provider.stream({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      stallTimeoutMs: 20,
    })) {
      events.push(event)
    }

    expect(events.map((e) => e.type)).toContain('content_delta')
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
})
