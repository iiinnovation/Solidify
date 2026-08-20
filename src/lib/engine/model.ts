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

const STORED_HANDLE_PATTERN = /\[Result stored as (?:mem|handle)-[^:\s]+:[^\]]*Use read_handle to retrieve it\.\]/i

/**
 * Stream model completion using the provider from context
 */
export async function* streamModel(
  ctx: QueryContext,
  onPrepared?: (request: Omit<CompletionRequest, 'signal'>) => void | Promise<void>,
): AsyncGenerator<CompletionChunk> {
  // Get provider from registry
  const provider = ctx.providerRegistry.get(ctx.model.provider)

  // Resolve the visible tool set first: the system prompt names tools by hand
  // (attachment readers, handles), so it has to be built against the same list
  // the provider receives or the model calls something that isn't there.
  const visibleTools = provider.metadata.supportsTools
    ? ctx.tools.filter((tool) => {
        if (tool.name === 'read_handle') return hasReadableHandle(ctx.messages)
        if (tool.name === 'search_attachments' || tool.name === 'read_attachment') return (ctx.attachments?.length ?? 0) > 0
        return true
      })
    : []

  // Build messages with context assembly
  const modelCtx = visibleTools.length === ctx.tools.length ? ctx : { ...ctx, tools: visibleTools }
  const { system, messages } = await buildMessages(modelCtx)

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
  const tools: ToolDefinition[] = visibleTools.map((tool) => ({
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
    // M1-12: Abort in-flight HTTP request when the run is cancelled
    signal: ctx.signal,
  }

  await onPrepared?.({
    model: request.model,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    topP: request.topP,
    stream: request.stream,
  })

  // Stream from provider
  yield* provider.stream(request)
}

/** Do not invite fabricated mem-0/mem-1 calls before a real result exists. */
function hasReadableHandle(messages: QueryContext['messages']): boolean {
  return messages.some((message) => {
    if (typeof message.content === 'string') return false
    return message.content.some((part) =>
      part.type === 'tool_result' && STORED_HANDLE_PATTERN.test(part.content),
    )
  })
}
