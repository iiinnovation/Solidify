/**
 * Agent query loop - Core implementation
 * @module lib/engine/query
 * @see docs/specs/agent-loop.md
 */

import type { QueryContext, QueryEvent, UsageStats, Message, MessageContent } from './types'
import type { Tool, ToolCall, ToolResult, ToolProgress } from '../tools/types'
import { prepareCall, executeCall, canRunInParallel } from '../tools/executor'
import { buildToolUseContext } from './tool-context'
import { SimpleRunLogger } from './logger'
import { streamModel } from './model'

/**
 * Main query loop - async generator that yields events
 * @see docs/specs/agent-loop.md §1
 */
export async function* runQuery(ctx: QueryContext): AsyncGenerator<QueryEvent> {
  const logger = new SimpleRunLogger(ctx.runId)
  let turn = 0
  let totalToolCalls = 0
  const usage: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    turns: 0,
    toolCalls: 0,
  }

  // M1-12: Internal controller so an early generator exit (gen.return())
  // also cancels in-flight model requests / tools, not just external abort()
  const internal = new AbortController()
  const unlink = linkAbort(ctx.signal, internal)
  const runCtx: QueryContext = { ...ctx, signal: internal.signal }

  // Current conversation state (reconstructed per turn)
  let currentMessages = [...ctx.messages]

  try {
    yield { type: 'run.started', runId: ctx.runId }
    logger.log('run.started', { runId: ctx.runId, conversationId: ctx.conversationId })

    // Main agent loop: continue until completion or limit reached
    while (turn < ctx.limits.maxTurns) {
      turn++
      usage.turns = turn
      logger.log('turn.started', { turn })

      // Check abort signal
      if (runCtx.signal.aborted) {
        throw new Error('Aborted')
      }

      // Build messages with context assembly (M1-04)
      // Note: streamModel() will call buildMessages() internally
      logger.log('turn.preparing', { turn })

      // Stream model response (M1-05, M1-06, M1-07)
      const response = yield* streamModelResponse({
        ...runCtx,
        messages: currentMessages,
      }, logger)

      // Accumulate token usage
      if (response.usage) {
        usage.inputTokens += response.usage.inputTokens
        usage.outputTokens += response.usage.outputTokens
        usage.totalTokens += response.usage.totalTokens
      }

      // Handle stop reason (M1-10)
      if (response.stopReason === 'max_tokens') {
        yield { type: 'run.exhausted', reason: 'max_tokens' }
        logger.log('run.exhausted', { reason: 'stop_reason_max_tokens', usage })
        return
      }

      // Check token budget
      if (usage.totalTokens > ctx.limits.maxTokens) {
        yield { type: 'run.exhausted', reason: 'max_tokens' }
        logger.log('run.exhausted', { reason: 'max_tokens', usage })
        return
      }

      // If no tool calls, we're done (stop_reason: end_turn)
      if (response.toolCalls.length === 0) {
        yield { type: 'message.completed', content: response.text }
        logger.log('message.completed', {
          textLength: response.text.length,
          stopReason: response.stopReason || 'end_turn'
        })
        break
      }

      // Check tool call limit
      totalToolCalls += response.toolCalls.length
      usage.toolCalls = totalToolCalls
      if (totalToolCalls > ctx.limits.maxToolCalls) {
        yield { type: 'run.exhausted', reason: 'max_tool_calls' }
        logger.log('run.exhausted', { reason: 'max_tool_calls', totalToolCalls })
        return
      }

      // Execute tools (M1-14, M1-15, M1-16)
      const results = yield* executeTools(runCtx, response.toolCalls, logger)

      // Append assistant message with tool calls
      const assistantMessage: Message = {
        role: 'assistant',
        content: buildAssistantContent(response.text, response.toolCalls)
      }
      currentMessages = [...currentMessages, assistantMessage]

      // Append tool results as next message
      const toolResultContent: MessageContent[] = results.flatMap((result) => {
        const content: MessageContent[] = [{
          type: 'tool_result',
          tool_use_id: result.callId,
          content: result.content,
          is_error: !result.success,
        }]
        const imageUrl = getToolImageUrl(result)
        if (imageUrl) content.push({ type: 'image_url', image_url: { url: imageUrl } })
        return content
      })
      const toolResultMessage: Message = {
        role: 'user',
        content: toolResultContent,
      }
      currentMessages = [...currentMessages, toolResultMessage]

      logger.log('turn.completed', { turn, toolCalls: response.toolCalls.length })

      // M1-13: Snapshot after each completed turn for crash recovery.
      // Snapshot failure must not kill the run (tombstone principle)
      if (ctx.snapshots) {
        try {
          await ctx.snapshots.append(ctx.conversationId, {
            turn,
            messages: currentMessages,
            usage: { ...usage },
            ts: new Date().toISOString(),
          })
          logger.log('snapshot.written', { turn })
        } catch (snapshotError) {
          logger.warn('snapshot.failed', {
            turn,
            error: snapshotError instanceof Error
              ? snapshotError.message
              : String(snapshotError),
          })
        }
      }
    }

    // Check if we hit max turns
    if (turn >= ctx.limits.maxTurns) {
      yield { type: 'run.exhausted', reason: 'max_turns' }
      logger.log('run.exhausted', { reason: 'max_turns', turns: turn })
      return
    }

    yield { type: 'run.completed', usage }
    logger.log('run.completed', { usage })

  } catch (error) {
    if (ctx.signal.aborted) {
      yield {
        type: 'run.failed',
        error: { kind: 'aborted', message: 'Run was aborted by user' },
      }
      logger.log('run.aborted')
    } else {
      yield {
        type: 'run.failed',
        error: {
          kind: 'internal',
          message: error instanceof Error ? error.message : String(error),
        },
      }
      logger.error('run.failed', error)
    }
  } finally {
    // M1-12: Cancel any in-flight work (model HTTP request, running tools).
    // Reached on normal completion, throw, AND consumer gen.return()
    internal.abort()
    unlink()
    await logger.flush()
  }
}

