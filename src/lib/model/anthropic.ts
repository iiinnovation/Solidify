/**
 * Anthropic provider implementation
 * @module lib/model/anthropic
 */

import Anthropic from '@anthropic-ai/sdk'
import type { ModelProvider } from './provider'
import type {
  CompletionRequest,
  CompletionChunk,
  ProviderConfig,
  ProviderMetadata,
  UnifiedMessage,
  UnifiedContent,
  ToolDefinition,
  ModelError,
} from './types'

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic'
  readonly metadata: ProviderMetadata = {
    name: 'anthropic',
    displayName: 'Anthropic Claude',
    supportsVision: true,
    supportsTools: true,
    supportsStreaming: true,
    defaultMaxTokens: 4096,
    models: [
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-haiku-4-5-20251001',
    ],
  }

  private client: Anthropic
  private config: ProviderConfig

  constructor(config: ProviderConfig) {
    this.config = config
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeout ?? 60000,
      maxRetries: config.maxRetries ?? 2,
    })
  }

  async *stream(request: CompletionRequest): AsyncGenerator<CompletionChunk> {
    try {
      // Convert to Anthropic format
      const messages = this.convertMessages(request.messages)
      const tools = request.tools ? this.convertTools(request.tools) : undefined

      // Call Anthropic API
      const stream = await this.client.messages.stream({
        model: request.model,
        system: request.system,
        messages,
        tools,
        max_tokens: request.maxTokens ?? this.metadata.defaultMaxTokens,
        temperature: request.temperature,
        top_p: request.topP,
      })

      yield { type: 'message_start' }

      // Convert Anthropic events to unified format
      for await (const event of stream) {
        switch (event.type) {
          case 'content_block_start':
            if (event.content_block.type === 'text') {
              yield { type: 'content_start' }
            } else if (event.content_block.type === 'tool_use') {
              yield {
                type: 'tool_call_start',
                id: event.content_block.id,
                name: event.content_block.name,
              }
            }
            break

          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              yield { type: 'content_delta', delta: event.delta.text }
            } else if (event.delta.type === 'input_json_delta') {
              yield {
                type: 'tool_call_delta',
                id: event.index.toString(),
                delta: event.delta.partial_json,
              }
            }
            break

          case 'content_block_stop':
            // Content block ended
            break

          case 'message_delta':
            // Message delta (usage updates)
            break

          case 'message_stop': {
            const finalMessage = await stream.finalMessage()
            yield {
              type: 'message_end',
              usage: {
                inputTokens: finalMessage.usage.input_tokens,
                outputTokens: finalMessage.usage.output_tokens,
                totalTokens:
                  finalMessage.usage.input_tokens + finalMessage.usage.output_tokens,
              },
            }
            break
          }
        }
      }
    } catch (error) {
      yield { type: 'error', error: this.convertError(error) }
    }
  }

  async listModels(): Promise<string[]> {
    return this.metadata.models
  }

  async validateConfig(): Promise<boolean> {
    try {
      // Try a minimal request to validate API key
      await this.client.messages.create({
        model: this.config.defaultModel ?? 'claude-sonnet-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'test' }],
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Convert unified messages to Anthropic format
   */
  private convertMessages(
    messages: UnifiedMessage[]
  ): Anthropic.MessageParam[] {
    return messages
      .filter((m) => m.role !== 'system') // System handled separately
      .map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: this.convertContent(msg.content),
      }))
  }

  /**
   * Convert unified content to Anthropic format
   */
  private convertContent(
    content: string | UnifiedContent[]
  ): string | Anthropic.MessageParam['content'] {
    if (typeof content === 'string') {
      return content
    }

    const blocks: Anthropic.MessageParam['content'] = []

    for (const block of content) {
      switch (block.type) {
        case 'text':
          blocks.push({ type: 'text', text: block.text })
          break

        case 'image':
          // Anthropic doesn't support image URLs directly in content
          // This would need to be converted to base64 or handled differently
          // For now, skip or convert to text description
          blocks.push({
            type: 'text',
            text: `[Image: ${block.url}]`,
          })
          break

        case 'tool_use':
          blocks.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          })
          break

        case 'tool_result':
          blocks.push({
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error,
          })
          break
      }
    }

    return blocks
  }

  /**
   * Convert unified tools to Anthropic format
   */
  private convertTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object',
        ...(tool.inputSchema as Record<string, unknown>),
      } as Anthropic.Tool.InputSchema,
    }))
  }

  /**
   * Convert Anthropic error to unified format
   */
  private convertError(error: unknown): ModelError {
    if (error instanceof Anthropic.APIError) {
      let type: ModelError['type'] = 'api_error'
      let retryable = false

      if (error.status === 429) {
        type = 'rate_limit'
        retryable = true
      } else if (error.status === 400) {
        type = 'invalid_request'
      } else if (error.status && error.status >= 500) {
        type = 'api_error'
        retryable = true
      }

      return {
        code: error.status?.toString() ?? 'unknown',
        message: error.message,
        type,
        retryable,
      }
    }

    if (error instanceof Error) {
      const isTimeout = error.message.includes('timeout')
      const isNetwork = error.message.includes('fetch') || error.message.includes('network')

      return {
        code: 'client_error',
        message: error.message,
        type: isTimeout ? 'timeout' : isNetwork ? 'network' : 'unknown',
        retryable: isTimeout || isNetwork,
      }
    }

    return {
      code: 'unknown',
      message: String(error),
      type: 'unknown',
      retryable: false,
    }
  }
}
