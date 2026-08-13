/**
 * Model gateway - bridge between engine and providers
 * @module lib/engine/model
 */

import type { QueryContext } from './types'
import type {
  CompletionRequest,
  CompletionChunk,
  UnifiedMessage,
  UnifiedContent,
  ToolDefinition,
} from '../model'
import { buildMessages } from './messages'

/**
 * Stream model completion using the provider from context
 */
export async function* streamModel(
  ctx: QueryContext
): AsyncGenerator<CompletionChunk> {
  // Get provider from registry
  const provider = ctx.providerRegistry.get(ctx.model.provider)

  // Build messages with context assembly
  const { system, messages } = buildMessages(ctx)

  // Convert messages to unified format
  const unifiedMessages: UnifiedMessage[] = messages.map((msg) => ({
    role: msg.role,
    content:
      typeof msg.content === 'string'
        ? msg.content
        : (msg.content.map((block) => {
            switch (block.type) {
              case 'text':
                return { type: 'text', text: block.text }
              case 'image_url':
                return { type: 'image', url: block.image_url.url }
              case 'tool_use':
                return {
                  type: 'tool_use',
                  id: block.id,
                  name: block.name,
                  input: block.input,
                }
              case 'tool_result':
                return {
                  type: 'tool_result',
                  tool_use_id: block.tool_use_id,
                  content: block.content,
                  is_error: block.is_error,
                }
            }
          }) as UnifiedContent[]),
  }))

  // Convert tools to unified format
  const tools: ToolDefinition[] = ctx.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))

  // Build completion request
  const request: CompletionRequest = {
    model: ctx.model.model,
    system,
    messages: unifiedMessages,
    tools: tools.length > 0 ? tools : undefined,
    temperature: ctx.model.temperature,
    maxTokens: ctx.limits.maxOutputTokens,
    stream: true,
  }

  // Stream from provider
  yield* provider.stream(request)
}
