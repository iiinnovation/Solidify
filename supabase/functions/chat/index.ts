import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { corsHeaders, handleCors } from '../_shared/cors.ts'
import { createErrorResponse } from '../_shared/errors.ts'
import { getAuthUser } from '../_shared/auth.ts'
import {
  streamChat,
  streamChatCustom,
  streamNativeCustom,
  buildNativeRequestBody,
  getDefaultModel,
  type AIModel,
  type ApiFormat,
  type ToolDefinition,
} from '../_shared/ai-providers.ts'

const DEFAULT_RELAY_HOSTS = new Set([
  'api.openai.com',
  'api.anthropic.com',
  'api.deepseek.com',
])
const ALLOWED_RELAY_HOSTS = new Set([
  ...DEFAULT_RELAY_HOSTS,
  ...(Deno.env.get('MODEL_PROXY_ALLOWED_HOSTS') ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
])
const MAX_NATIVE_BODY_BYTES = 12_000_000

const BASE_SYSTEM_PROMPT = `你是 Solidify 的 AI 助手，专门服务于项目实施人员（项目经理、实施工程师、售前顾问）。

你的职责：
1. 帮助用户理解和梳理客户需求
2. 评估需求的技术可行性
3. 生成结构化文档（需求分析、方案设计等）
4. 生成可运行的前端代码 Demo 用于客户现场演示

## Artifact 格式

当你需要生成一个独立的文档或代码时，请使用以下格式输出 Artifact：

<solidify-artifact title="标题" type="document|code|slides|mermaid|chart|drawio" path="03-交付物/文件名.md">
内容
</solidify-artifact>

path 必须是工作区相对路径。若是面向用户的正式产出，默认放在 03-交付物/ 下。

Artifact 类型说明：
- document: Markdown 格式的结构化文档
- code: 完整的可运行 HTML/CSS/JS 代码（单文件，包含 <!DOCTYPE html>）
- slides: JSON 格式的结构化幻灯片，包含 { slides: [{ layout, title, body, ... }] }，layout 可选值：title / content / two-column / image-text / comparison / stats / timeline / section
- mermaid: Mermaid 图表代码，必须严格遵守以下语法规则：
  - 节点 ID 只用英文字母/数字/下划线，不含空格和特殊字符
  - 需要显示中文或特殊字符的标签，一律用方括号：nodeId["中文标签"]
  - subgraph 必须用 ID + 方括号形式：subgraph layerId["中文层名"]
  - 禁止在标签中使用裸括号 ()，如需显示括号内容请写入方括号标签内
  - 示例：subgraph client["客户端"] / A["用户浏览器"] --> B["API 网关"]
- drawio: Draw.io XML 格式的流程图

## 注意事项
- 使用中文回复
- 文档使用 Markdown 格式
- 代码 Demo 必须是单个 HTML 文件，可直接在浏览器运行`

function getSystemPrompt(skillSystemPrompt?: string, skillSkipConfirmation?: boolean): string {
  if (skillSystemPrompt) {
    if (skillSkipConfirmation) {
      return BASE_SYSTEM_PROMPT + `

## 工作流程

用户已通过技能面板明确选择了工作模式，这表示用户已经确定要做什么。
你应该直接按照技能要求输出结果，不需要先分析再确认。
如果信息不足，在输出结果的末尾标注待确认事项，而不是反问用户。

` + skillSystemPrompt
    }
    return BASE_SYSTEM_PROMPT + `

## 工作流程

用户已选择了特定技能模式。如果用户的意图已经足够清晰，直接输出结果。
如果关键信息缺失（如汇报类型、目标受众等），可以简短追问后再输出。

` + skillSystemPrompt
  }

  return BASE_SYSTEM_PROMPT + `

## 工作流程（重要）

你必须遵循"先分析，后生成"的两步工作流：

**第一步：分析与方案**
收到用户需求后，先用自然语言进行以下工作：
- 梳理和理解需求要点
- 分析技术可行性
- 提出实现方案与思路
- 列出你计划生成的 Artifact 内容概要（标题、类型、大致内容）

然后询问用户是否确认，例如："以上是我的分析，是否需要我生成对应的文档/代码？"

**第二步：生成 Artifact**
只有当用户明确表示确认（如"好的"、"可以"、"生成吧"、"继续"等肯定回复）后，才输出 Artifact。

⚠️ 禁止在第一次回复中直接生成 Artifact。除非用户在消息中明确要求立即生成（如"直接生成代码"、"帮我写一个 xxx"等明确指令）。

- 每次只生成用户确认过的内容，避免不必要的 Token 消耗`
}

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
  // 技能系统提示
  skillSystemPrompt?: string
  skillSkipConfirmation?: boolean
  // 工具定义（M1-07：透传给 AI Provider）
  tools?: ToolDefinition[]
  /** Native OpenAI/Anthropic SDK body used by the unified Agent runtime. */
  nativeBody?: Record<string, unknown>
  /** Fully resolved SDK endpoint (for example /v1/chat/completions). */
  targetUrl?: string
}

function parseRelayTarget(rawUrl: string, format: ApiFormat): URL {
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

  if (!ALLOWED_RELAY_HOSTS.has(endpoint.hostname.toLowerCase())) {
    throw new Error(`模型服务主机未获准代理：${endpoint.hostname}`)
  }

  const path = endpoint.pathname.replace(/\/+$/, '')
  const expectedPath = format === 'openai' ? /\/chat\/completions$/ : /\/v1\/messages$/
  if (!expectedPath.test(path)) {
    throw new Error(`模型 API 路径与 ${format} 格式不匹配`)
  }
  return endpoint
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

    const { messages, model, provider, skillSystemPrompt, skillSkipConfirmation, tools, nativeBody, targetUrl }: ChatRequest = await req.json()

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
        endpoint = parseRelayTarget(targetUrl, provider.format)
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

    const systemPrompt = getSystemPrompt(skillSystemPrompt, skillSkipConfirmation)
    const fullMessages = [
      { role: 'system' as const, content: systemPrompt },
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
        endpoint = parseRelayTarget(provider.apiUrl, provider.format)
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
