import type { ApiFormat } from '@/stores/model-store'

/** Validate and normalize the endpoint accepted by the model settings UI. */
export function normalizeProviderEndpoint(apiUrl: string, format: ApiFormat): string {
  const value = apiUrl.trim()
  if (!value) throw new Error('模型 API URL 不能为空')

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('模型 API URL 无效，请填写完整的 http(s) 地址')
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error('模型 API URL 必须使用 http:// 或 https://')
  }

  const path = url.pathname.replace(/\/+$/, '')
  if (!path || path === '/v1') {
    url.pathname = format === 'openai' ? '/v1/chat/completions' : '/v1/messages'
  }
  return url.toString()
}

/** Convert a validated full endpoint into the base URL expected by the SDK. */
export function providerBaseURL(apiUrl: string, format: ApiFormat): string {
  const normalized = normalizeProviderEndpoint(apiUrl, format)

  const suffix = format === 'anthropic' ? /\/v1\/messages\/?$/ : /\/chat\/completions\/?$/
  const url = new URL(normalized)
  url.pathname = url.pathname.replace(suffix, '') || '/'
  if (format === 'openai' && url.pathname === '/') url.pathname = '/v1'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}
