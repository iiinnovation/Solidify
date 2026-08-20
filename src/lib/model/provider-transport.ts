const ERROR_NAME = 'ProviderTransportError'

export class ProviderTransportError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = ERROR_NAME
  }
}

/** Add browser-specific diagnostics while preserving the original error cause. */
export function formatProviderFetchError(error: unknown, endpoint: string): ProviderTransportError | null {
  if (!(error instanceof TypeError)) return null

  const browserOrigin = typeof window !== 'undefined' ? window.location.origin : ''
  let crossOrigin = false
  try {
    crossOrigin = Boolean(browserOrigin && new URL(endpoint).origin !== browserOrigin)
  } catch {
    // Endpoint validation runs before provider construction.
  }

  const message = crossOrigin
    ? `无法连接模型服务。浏览器可能拦截了跨域请求（CORS）：${endpoint}。请让该 API 返回 Access-Control-Allow-Origin，或配置 Supabase 代理/使用桌面版。`
    : `无法连接模型服务：${endpoint}。请检查网络、API 地址和服务状态。`
  return new ProviderTransportError(message, { cause: error })
}

/** Direct production Web transport with actionable network/CORS errors. */
export function createDirectProviderFetch(): typeof globalThis.fetch {
  return async (input, init) => {
    const endpoint = input instanceof Request ? input.url : String(input)
    try {
      return await globalThis.fetch(input, init)
    } catch (error) {
      const formatted = formatProviderFetchError(error, endpoint)
      if (formatted) throw formatted
      throw error
    }
  }
}

/** Recover a diagnostic that an SDK wrapped in APIConnectionError. */
export function providerTransportErrorMessage(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
    const candidate = current as { name?: unknown; message?: unknown; cause?: unknown }
    if (candidate.name === ERROR_NAME && typeof candidate.message === 'string') return candidate.message
    current = candidate.cause
  }
  return undefined
}
