export type AIModel =
  | 'deepseek-chat'
  | 'deepseek-reasoner'
  | 'claude-sonnet'
  | 'claude-haiku'
  | 'gpt-4o'
  | 'gpt-4o-mini'

export type ApiFormat = 'openai' | 'anthropic'

interface ProviderConfig {
  apiUrl: string
  apiKeyEnv: string
  modelId: string
  format: ApiFormat
}

const providers: Record<AIModel, ProviderConfig> = {
  'deepseek-chat': {
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    modelId: 'deepseek-chat',
    format: 'openai',
  },
  'deepseek-reasoner': {
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    modelId: 'deepseek-reasoner',
    format: 'openai',
  },
  'claude-sonnet': {
    apiUrl: 'https://api.anthropic.com/v1/messages',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    modelId: 'claude-sonnet-4-20250514',
    format: 'anthropic',
  },
  'claude-haiku': {
    apiUrl: 'https://api.anthropic.com/v1/messages',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    modelId: 'claude-haiku-4-20250514',
    format: 'anthropic',
  },
  'gpt-4o': {
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKeyEnv: 'OPENAI_API_KEY',
    modelId: 'gpt-4o',
    format: 'openai',
  },
  'gpt-4o-mini': {
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKeyEnv: 'OPENAI_API_KEY',
    modelId: 'gpt-4o-mini',
    format: 'openai',
  },
}

export function getProvider(model: AIModel): ProviderConfig & { apiKey: string } {
  const config = providers[model]
  if (!config) throw new Error(`Unknown model: ${model}`)

  const apiKey = Deno.env.get(config.apiKeyEnv)
  if (!apiKey) throw new Error(`Missing env: ${config.apiKeyEnv}`)

  return { ...config, apiKey }
}

export function getDefaultModel(): AIModel {
  return (Deno.env.get('DEFAULT_CHAT_MODEL') as AIModel) || 'deepseek-chat'
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Tool definition compatible with both OpenAI and Anthropic formats
 */
export interface ToolDefinition {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export async function streamChat(
  model: AIModel,
  messages: ChatMessage[],
  tools?: ToolDefinition[],
): Promise<Response> {
  const provider = getProvider(model)

  if (provider.format === 'openai') {
    const body: Record<string, unknown> = {
      model: provider.modelId,
      messages,
      stream: true,
    }

    // Add tools if provided (convert to OpenAI format)
    if (tools && tools.length > 0) {
      body.tools = tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      }))
    }

    return fetch(provider.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  }

  // Anthropic 格式
  const systemMsg = messages.find((m) => m.role === 'system')
  const nonSystemMsgs = messages.filter((m) => m.role !== 'system')

  const body: Record<string, unknown> = {
    model: provider.modelId,
    max_tokens: 8192,
    system: systemMsg?.content ?? '',
    messages: nonSystemMsgs,
    stream: true,
  }

  // Add tools if provided (Anthropic format is already compatible)
  if (tools && tools.length > 0) {
    body.tools = tools
  }

  return fetch(provider.apiUrl, {
    method: 'POST',
    headers: {
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

/**
 * 自定义 Provider 流式调用
 * 前端传入完整的 apiUrl/apiKey/modelId/format
 */
export async function streamChatCustom(
  apiUrl: string,
  apiKey: string,
  modelId: string,
  format: ApiFormat,
  messages: ChatMessage[],
  tools?: ToolDefinition[],
): Promise<Response> {
  if (format === 'openai') {
    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      stream: true,
    }

    // Add tools if provided (convert to OpenAI format)
    if (tools && tools.length > 0) {
      body.tools = tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      }))
    }

    return fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  }

  // Anthropic 格式
  const systemMsg = messages.find((m) => m.role === 'system')
  const nonSystemMsgs = messages.filter((m) => m.role !== 'system')

  const body: Record<string, unknown> = {
    model: modelId,
    max_tokens: 8192,
    system: systemMsg?.content ?? '',
    messages: nonSystemMsgs,
    stream: true,
  }

  // Add tools if provided (Anthropic format is already compatible)
  if (tools && tools.length > 0) {
    body.tools = tools
  }

  return fetch(apiUrl, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

/** Forward a provider SDK request without flattening its native message shape. */
export function streamNativeCustom(
  targetUrl: string,
  apiKey: string,
  modelId: string,
  format: ApiFormat,
  nativeBody: Record<string, unknown>,
): Promise<Response> {
  const body = { ...nativeBody, model: modelId, stream: true }
  return fetch(targetUrl, {
    method: 'POST',
    headers: format === 'openai'
      ? { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
      : { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