function getToolImageUrl(result: ToolResult): string | undefined {
  if (!result.success || !result.data || typeof result.data !== 'object') return undefined
  const imageDataUrl = (result.data as Record<string, unknown>).imageDataUrl
  return typeof imageDataUrl === 'string' && imageDataUrl.startsWith('data:image/')
    ? imageDataUrl
    : undefined
}

/**
 * Link an external abort signal into a controller
 * Returns an unlink function to remove the listener (avoid leaks on reuse)
 * M1-12
 */
function linkAbort(external: AbortSignal, controller: AbortController): () => void {
  if (external.aborted) {
    controller.abort()
    return () => {}
  }
  const onAbort = () => controller.abort()
  external.addEventListener('abort', onAbort, { once: true })
  return () => external.removeEventListener('abort', onAbort)
}

/**
 * Stream model response and yield text/tool_call events
 * @see docs/specs/agent-loop.md §5
 */
async function* streamModelResponse(
  ctx: QueryContext,
  logger: SimpleRunLogger
): AsyncGenerator<QueryEvent, {
  text: string
  toolCalls: ToolCall[]
  usage?: UsageStats
  stopReason?: string
}> {
  let accumulatedText = ''
  const toolCalls: ToolCall[] = []
  const toolCallBuilders = new Map<string, { id: string; name: string; input: string }>()
  let usage: UsageStats | undefined
  let stopReason: string | undefined

  try {
    // Call model gateway (M1-05) - streamModel uses ctx internally
    for await (const chunk of streamModel(ctx)) {
      // Check abort signal
      if (ctx.signal.aborted) {
        throw new Error('Aborted')
      }

      switch (chunk.type) {
        case 'content_delta':
          accumulatedText += chunk.delta
          yield { type: 'message.delta', text: chunk.delta }
          break

        case 'tool_call_start':
          // Start building a new tool call
          toolCallBuilders.set(chunk.id, {
            id: chunk.id,
            name: chunk.name,
            input: ''
          })
          logger.log('tool_call.start', { callId: chunk.id, name: chunk.name })
          break

        case 'tool_call_delta': {
          // Accumulate input JSON
          const builder = toolCallBuilders.get(chunk.id)
          if (builder) {
            builder.input += chunk.delta
          }
          break
        }

        case 'tool_call_end': {
          // Finalize tool call
          const builder = toolCallBuilders.get(chunk.id)
          if (builder) {
            const toolCall: ToolCall = {
              id: builder.id,
              name: builder.name,
              input: chunk.input // Use the parsed input from chunk
            }
            toolCalls.push(toolCall)
            yield { type: 'tool.requested', call: toolCall }
            logger.log('tool_call.complete', {
              callId: toolCall.id,
              name: toolCall.name
            })
            toolCallBuilders.delete(chunk.id)
          }
          break
        }

        case 'message_end':
          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.inputTokens,
              outputTokens: chunk.usage.outputTokens,
              totalTokens: chunk.usage.totalTokens || (chunk.usage.inputTokens + chunk.usage.outputTokens),
              turns: 0,
              toolCalls: 0
            }
            logger.log('usage', usage)
          }
          if (chunk.stopReason) {
            stopReason = chunk.stopReason
            logger.log('stop_reason', { stopReason })
          }
          break

        case 'error': {
          // M1-11: Distinguish between recoverable and fatal errors
          if (chunk.error.recoverable) {
            // Emit tombstone for recoverable parse errors and continue
            yield {
              type: 'tombstone',
              reason: 'sse_parse_error',
              detail: {
                message: chunk.error.message,
                kind: chunk.error.kind,
              }
            }
            logger.warn('stream.recoverable_error', chunk.error)
            // Continue processing next frames
            break
          } else {
            // Fatal error - throw and stop processing
            logger.error('stream.fatal_error', chunk.error)
            throw new Error(`Model error: ${chunk.error.message}`)
          }
        }

        // Ignore other event types (message_start, content_start, content_end, ping)
        default:
          break
      }
    }

    return { text: accumulatedText, toolCalls, usage, stopReason }

  } catch (error) {
    logger.error('stream.failed', error)
    throw error
  }
}

