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

export function getSystemPrompt(skillAddition?: string, skipConfirmation?: boolean): string {
  const base = `你是 Solidify 的 AI 助手，专门服务于项目实施人员（项目经理、实施工程师、售前顾问）。

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
