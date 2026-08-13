/**
 * Agent query loop - Core implementation
 * @module lib/engine/query
 * @see docs/specs/agent-loop.md
 */

import type { QueryContext, QueryEvent, UsageStats, Message } from './types'
import type { ToolCall, ToolResult } from '../tools/types'
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
      if (ctx.signal.aborted) {
        throw new Error('Aborted')
      }

      // Build messages with context assembly (M1-04)
      // Note: streamModel() will call buildMessages() internally
      logger.log('turn.preparing', { turn })

      // Stream model response (M1-05, M1-06, M1-07)
      const response = yield* streamModelResponse({
        ...ctx,
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
      const results = yield* executeTools(ctx, response.toolCalls, logger)

      // Append assistant message with tool calls
      const assistantMessage: Message = {
        role: 'assistant',
        content: buildAssistantContent(response.text, response.toolCalls)
      }
      currentMessages = [...currentMessages, assistantMessage]

      // Append tool results as next message
      const toolResultMessage: Message = {
        role: 'user',
        content: results.map(r => ({
          type: 'tool_result' as const,
          tool_use_id: r.callId,
          content: r.content,
          is_error: !r.success
        }))
      }
      currentMessages = [...currentMessages, toolResultMessage]

      logger.log('turn.completed', { turn, toolCalls: response.toolCalls.length })
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
    await logger.flush()
  }
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

        case 'error':
          logger.error('stream.error', chunk.error)
          throw new Error(`Model error: ${chunk.error.message}`)

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
 * TODO M1-14: Implement actual tool execution with validation
 * TODO M1-15: Implement concurrency control
 * TODO M1-16: Implement timeout and retry
 * @see docs/specs/agent-loop.md §4
 */
async function* executeTools(
  _ctx: QueryContext,
  calls: ToolCall[],
  logger: SimpleRunLogger
): AsyncGenerator<QueryEvent, Array<ToolResult & { callId: string }>> {
  logger.log('tools.executing', { count: calls.length })

  // Stub implementation: just return placeholder results
  // M1-14 will implement actual execution
  const results: Array<ToolResult & { callId: string }> = []

  for (const call of calls) {
    // Yield tool execution started
    yield {
      type: 'tool.progress',
      callId: call.id,
      progress: { phase: 'executing', current: 0 }
    }

    // Stub result
    const result: ToolResult & { callId: string } = {
      callId: call.id,
      success: false,
      content: `Tool execution not yet implemented (M1-14). Called: ${call.name}`,
      error: {
        kind: 'runtime',
        message: 'Tool execution stub - M1-14 will implement',
        recoverable: false
      },
      metadata: {
        durationMs: 0
      }
    }

    results.push(result)

    // Yield completion
    yield {
      type: 'tool.completed',
      callId: call.id,
      result
    }

    logger.log('tool.completed', {
      callId: call.id,
      name: call.name,
      success: result.success
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