/**
 * Execute tool calls and yield progress events
 * Dispatch pipeline lives in tools/executor.ts (M1-14/15/16):
 * prepare (lookup → availability → schema) → execute (timeout/retry) → normalize
 * Tombstones for recoverable errors per M1-11; abort semantics per M1-12.
 * @see docs/specs/tool-interface.md §4 (流程), §5 (并发)
 */
async function* executeTools(
  ctx: QueryContext,
  calls: ToolCall[],
  logger: SimpleRunLogger
): AsyncGenerator<QueryEvent, Array<ToolResult & { callId: string }>> {
  logger.log('tools.executing', { count: calls.length })

  const results: Array<ToolResult & { callId: string }> = []
  const toolCtx = buildToolUseContext(ctx, logger)

  // Steps ①②③ per call; failures feed back immediately so the model
  // can self-correct, with tombstones for the recoverable cases (M1-11)
  const runnable: Array<{ call: ToolCall; tool: Tool }> = []
  for (const call of calls) {
    const prep = prepareCall(call, ctx.tools, ctx.platform)
    if (prep.ok) {
      runnable.push({ call, tool: prep.tool })
      continue
    }

    if (prep.tombstone) {
      yield {
        type: 'tombstone',
        reason: prep.tombstone.reason,
        detail: prep.tombstone.detail
      }
    }
    const result = { ...prep.result, callId: call.id }
    results.push(result)
    yield { type: 'tool.completed', callId: call.id, result }
    logger.log('tool.rejected', {
      callId: call.id,
      name: call.name,
      kind: prep.result.error?.kind,
      tombstone: prep.tombstone?.reason
    })
  }

  const makeOpts = (call: ToolCall) => ({
    ctx: toolCtx,
    signal: ctx.signal,
    defaultTimeoutMs: ctx.limits.toolTimeoutMs,
    onProgress: (p: ToolProgress) =>
      logger.log('tool.progress', { callId: call.id, ...p }),
  })

  // M1-15: Parallel only when EVERY tool is readOnly && concurrencySafe.
  // Start all, then yield completions in model-returned order.
  if (canRunInParallel(runnable.map(r => r.call), ctx.tools)) {
    for (const { call } of runnable) {
      yield {
        type: 'tool.progress',
        callId: call.id,
        progress: { phase: 'executing', current: 0 }
      }
    }

    const promises = runnable.map(({ tool, call }) =>
      executeCall(tool, call, makeOpts(call))
    )
    for (let i = 0; i < runnable.length; i++) {
      const { call } = runnable[i]
      const result = { ...(await promises[i]), callId: call.id }
      results.push(result)
      yield { type: 'tool.completed', callId: call.id, result }
      logger.log('tool.completed', {
        callId: call.id,
        name: call.name,
        success: result.success,
        durationMs: result.metadata?.durationMs
      })
    }
    return results
  }

  // Serial path, model-returned order
  for (let i = 0; i < runnable.length; i++) {
    const { call, tool } = runnable[i]

    // M1-12: Stop between tools on abort. Completed results are preserved
    // (already yielded + in results); remaining calls get synthetic aborted
    // results so every tool_use in history has a matching tool_result.
    if (ctx.signal.aborted) {
      for (const { call: remaining } of runnable.slice(i)) {
        const result: ToolResult & { callId: string } = {
          callId: remaining.id,
          success: false,
          content: 'Tool execution aborted by user',
          error: {
            kind: 'aborted',
            message: 'Run was aborted before this tool executed',
            recoverable: false
          },
          metadata: { durationMs: 0 }
        }
        results.push(result)
        yield { type: 'tool.completed', callId: remaining.id, result }
        logger.log('tool.aborted', { callId: remaining.id, name: remaining.name })
      }
      break
    }

    yield {
      type: 'tool.progress',
      callId: call.id,
      progress: { phase: 'executing', current: 0 }
    }

    const result = { ...(await executeCall(tool, call, makeOpts(call))), callId: call.id }
    results.push(result)
    yield { type: 'tool.completed', callId: call.id, result }
    logger.log('tool.completed', {
      callId: call.id,
      name: call.name,
      success: result.success,
      durationMs: result.metadata?.durationMs
    })
  }

  return results
}

/**
 * Build assistant message content with text and tool calls
 */
function buildAssistantContent(text: string, toolCalls: ToolCall[]) {
  if (toolCalls.length === 0) {
    return text
  }

  const content = []

  if (text.trim()) {
    content.push({ type: 'text' as const, text })
  }

  for (const call of toolCalls) {
    content.push({
      type: 'tool_use' as const,
      id: call.id,
      name: call.name,
      input: call.input
    })
  }

  return content
}
