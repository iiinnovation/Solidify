/**
 * OpenAI provider implementation
 * @module lib/model/openai
 */

import OpenAI from 'openai'
import type { ModelProvider } from './provider'
import { iterateWithStallTimeout, resolveStallTimeout } from './stream-watchdog'
import type {
  ProviderConfig,
  CompletionRequest,
  CompletionChunk,
  UnifiedMessage,
  UnifiedContent,
  ToolDefinition,
  ModelError,
  TokenUsage,
  ProviderMetadata,
} from './types'

/**
 * OpenAI provider metadata
 */
const OPENAI_METADATA: ProviderMetadata = {
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
  readonly metadata: ProviderMetadata
  private client: OpenAI

  constructor(config: ProviderConfig) {
    this.metadata = {
      ...OPENAI_METADATA,
      supportsTools: config.supportsTools ?? OPENAI_METADATA.supportsTools,
      supportsVision: config.supportsVision ?? OPENAI_METADATA.supportsVision,
    }
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeout ?? 60000,
      maxRetries: config.maxRetries ?? 2,
      fetch: config.fetch,
      dangerouslyAllowBrowser: true, // Allow in browser/test environments
    })
  }

  async *stream(request: CompletionRequest): AsyncGenerator<CompletionChunk> {
    const abortController = new AbortController()
    const onExternalAbort = () => abortController.abort()
    request.signal?.addEventListener('abort', onExternalAbort, { once: true })

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
        {
          signal: abortController.signal,
          ...(request.timeout !== undefined ? { timeout: request.timeout } : {}),
          // Only override the client-level retry policy when the caller asked
          // for one. SDK retries fire while establishing the connection, before
          // any chunk is consumed, so they cannot duplicate streamed output.
          ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
        },
      )

      // Track tool calls across chunks
      const toolCalls = new Map<number, { id: string; name: string; args: string }>()
      let usage: TokenUsage | undefined
      let stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | undefined
      let toolCallsEmitted = false

      const emitPendingToolCalls = function* () {
        if (toolCallsEmitted || toolCalls.size === 0) return
        toolCallsEmitted = true
        if (stopReason !== 'max_tokens') {
          stopReason = 'tool_use'
        }
        for (const toolCall of toolCalls.values()) {
          try {
            const input = toolCall.args.trim() ? JSON.parse(toolCall.args) : {}
            yield {
              type: 'tool_call_end' as const,
              id: toolCall.id,
              input,
            }
          } catch {
            yield {
              type: 'error' as const,
              error: {
                code: 'tool_input_parse_error',
                message: `Failed to parse tool input JSON for call ${toolCall.id}`,
                type: 'unknown' as const,
                retryable: false,
                kind: 'parse' as const,
                recoverable: true,
              },
            }
            yield {
              type: 'tool_call_end' as const,
              id: toolCall.id,
              input: null,
            }
          }
        }
      }

      // Process stream events with a chunk stall watchdog
      const stallTimeoutMs = resolveStallTimeout(request)
      for await (const chunk of iterateWithStallTimeout(stream, stallTimeoutMs, () => abortController.abort())) {
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          }
        }

        const delta = chunk.choices[0]?.delta
        if (delta) {
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
        }

        // Finish reason
        const finishReason = chunk.choices[0]?.finish_reason
        if (finishReason) {
          stopReason = this.mapStopReason(finishReason)
          if (toolCalls.size > 0) {
            yield* emitPendingToolCalls()
          }
        }
      }

      // Ensure any trailing tool calls are emitted before ending the message
      yield* emitPendingToolCalls()

      yield { type: 'message_end', usage, stopReason }
    } catch (error) {
      yield { type: 'error', error: this.convertError(error) }
    } finally {
      request.signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  private mapStopReason(reason: string): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' {
    if (reason === 'length') return 'max_tokens'
    if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use'
    if (reason === 'stop') return 'end_turn'
    return 'stop_sequence'
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
      if (Array.isArray(msg.content)) {
        const toolUses = msg.content.filter(
          (block): block is Extract<UnifiedContent, { type: 'tool_use' }> => block.type === 'tool_use',
        )
        const toolResults = msg.content.filter(
          (block): block is Extract<UnifiedContent, { type: 'tool_result' }> => block.type === 'tool_result',
        )
        const visible = msg.content.filter(
          (block) => block.type === 'text' || block.type === 'image',
        )

        if (toolUses.length > 0) {
          const assistantText = visible
            .filter((block): block is Extract<UnifiedContent, { type: 'text' }> => block.type === 'text')
            .map((block) => block.text)
            .join('\n')
          result.push({
            role: 'assistant',
            content: assistantText || null,
            tool_calls: toolUses.map((block) => ({
              id: block.id,
              type: 'function' as const,
              function: { name: block.name, arguments: JSON.stringify(block.input) },
            })),
          })
          continue
        }

        for (const block of toolResults) {
          result.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content })
        }
        if (visible.length > 0) {
          result.push({
            role: msg.role === 'system' ? 'system' : msg.role,
            content: this.convertContent(visible),
          } as OpenAI.ChatCompletionMessageParam)
        }
        continue
      }

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
        case 'tool_result':
          // Handled at message level because OpenAI uses tool_calls and
          // separate role=tool messages rather than content blocks.
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
      const isTimeout = error.name === 'TimeoutError'
        || error.message.toLowerCase().includes('timeout')
        || error.message.toLowerCase().includes('stalled')
      return {
        code: isTimeout ? 'timeout' : 'unknown',
        message: error.message,
        type: isTimeout ? 'timeout' : 'unknown',
        retryable: isTimeout,
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
