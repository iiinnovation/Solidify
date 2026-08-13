/**
 * OpenAI provider implementation
 * @module lib/model/openai
 */

import OpenAI from 'openai'
import type { ModelProvider } from './provider'
import type {
  ProviderConfig,
  CompletionRequest,
  CompletionChunk,
  UnifiedMessage,
  UnifiedContent,
  ToolDefinition,
  ModelError,
} from './types'

/**
 * OpenAI provider metadata
 */
const OPENAI_METADATA = {
  name: 'openai',
  displayName: 'OpenAI',
  supportsVision: true,
  supportsTools: true,
  supportsStreaming: true,
  defaultMaxTokens: 4096,
  models: [
    'gpt-4-turbo',
    'gpt-4-turbo-preview',
    'gpt-4',
    'gpt-4-32k',
    'gpt-3.5-turbo',
    'gpt-3.5-turbo-16k',
    'o1-preview',
    'o1-mini',
  ],
}

/**
 * OpenAI provider implementation
 */
export class OpenAIProvider implements ModelProvider {
  readonly name = 'openai'
  readonly metadata = OPENAI_METADATA
  private client: OpenAI

  constructor(config: ProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeout,
      maxRetries: config.maxRetries,
      dangerouslyAllowBrowser: true, // Allow in browser/test environments
    })
  }

  async *stream(request: CompletionRequest): AsyncGenerator<CompletionChunk> {
    try {
      // Convert messages to OpenAI format
      const messages = this.convertMessages(request.messages, request.system)

      // Convert tools to OpenAI format
      const tools = request.tools ? this.convertTools(request.tools) : undefined

      // Create streaming completion
      // M1-12: signal aborts the underlying HTTP request immediately
      const stream = await this.client.chat.completions.create(
        {
          model: request.model,
          messages,
          tools,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: request.signal },
      )

      // Track tool calls across chunks
      const toolCalls = new Map<number, { id: string; name: string; args: string }>()

      // Process stream events
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta

        if (!delta) continue

        // Content delta
        if (delta.content) {
          yield { type: 'content_delta', delta: delta.content }
        }

        // Tool calls
        if (delta.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            const index = toolCall.index

            // Tool call start
            if (toolCall.id && toolCall.function?.name) {
              const id = toolCall.id
              const name = toolCall.function.name
              toolCalls.set(index, { id, name, args: '' })
              yield { type: 'tool_call_start', id, name }
            }

            // Tool call arguments delta
            if (toolCall.function?.arguments) {
              const existing = toolCalls.get(index)
              if (existing) {
                existing.args += toolCall.function.arguments
                yield {
                  type: 'tool_call_delta',
                  id: existing.id,
                  delta: toolCall.function.arguments,
                }
              }
            }
          }
        }

        // Finish reason
        const finishReason = chunk.choices[0]?.finish_reason
        if (finishReason === 'tool_calls') {
          // Emit tool call end events
          for (const toolCall of toolCalls.values()) {
            try {
              const input = JSON.parse(toolCall.args)
              yield {
                type: 'tool_call_end',
                id: toolCall.id,
                input,
              }
            } catch {
              yield {
                type: 'tool_call_end',
                id: toolCall.id,
                input: {},
              }
            }
          }
        }

        // Usage info (sent at the end)
        if (chunk.usage) {
          yield {
            type: 'message_end',
            usage: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
            },
          }
        }
      }
    } catch (error) {
      yield { type: 'error', error: this.convertError(error) }
    }
  }

  async listModels(): Promise<string[]> {
    return OPENAI_METADATA.models
  }

  /**
   * Convert unified messages to OpenAI format
   * OpenAI doesn't have a separate system parameter, so we inject it as the first message
   */
  public convertMessages(
    messages: UnifiedMessage[],
    system?: string
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = []

    // Add system message if provided
    if (system) {
      result.push({
        role: 'system',
        content: system,
      })
    }

    // Convert messages
    for (const msg of messages) {
      result.push({
        role: msg.role === 'system' ? 'system' : msg.role,
        content: this.convertContent(msg.content),
      } as OpenAI.ChatCompletionMessageParam)
    }

    return result
  }

  /**
   * Convert unified content to OpenAI format
   */
  private convertContent(
    content: string | UnifiedContent[]
  ): string | OpenAI.ChatCompletionContentPart[] {
    if (typeof content === 'string') {
      return content
    }

    const parts: OpenAI.ChatCompletionContentPart[] = []

    for (const block of content) {
      switch (block.type) {
        case 'text':
          parts.push({ type: 'text', text: block.text })
          break

        case 'image':
          parts.push({
            type: 'image_url',
            image_url: { url: block.url },
          })
          break

        case 'tool_use':
          // OpenAI handles tool use differently - not in content
          // This would be in a separate assistant message with tool_calls
          break

        case 'tool_result':
          // OpenAI uses a separate tool message type
          // This needs special handling at the message level
          break
      }
    }

    return parts
  }

  /**
   * Convert unified tools to OpenAI format
   */
  public convertTools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    }))
  }

  /**
   * Convert error to unified format
   */
  private convertError(error: unknown): ModelError {
    if (error instanceof OpenAI.APIError) {
      const type = this.mapErrorType(error.type)
      return {
        code: error.code || 'unknown',
        message: error.message,
        type,
        retryable: type === 'rate_limit' || type === 'timeout' || type === 'network',
      }
    }

    if (error instanceof Error) {
      return {
        code: 'unknown',
        message: error.message,
        type: 'unknown',
        retryable: false,
      }
    }

    return {
      code: 'unknown',
      message: String(error),
      type: 'unknown',
      retryable: false,
    }
  }

  /**
   * Map OpenAI error types to our unified types
   */
  private mapErrorType(type?: string): ModelError['type'] {
    switch (type) {
      case 'invalid_request_error':
        return 'invalid_request'
      case 'rate_limit_error':
        return 'rate_limit'
      case 'authentication_error':
      case 'permission_error':
        return 'api_error'
      case 'timeout':
        return 'timeout'
      case 'network':
        return 'network'
      default:
        return 'unknown'
    }
  }
}
