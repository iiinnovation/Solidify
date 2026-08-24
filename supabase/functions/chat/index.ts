import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { corsHeaders, handleCors } from '../_shared/cors.ts'
import { createErrorResponse } from '../_shared/errors.ts'
import { getAuthUser } from '../_shared/auth.ts'
import {
  streamChat,
  streamChatCustom,
  streamNativeCustom,
  getDefaultModel,
  type AIModel,
  type ApiFormat,
  type ToolDefinition,
} from '../_shared/ai-providers.ts'
import {
  buildNativeRequestBody,
  buildRelayHostAllowlist,
  parseRelayTarget,
} from '../_shared/model-relay-policy.ts'

const ALLOWED_RELAY_HOSTS = buildRelayHostAllowlist(Deno.env.get('MODEL_PROXY_ALLOWED_HOSTS'))
const MAX_NATIVE_BODY_BYTES = 12_000_000

// The unified Agent runtime sends its complete provider-native request through
// `nativeBody`. This compact prompt only serves pre-Agent clients still using
// the old messages relay and deliberately contains no Skill or Artifact rules.
const COMPAT_SYSTEM_PROMPT = 'You are Solidify, an AI assistant. Follow the user request directly and respond in the user\'s language.'

interface ChatRequest {
  messages?: { role: 'user' | 'assistant'; content: string }[]
  // 预设模型（使用环境变量中的 Key）
  model?: AIModel
  // 自定义 Provider 配置（前端传入，优先级高于 model）
  provider?: {
    apiUrl?: string
    apiKey: string
    modelId: string
    format: ApiFormat
  }
  // 工具定义（M1-07：透传给 AI Provider）
  tools?: ToolDefinition[]
  /** Native OpenAI/Anthropic SDK body used by the unified Agent runtime. */
  nativeBody?: Record<string, unknown>
  /** Fully resolved SDK endpoint (for example /v1/chat/completions). */
  targetUrl?: string
}

function relayResponse(upstream: Response, streaming: boolean): Response {
  const headers: Record<string, string> = {
    ...corsHeaders,
    'Content-Type': upstream.headers.get('Content-Type')
      ?? (streaming ? 'text/event-stream' : 'application/json'),
  }
  if (streaming) {
    headers['Cache-Control'] = 'no-cache'
    headers.Connection = 'keep-alive'
  }
  return new Response(upstream.body, { headers })
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return handleCors()

  try {
    const user = await getAuthUser(req)
    if (!user) return createErrorResponse('AUTH_REQUIRED', 401, '未登录或会话已过期')

    const { messages, model, provider, tools, nativeBody, targetUrl }: ChatRequest = await req.json()

    if ((!messages || messages.length === 0) && !nativeBody) {
      return createErrorResponse('VALIDATION_ERROR', 422, '消息不能为空')
    }

    if (nativeBody) {
      if (!targetUrl || !provider?.apiKey || !provider.modelId) {
        return createErrorResponse('VALIDATION_ERROR', 422, 'Provider 配置不完整')
      }
      let endpoint: URL
      let upstreamBody: Record<string, unknown>
      try {
        endpoint = parseRelayTarget(targetUrl, provider.format, ALLOWED_RELAY_HOSTS)
        // Defense in depth after req.json(); the Supabase gateway owns the
        // parse-level request cap, while this limits what the relay processes.
        if (new TextEncoder().encode(JSON.stringify(nativeBody)).byteLength > MAX_NATIVE_BODY_BYTES) {
          return createErrorResponse('VALIDATION_ERROR', 413, '模型请求体过大')
        }
        upstreamBody = buildNativeRequestBody(nativeBody, provider.modelId, provider.format)
      } catch (error) {
        return createErrorResponse(
          'VALIDATION_ERROR',
          422,
          error instanceof Error ? error.message : '模型代理请求无效',
        )
      }
      const upstreamRes = await streamNativeCustom(
        endpoint.toString(),
        provider.apiKey,
        provider.format,
        upstreamBody,
      )
      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text()
        console.error('AI provider error:', upstreamRes.status, errText)
        if (upstreamRes.status === 429) return createErrorResponse('AI_RATE_LIMITED', 503, '请求过于频繁，请稍后再试')
        return createErrorResponse('AI_PROVIDER_ERROR', 502, `AI 服务异常: ${upstreamRes.status}`)
      }
      return relayResponse(upstreamRes, upstreamBody.stream === true)
    }

    const fullMessages = [
      { role: 'system' as const, content: COMPAT_SYSTEM_PROMPT },
      ...messages!,
    ]

    let upstreamRes: Response

    if (provider) {
      // 自定义 Provider：使用前端传入的配置
      if (!provider.apiUrl || !provider.apiKey || !provider.modelId) {
        return createErrorResponse('VALIDATION_ERROR', 422, 'Provider 配置不完整')
      }
      let endpoint: URL
      try {
        endpoint = parseRelayTarget(provider.apiUrl, provider.format, ALLOWED_RELAY_HOSTS)
      } catch (error) {
        return createErrorResponse(
          'VALIDATION_ERROR',
          422,
          error instanceof Error ? error.message : '模型 API URL 无效',
        )
      }
      upstreamRes = await streamChatCustom(
        endpoint.toString(),
        provider.apiKey,
        provider.modelId,
        provider.format,
        fullMessages,
        tools, // M1-07: 透传 tools 参数
      )
    } else {
      // 预设模型：使用环境变量中的 Key
      const selectedModel = model ?? getDefaultModel()
      upstreamRes = await streamChat(selectedModel, fullMessages, tools) // M1-07: 透传 tools 参数
    }

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text()
      console.error('AI provider error:', upstreamRes.status, errText)

      if (upstreamRes.status === 429) {
        return createErrorResponse('AI_RATE_LIMITED', 503, '请求过于频繁，请稍后再试')
      }
      return createErrorResponse('AI_PROVIDER_ERROR', 502, `AI 服务异常: ${upstreamRes.status}`)
    }

    return relayResponse(upstreamRes, true)
  } catch (error) {
    console.error('Chat function error:', error)
    return createErrorResponse(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : '未知错误',
    )
  }
})
