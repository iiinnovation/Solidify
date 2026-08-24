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
} from '../model'
import { hasRenderedArtifactPreview } from '../tools/builtin/capture-preview'
import { compileContext, type CompiledContextStats } from './context-compiler'
import { storedResultHandle } from './context-budget'

export type RequestContextStats = CompiledContextStats

/**
 * Stream model completion using the provider from context
 */
export async function* streamModel(
  ctx: QueryContext,
  onPrepared?: (request: Omit<CompletionRequest, 'signal'>, stats?: RequestContextStats) => void | Promise<void>,
): AsyncGenerator<CompletionChunk> {
  // Get provider from registry
  const provider = ctx.providerRegistry.get(ctx.model.provider)

  // Resolve the visible tool set first: the system prompt names tools by hand
  // (attachment readers, handles), so it has to be built against the same list
  // the provider receives or the model calls something that isn't there.
  let visibleTools = provider.metadata.supportsTools
    ? ctx.tools.filter((tool) => {
        // read_handle visibility is finalized after context compaction below;
        // the raw history can contain a handle that the model never receives.
        if (tool.name === 'read_handle') return true
        if (tool.name === 'search_attachments' || tool.name === 'read_attachment' || tool.name === 'prepare_attachment_evidence') return (ctx.attachments?.length ?? 0) > 0
        // Capturing is a follow-up capability, not a way to validate an
        // artifact that this model turn has not produced yet. Requiring both a
        // DOM target and vision input prevents guaranteed-failure loops on an
        // empty preview panel.
        if (tool.name === 'capture_preview') {
          return provider.metadata.supportsVision === true && hasRenderedArtifactPreview()
        }
        return true
      })
    : []

  // Compile messages, tools, stable-prefix identity and budget stats together.
  let modelCtx = visibleTools.length === ctx.tools.length ? ctx : { ...ctx, tools: visibleTools }
  let compiled = await compileContext(modelCtx)
  if (visibleTools.some((tool) => tool.name === 'read_handle') && !hasReadableHandle(compiled.messages)) {
    visibleTools = visibleTools.filter((tool) => tool.name !== 'read_handle')
    modelCtx = { ...ctx, tools: visibleTools }
    compiled = await compileContext(modelCtx)
  }
  const { system, messages, tools, stats: contextStats } = compiled

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

  // Build completion request
  const request: CompletionRequest = {
    model: ctx.model.model,
    system,
    messages: unifiedMessages,
    tools: tools.length > 0 ? tools : undefined,
    toolChoice: ctx.toolChoice,
    reasoningMode: ctx.reasoningMode,
    temperature: ctx.model.temperature,
    maxTokens: ctx.limits.maxOutputTokens,
    stream: true,
    ...(provider.metadata.supportsPromptCache
      ? {
          promptCache: {
            // OpenAI-compatible providers use this key for routing affinity,
            // so it must remain stable while tools/history evolve in a run.
            key: promptCacheKey(ctx.conversationId, ctx.model.model),
            system: true,
            tools: tools.length > 0,
            messages: unifiedMessages.length > 0,
          },
        }
      : {}),
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
    toolChoice: request.toolChoice,
    reasoningMode: request.reasoningMode,
    promptCache: request.promptCache,
  }, contextStats)

  // Stream from provider
  yield* provider.stream(request)
}

function promptCacheKey(conversationId: string, model: string): string {
  const value = `${conversationId}\u0000${model}`
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193)
  }
  return `conversation-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/** Do not invite fabricated mem-0/mem-1 calls before a real result exists. */
function hasReadableHandle(messages: readonly { content: string | readonly unknown[] }[]): boolean {
  return messages.some((message) => {
    if (typeof message.content === 'string') return false
    return message.content.some((part) =>
      Boolean(part)
      && typeof part === 'object'
      && (part as { type?: unknown }).type === 'tool_result'
      && typeof (part as { content?: unknown }).content === 'string'
      && storedResultHandle((part as { content: string }).content) !== undefined,
    )
  })
}
