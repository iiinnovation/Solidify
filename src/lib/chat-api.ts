import type { ApiFormat } from '@/stores/model-store'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export interface ChatRequestBody {
  messages: { role: 'user' | 'assistant'; content: string }[]
  model?: string
  provider?: {
    apiUrl: string
    apiKey: string
    modelId: string
    format: ApiFormat
  }
  skillSystemPrompt?: string
  skillSkipConfirmation?: boolean
}

/**
 * 上下文压缩：保留首轮对话 + 最近 N 轮对话
 * 适用于项目实施场景，首轮通常包含项目背景，最近对话保持连贯性
 */
export function compressMessages(
  messages: { role: 'user' | 'assistant'; content: string }[],
  maxRecentRounds: number = 10
): { role: 'user' | 'assistant'; content: string }[] {
  // 计算轮数（一轮 = 一个 user + 一个 assistant）
  const rounds: Array<{ role: 'user' | 'assistant'; content: string }[]> = []
  let currentRound: { role: 'user' | 'assistant'; content: string }[] = []

  for (const msg of messages) {
    currentRound.push(msg)
    if (msg.role === 'assistant') {
      rounds.push(currentRound)
      currentRound = []
    }
  }

  // 如果有未完成的轮（只有 user 消息），也加入
  if (currentRound.length > 0) {
    rounds.push(currentRound)
  }

  // 如果总轮数 <= maxRecentRounds + 1，不需要压缩
  if (rounds.length <= maxRecentRounds + 1) {
    return messages
  }

  // 保留首轮 + 最近 N 轮
  const firstRound = rounds[0]
  const recentRounds = rounds.slice(-maxRecentRounds)

  const compressed = [...firstRound, ...recentRounds.flat()]

  // 在首轮和最近轮之间插入压缩提示（可选，帮助 AI 理解上下文被压缩了）
  if (rounds.length > maxRecentRounds + 1) {
    const skippedCount = rounds.length - maxRecentRounds - 1
    const compressionHint: { role: 'user' | 'assistant'; content: string } = {
      role: 'assistant',
      content: `[已省略 ${skippedCount} 轮历史对话以节省上下文]`,
    }
    return [
      ...firstRound,
      compressionHint,
      ...recentRounds.flat(),
    ]
  }

  return compressed
}

export async function fetchChatStream(body: ChatRequestBody): Promise<Response> {
  // 如果配置了 Supabase，走 Edge Function 代理
  const hasSupabase = SUPABASE_URL?.trim() && SUPABASE_ANON_KEY?.trim()
  if (hasSupabase) {
    // 获取用户的 access token
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    const { data: { session } } = await supabase.auth.getSession()

    if (!session?.access_token) {
      throw new Error('未登录或会话已过期')
    }

    const url = `${SUPABASE_URL}/functions/v1/chat`
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
    })
  }

  // 未配置 Supabase 时，直接调用 AI API（开发用，Key 暴露在前端）
  if (!body.provider) {
    throw new Error('未配置 Supabase，且没有自定义 Provider')
  }

  const { apiUrl, apiKey, modelId, format } = body.provider

  if (format === 'openai') {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 60000) // 60秒超时

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: 'system', content: getSystemPrompt(body.skillSystemPrompt, body.skillSkipConfirmation) },
            ...body.messages,
          ],
          stream: true,
        }),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)
      return response
    } catch (error) {
      clearTimeout(timeoutId)
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('请求超时，请检查网络连接或 API 配置')
      }
      throw error
    }
  }

  // Anthropic 格式
  const nonSystemMsgs = body.messages
  return fetch(apiUrl, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 8192,
      system: getSystemPrompt(body.skillSystemPrompt, body.skillSkipConfirmation),
      messages: nonSystemMsgs,
      stream: true,
    }),
  })
}

function getSystemPrompt(skillAddition?: string, skipConfirmation?: boolean): string {
  const base = `你是 Solidify 的 AI 助手，专门服务于项目实施人员（项目经理、实施工程师、售前顾问）。

你的职责：
1. 帮助用户理解和梳理客户需求
2. 评估需求的技术可行性
3. 生成结构化文档（需求分析、方案设计等）
4. 生成可运行的前端代码 Demo 用于客户现场演示

## Artifact 格式

当你需要生成一个独立的文档或代码时，请使用以下格式输出 Artifact：

<solidify-artifact title="标题" type="document|code|slides|diagram">
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

## 注意事项
- 使用中文回复
- 文档使用 Markdown 格式
- 代码 Demo 必须是单个 HTML 文件，可直接在浏览器运行`

  // 技能模式下，根据 skipConfirmation 决定工作流
  if (skillAddition) {
    if (skipConfirmation) {
      return base + `

## 工作流程

用户已通过技能面板明确选择了工作模式，这表示用户已经确定要做什么。
你应该直接按照技能要求输出结果，不需要先分析再确认。
如果信息不足，在输出结果的末尾标注待确认事项，而不是反问用户。

` + skillAddition
    }
    return base + `

## 工作流程

用户已选择了特定技能模式。如果用户的意图已经足够清晰，直接输出结果。
如果关键信息缺失（如汇报类型、目标受众等），可以简短追问后再输出。

` + skillAddition
  }

  // 无技能时，保留原有的两步确认流程
  return base + `

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
