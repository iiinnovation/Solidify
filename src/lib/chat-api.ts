import type { ModelProvider } from '@/stores/model-store'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import { createDirectProviderFetch } from '@/lib/model/provider-transport'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string

/**
 * Route the provider SDK's native request through the authenticated Edge
 * Function, or through Vite's development proxy when Supabase is absent. The
 * relay preserves multipart messages and tool calls instead of flattening them.
 */
export function createModelProviderFetch(provider: ModelProvider): typeof globalThis.fetch | undefined {
  const relayClient = supabase
  if (!supabaseConfigured || !relayClient || !SUPABASE_URL?.trim() || !SUPABASE_ANON_KEY?.trim()) {
    return import.meta.env.DEV ? createLocalProviderFetch() : createDirectProviderFetch()
  }

  return async (input, init) => {
    const { data: { session } } = await relayClient.auth.getSession()
    if (!session?.access_token) throw new Error('未登录或会话已过期')

    const nativeBody = await readFetchJsonBody(input, init)
    const targetUrl = input instanceof Request ? input.url : String(input)
    return globalThis.fetch(`${SUPABASE_URL}/functions/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        provider: {
          apiKey: provider.apiKey,
          modelId: provider.modelId,
          format: provider.format,
        },
        targetUrl,
        nativeBody,
      }),
      signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
    })
  }
}

function createLocalProviderFetch(): typeof globalThis.fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined
    const target = request?.url ?? String(input)
    const headers = new Headers(init?.headers ?? request?.headers)
    headers.set('X-Solidify-Target', target)
    return globalThis.fetch('/__solidify/model-proxy', {
      ...init,
      method: init?.method ?? request?.method ?? 'POST',
      headers,
      body: init?.body ?? (request ? await request.clone().arrayBuffer() : undefined),
      signal: init?.signal ?? request?.signal,
    })
  }
}

async function readFetchJsonBody(input: RequestInfo | URL, init?: RequestInit): Promise<Record<string, unknown>> {
  const raw = typeof init?.body === 'string'
    ? init.body
    : input instanceof Request
      ? await input.clone().text()
      : ''
  if (!raw) throw new Error('模型代理请求缺少 JSON body')
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('模型代理请求 body 必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}
