/**
 * Anthropic provider implementation
 * @module lib/model/anthropic
 */

import Anthropic from '@anthropic-ai/sdk'
import type { ModelProvider } from './provider'
import { iterateWithStallTimeout, resolveStallTimeout } from './stream-watchdog'
import { providerTransportErrorMessage } from './provider-transport'
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

/**
 * Read an extended-thinking delta. The SDK only declares `thinking_delta` once
 * the installed version supports it, so the shape is probed structurally to
 * keep this adapter working across SDK upgrades.
 */
function thinkingDeltaText(delta: unknown): string | undefined {
  if (!delta || typeof delta !== 'object') return undefined
  const candidate = delta as { type?: unknown; thinking?: unknown }
  if (candidate.type !== 'thinking_delta') return undefined
  return typeof candidate.thinking === 'string' && candidate.thinking ? candidate.thinking : undefined
}

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic'
  readonly metadata: ProviderMetadata

  private client: Anthropic
  private config: ProviderConfig

  constructor(config: ProviderConfig) {
    this.metadata = {
      name: 'anthropic',
      displayName: 'Anthropic Claude',
      supportsVision: config.supportsVision ?? true,
      supportsTools: config.supportsTools ?? true,
      supportsStreaming: true,
      supportsPromptCache: true,
      defaultMaxTokens: 4096,
      models: [
        'claude-opus-5',
        'claude-sonnet-5',
        'claude-opus-4-8',
        'claude-haiku-4-5-20251001',
      ],
    }
    this.config = config
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeout ?? 60000,
      maxRetries: config.maxRetries ?? 2,
      fetch: config.fetch,
      dangerouslyAllowBrowser: true,
    })
  }

  async *stream(request: CompletionRequest): AsyncGenerator<CompletionChunk> {
    const abortController = new AbortController()
    const onExternalAbort = () => abortController.abort()
    request.signal?.addEventListener('abort', onExternalAbort, { once: true })

    try {
      // Convert to Anthropic format
      const messages = this.convertMessages(request.messages)
      let tools = request.tools ? this.convertTools(request.tools) : undefined
      if (tools && request.promptCache?.tools && tools.length > 0) {
        // Anthropic caches all preceding tool blocks at the last breakpoint.
        const last = tools.length - 1
        tools = tools.map((tool, index) => index === last
          ? { ...tool, cache_control: { type: 'ephemeral' as const } }
          : tool)
      }
      const system = request.system && request.promptCache?.system
        ? [{ type: 'text' as const, text: request.system, cache_control: { type: 'ephemeral' as const } }]
        : request.system

      // Call Anthropic API
      // M1-12: signal aborts the underlying HTTP request immediately.
      // `create({stream:true})` returns a PULL-based Stream: the HTTP body is
      // only advanced when the consumer calls next(). `messages.stream()` looks
      // equivalent but feeds an unbounded internal queue from an independent
      // producer loop, which defeats the backpressure guarantee in
      // agent-loop.md §1 — a slow consumer would buffer the whole response.
      const stream = await this.client.messages.create(
        {
          model: request.model,
          system,
          messages,
          tools,
          max_tokens: request.maxTokens ?? this.metadata.defaultMaxTokens,
          temperature: request.temperature,
          top_p: request.topP,
          stream: true,
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

      yield { type: 'message_start' }

      // Track tool_use blocks by stream index to accumulate input JSON
      const toolBlocks = new Map<number, { id: string; json: string }>()
      // Usage and stop reason arrive incrementally; there is no finalMessage()
      // to fall back on, and awaiting one would reintroduce a failure mode where
      // a mid-stream error is reported as an empty successful turn.
      let inputTokens = 0
      let outputTokens = 0
      let cacheReadTokens = 0
      let cacheWriteTokens = 0
      let stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | undefined

      // Convert Anthropic events to unified format with a chunk stall watchdog
      const stallTimeoutMs = resolveStallTimeout(request)
      for await (const event of iterateWithStallTimeout(stream, stallTimeoutMs, () => abortController.abort())) {
        try {
          switch (event.type) {
            case 'content_block_start':
              if (event.content_block.type === 'text') {
                yield { type: 'content_start' }
              } else if (event.content_block.type === 'tool_use') {
                toolBlocks.set(event.index, {
                  id: event.content_block.id,
                  json: '',
                })
                yield {
                  type: 'tool_call_start',
                  id: event.content_block.id,
                  name: event.content_block.name,
                }
              }
              break

            case 'content_block_delta': {
              // Extended thinking is billed as output and spends the same
              // max_tokens budget as the answer, so it cannot be dropped.
              const thinking = thinkingDeltaText(event.delta)
              if (event.delta.type === 'text_delta') {
                yield { type: 'content_delta', delta: event.delta.text }
              } else if (thinking) {
                yield { type: 'reasoning_delta', delta: thinking }
              } else if (event.delta.type === 'input_json_delta') {
                const block = toolBlocks.get(event.index)
                if (block) {
                  block.json += event.delta.partial_json
                  yield {
                    type: 'tool_call_delta',
                    id: block.id,
                    delta: event.delta.partial_json,
                  }
                }
              }
              break
            }

            case 'content_block_stop': {
              const block = toolBlocks.get(event.index)
              if (block) {
                toolBlocks.delete(event.index)
                try {
                  // Empty input (tool with no args) parses as {}
                  const input = block.json.trim() ? JSON.parse(block.json) : {}
                  yield { type: 'tool_call_end', id: block.id, input }
                } catch {
                  // M1-11: Malformed tool input JSON - recoverable, tombstoned upstream
                  yield {
                    type: 'error',
                    error: {
                      code: 'tool_input_parse_error',
                      message: `Failed to parse tool input JSON for call ${block.id}`,
                      type: 'unknown',
                      retryable: false,
                      kind: 'parse',
                      recoverable: true,
                    },
                  }
                  // Keep the tool_use/result pair intact. Null fails the
                  // object schema in the executor and produces actionable
                  // validation feedback for the model's next turn.
                  yield { type: 'tool_call_end', id: block.id, input: null }
                }
              } else {
                yield { type: 'content_end' }
              }
              break
            }

            case 'message_start':
              inputTokens = event.message.usage?.input_tokens ?? 0
              outputTokens = event.message.usage?.output_tokens ?? 0
              cacheReadTokens = event.message.usage?.cache_read_input_tokens ?? 0
              cacheWriteTokens = event.message.usage?.cache_creation_input_tokens ?? 0
              break

            case 'message_delta':
              // Carries the final stop_reason and the cumulative output tokens.
              if (event.usage?.output_tokens != null) outputTokens = event.usage.output_tokens
              switch (event.delta.stop_reason) {
                case 'end_turn':
                case 'max_tokens':
                case 'stop_sequence':
                case 'tool_use':
                  stopReason = event.delta.stop_reason
                  break
              }
              break

            case 'message_stop': {
              yield {
                type: 'message_end',
                usage: {
                  inputTokens,
                  outputTokens,
                  totalTokens: inputTokens + outputTokens,
                  cacheReadTokens,
                  cacheWriteTokens,
                },
                stopReason,
              }
              break
            }
          }
        } catch (eventError) {
          // M1-11: SSE frame parsing error - yield recoverable error and continue
          yield {
            type: 'error',
            error: {
              code: 'sse_parse_error',
              message: eventError instanceof Error
                ? `Failed to parse SSE event frame: ${eventError.message}`
                : 'Failed to parse SSE event frame',
              type: 'unknown',
              retryable: false,
              kind: 'parse',
              recoverable: true,
            }
          }
          // Continue processing next frames
          continue
        }
      }
    } catch (error) {
      yield { type: 'error', error: this.convertError(error) }
    } finally {
      request.signal?.removeEventListener('abort', onExternalAbort)
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
          {
            const match = block.url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s)
            if (match) {
              blocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: match[1] as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                  data: match[2],
                },
              })
            } else {
              blocks.push({ type: 'text', text: `[Image: ${block.url}]` })
            }
          }
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
    const transportMessage = providerTransportErrorMessage(error)
    if (transportMessage) {
      return {
        code: 'network',
        message: transportMessage,
        type: 'network',
        retryable: true,
      }
    }
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
      const isTimeout = error.message.includes('timeout') || error.message.includes('stalled')
      const isNetwork = error.message.includes('fetch') || error.message.includes('network')

      return {
        code: isTimeout ? 'timeout' : 'client_error',
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
