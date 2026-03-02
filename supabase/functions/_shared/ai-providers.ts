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

export async function streamChat(
  model: AIModel,
  messages: ChatMessage[],
): Promise<Response> {
  const provider = getProvider(model)

  if (provider.format === 'openai') {
    return fetch(provider.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: provider.modelId,
        messages,
        stream: true,
      }),
    })
  }

  // Anthropic 格式
  const systemMsg = messages.find((m) => m.role === 'system')
  const nonSystemMsgs = messages.filter((m) => m.role !== 'system')

  return fetch(provider.apiUrl, {
    method: 'POST',
    headers: {
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: provider.modelId,
      max_tokens: 8192,
      system: systemMsg?.content ?? '',
      messages: nonSystemMsgs,
      stream: true,
    }),
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
): Promise<Response> {
  if (format === 'openai') {
    return fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        stream: true,
      }),
    })
  }

  // Anthropic 格式
  const systemMsg = messages.find((m) => m.role === 'system')
  const nonSystemMsgs = messages.filter((m) => m.role !== 'system')

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
      system: systemMsg?.content ?? '',
      messages: nonSystemMsgs,
      stream: true,
    }),
  })
}
