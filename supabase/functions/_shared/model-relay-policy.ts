export type RelayApiFormat = 'openai' | 'anthropic'

/** Exact official hosts supported by Solidify's recognized model families. */
export const DEFAULT_RELAY_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'api.deepseek.com',
  'dashscope.aliyuncs.com',
  'dashscope-intl.aliyuncs.com',
  'dashscope-us.aliyuncs.com',
  'coding.dashscope.aliyuncs.com',
  'open.bigmodel.cn',
  'api.moonshot.cn',
] as const

const NATIVE_BODY_KEYS: Record<RelayApiFormat, readonly string[]> = {
  openai: [
    'messages',
    'tools',
    'temperature',
    'max_tokens',
    'stream',
    'stream_options',
  ],
  anthropic: [
    'system',
    'messages',
    'tools',
    'max_tokens',
    'temperature',
    'top_p',
    'stream',
  ],
}

export function buildRelayHostAllowlist(configuredHosts = ''): ReadonlySet<string> {
  return new Set([
    ...DEFAULT_RELAY_HOSTS,
    ...configuredHosts
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  ])
}

/** Validate the exact upstream destination before attaching a provider API key. */
export function parseRelayTarget(
  rawUrl: string,
  format: RelayApiFormat,
  allowedHosts: ReadonlySet<string>,
): URL {
  if (format !== 'openai' && format !== 'anthropic') throw new Error('不支持的 Provider 格式')

  let endpoint: URL
  try {
    endpoint = new URL(rawUrl)
  } catch {
    throw new Error('模型 API URL 必须是有效的 https 地址')
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    throw new Error('模型 API URL 必须使用不含凭据的 https:// 地址')
  }
  if (!allowedHosts.has(endpoint.hostname.toLowerCase())) {
    throw new Error(`模型服务主机未获准代理：${endpoint.hostname}`)
  }

  const path = endpoint.pathname.replace(/\/+$/, '')
  const expectedPath = format === 'openai' ? /\/chat\/completions$/ : /\/v1\/messages$/
  if (!expectedPath.test(path)) throw new Error(`模型 API 路径与 ${format} 格式不匹配`)
  return endpoint
}

/**
 * Rebuild the SDK body from the subset used by Solidify's adapters. Model and
 * accepted fields are server-owned, so this cannot become an arbitrary JSON
 * relay. Stream remains request-specific to support SDK validation calls.
 */
export function buildNativeRequestBody(
  nativeBody: Record<string, unknown>,
  modelId: string,
  format: RelayApiFormat,
): Record<string, unknown> {
  if (format !== 'openai' && format !== 'anthropic') throw new Error('不支持的 Provider 格式')
  if (!Array.isArray(nativeBody.messages) || nativeBody.messages.length === 0) {
    throw new Error('模型请求必须包含非空 messages 数组')
  }
  if (nativeBody.tools !== undefined && !Array.isArray(nativeBody.tools)) {
    throw new Error('模型请求的 tools 必须是数组')
  }
  if (nativeBody.stream !== undefined && typeof nativeBody.stream !== 'boolean') {
    throw new Error('模型请求的 stream 必须是布尔值')
  }

  const body: Record<string, unknown> = {}
  for (const key of NATIVE_BODY_KEYS[format]) {
    if (Object.hasOwn(nativeBody, key)) body[key] = nativeBody[key]
  }
  body.model = modelId
  body.stream = nativeBody.stream === true
  return body
}

/** The relay must never follow an allowlisted host's redirect to another host. */
export function buildNativeRelayRequestInit(
  apiKey: string,
  format: RelayApiFormat,
  body: Record<string, unknown>,
): RequestInit {
  return {
    method: 'POST',
    redirect: 'manual',
    headers: format === 'openai'
      ? { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
      : { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}
