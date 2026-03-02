import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { corsHeaders, handleCors } from '../_shared/cors.ts'
import { createErrorResponse } from '../_shared/errors.ts'
import { getAuthUser } from '../_shared/auth.ts'
import {
  streamChat,
  streamChatCustom,
  getDefaultModel,
  type AIModel,
  type ApiFormat,
} from '../_shared/ai-providers.ts'

const BASE_SYSTEM_PROMPT = `你是 Solidify 的 AI 助手，专门服务于项目实施人员（项目经理、实施工程师、售前顾问）。

你的职责：
1. 帮助用户理解和梳理客户需求
2. 评估需求的技术可行性
3. 生成结构化文档（需求分析、方案设计等）
4. 生成可运行的前端代码 Demo 用于客户现场演示

## Artifact 格式

当你需要生成一个独立的文档或代码时，请使用以下格式输出 Artifact：

<solidify-artifact title="标题" type="document|code|slides|diagram|drawio">
内容
</solidify-artifact>

Artifact 类型说明：
- document: Markdown 格式的结构化文档
- code: 完整的可运行 HTML/CSS/JS 代码（单文件，包含 <!DOCTYPE html>）
- slides: JSON 格式的结构化幻灯片，包含 { slides: [{ layout, title, body, ... }] }，layout 可选值：title / content / two-column / image-text / comparison / stats / timeline / section
- diagram: Mermaid 图表代码，必须严格遵守以下语法规则：
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
  messages: { role: 'user' | 'assistant'; content: string }[]
  // 预设模型（使用环境变量中的 Key）
  model?: AIModel
  // 自定义 Provider 配置（前端传入，优先级高于 model）
  provider?: {
    apiUrl: string
    apiKey: string
    modelId: string
    format: ApiFormat
  }
  // 技能系统提示
  skillSystemPrompt?: string
  skillSkipConfirmation?: boolean
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return handleCors()

  try {
    // 验证用户身份（可选，Phase 2 启用后强制要求）
    const user = await getAuthUser(req)
    // 如果需要强制登录，取消下面的注释
    // if (!user) {
    //   return createErrorResponse('UNAUTHORIZED', 401, '未登录')
    // }

    const { messages, model, provider, skillSystemPrompt, skillSkipConfirmation }: ChatRequest = await req.json()

    if (!messages || messages.length === 0) {
      return createErrorResponse('VALIDATION_ERROR', 422, '消息不能为空')
    }

    const systemPrompt = getSystemPrompt(skillSystemPrompt, skillSkipConfirmation)
    const fullMessages = [
      { role: 'system' as const, content: systemPrompt },
      ...messages,
    ]

    let upstreamRes: Response

    if (provider) {
      // 自定义 Provider：使用前端传入的配置
      if (!provider.apiUrl || !provider.apiKey || !provider.modelId) {
        return createErrorResponse('VALIDATION_ERROR', 422, 'Provider 配置不完整')
      }
      upstreamRes = await streamChatCustom(
        provider.apiUrl,
        provider.apiKey,
        provider.modelId,
        provider.format,
        fullMessages,
      )
    } else {
      // 预设模型：使用环境变量中的 Key
      const selectedModel = model ?? getDefaultModel()
      upstreamRes = await streamChat(selectedModel, fullMessages)
    }

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text()
      console.error('AI provider error:', upstreamRes.status, errText)

      if (upstreamRes.status === 429) {
        return createErrorResponse('AI_RATE_LIMITED', 503, '请求过于频繁，请稍后再试')
      }
      return createErrorResponse('AI_PROVIDER_ERROR', 502, `AI 服务异常: ${upstreamRes.status}`)
    }

    return new Response(upstreamRes.body, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  } catch (error) {
    console.error('Chat function error:', error)
    return createErrorResponse(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : '未知错误',
    )
  }
})
