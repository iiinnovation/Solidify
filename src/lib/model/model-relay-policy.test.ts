import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RELAY_HOSTS,
  buildNativeRelayRequestInit,
  buildNativeRequestBody,
  buildRelayHostAllowlist,
  parseRelayTarget,
  type RelayApiFormat,
} from '../../../supabase/functions/_shared/model-relay-policy'

describe('model relay target policy', () => {
  const allowedHosts = buildRelayHostAllowlist('models.example.com')

  it('includes every official host supported by the recognized model families', () => {
    expect(DEFAULT_RELAY_HOSTS).toEqual(expect.arrayContaining([
      'api.openai.com',
      'api.anthropic.com',
      'api.deepseek.com',
      'dashscope.aliyuncs.com',
      'dashscope-intl.aliyuncs.com',
      'dashscope-us.aliyuncs.com',
      'coding.dashscope.aliyuncs.com',
      'open.bigmodel.cn',
      'api.moonshot.cn',
    ]))
  })

  it.each([
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    'https://api.moonshot.cn/v1/chat/completions',
  ])('accepts a recognized model family official endpoint: %s', (url) => {
    expect(parseRelayTarget(url, 'openai', allowedHosts).protocol).toBe('https:')
  })

  it('accepts exact allowlisted hosts and the expected provider path', () => {
    expect(parseRelayTarget(
      'https://models.example.com/openai/v1/chat/completions?region=cn',
      'openai',
      allowedHosts,
    ).hostname).toBe('models.example.com')
    expect(parseRelayTarget(
      'https://api.anthropic.com/v1/messages',
      'anthropic',
      allowedHosts,
    ).pathname).toBe('/v1/messages')
  })

  it.each([
    ['http://api.openai.com/v1/chat/completions', 'openai', 'https://'],
    ['https://user:secret@api.openai.com/v1/chat/completions', 'openai', '不含凭据'],
    ['https://127.0.0.1/v1/chat/completions', 'openai', '主机未获准'],
    ['https://api.openai.com.evil.example/v1/chat/completions', 'openai', '主机未获准'],
    ['https://api.openai.com/v1/files', 'openai', '路径与 openai 格式不匹配'],
    ['https://api.anthropic.com/v1/messages', 'openai', '路径与 openai 格式不匹配'],
    ['https://api.openai.com/v1/chat/completions', 'anthropic', '路径与 anthropic 格式不匹配'],
  ])('rejects unsafe or mismatched target %s', (url, format, message) => {
    expect(() => parseRelayTarget(url, format as RelayApiFormat, allowedHosts)).toThrow(message)
  })

  it('normalizes configured hosts without allowing their subdomains', () => {
    const configured = buildRelayHostAllowlist(' Models.Example.COM , api.partner.test ')
    expect(configured.has('models.example.com')).toBe(true)
    expect(configured.has('api.partner.test')).toBe(true)
    expect(configured.has('child.models.example.com')).toBe(false)
  })
})

describe('native provider request policy', () => {
  const messages = [{ role: 'user', content: 'hello' }]

  it('keeps only OpenAI fields used by Solidify and overwrites client-owned model data', () => {
    const body = buildNativeRequestBody({
      model: 'attacker-model',
      messages,
      tools: [],
      temperature: 0.2,
      max_tokens: 123,
      stream: true,
      stream_options: { include_usage: true },
      arbitrary_url: 'https://internal.example',
      metadata: { admin: true },
    }, 'server-model', 'openai')

    expect(body).toEqual({
      messages,
      tools: [],
      temperature: 0.2,
      max_tokens: 123,
      stream: true,
      stream_options: { include_usage: true },
      model: 'server-model',
    })
    expect(body).not.toHaveProperty('arbitrary_url')
    expect(body).not.toHaveProperty('metadata')
  })

  it('preserves Anthropic fields and defaults omitted stream to false', () => {
    expect(buildNativeRequestBody({
      system: 'system',
      messages,
      top_p: 0.9,
      ignored: true,
    }, 'claude-model', 'anthropic')).toEqual({
      system: 'system',
      messages,
      top_p: 0.9,
      model: 'claude-model',
      stream: false,
    })
  })

  it.each([
    [{}, 'openai', '非空 messages 数组'],
    [{ messages: [] }, 'openai', '非空 messages 数组'],
    [{ messages, tools: {} }, 'openai', 'tools 必须是数组'],
    [{ messages, stream: 'true' }, 'openai', 'stream 必须是布尔值'],
  ])('rejects malformed native body %#', (body, format, message) => {
    expect(() => buildNativeRequestBody(body, 'model', format as RelayApiFormat)).toThrow(message)
  })

  it('builds a manual-redirect request so an allowed host cannot redirect the API key', () => {
    const init = buildNativeRelayRequestInit('secret-key', 'openai', { messages, model: 'model', stream: true })

    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' })
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret-key')
    expect(JSON.parse(String(init.body))).toEqual({ messages, model: 'model', stream: true })
  })
})
