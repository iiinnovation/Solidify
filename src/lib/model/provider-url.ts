import type { ApiFormat } from '@/stores/model-store'

/** Convert the full endpoint stored by the legacy chat client to an SDK base URL. */
export function providerBaseURL(apiUrl: string, format: ApiFormat): string | undefined {
  const value = apiUrl.trim()
  if (!value) return undefined

  const suffix = format === 'anthropic' ? /\/v1\/messages\/?$/ : /\/chat\/completions\/?$/

  try {
    const url = new URL(value)
    url.pathname = url.pathname.replace(suffix, '') || '/'
    if (format === 'openai' && url.pathname === '/') url.pathname = '/v1'
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    const base = value.replace(/[?#].*$/, '').replace(suffix, '').replace(/\/$/, '')
    return base || undefined
  }
}
