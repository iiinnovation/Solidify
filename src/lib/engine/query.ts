/**
 * Agent query loop - Core implementation
 * @module lib/engine/query
 * @see docs/specs/agent-loop.md
 */

import type { QueryContext, QueryEvent } from './types'
import { SimpleRunLogger } from './logger'

/**
 * Main query loop - async generator that yields events
 * @see docs/specs/agent-loop.md §1
 */
export async function* runQuery(ctx: QueryContext): AsyncGenerator<QueryEvent> {
  const logger = new SimpleRunLogger(ctx.runId)
  let turn = 0
  const totalToolCalls = 0

  try {
    yield { type: 'run.started', runId: ctx.runId }
    logger.log('run.started', { runId: ctx.runId, conversationId: ctx.conversationId })

    while (turn < ctx.limits.maxTurns) {
      turn++
      logger.log('turn.started', { turn })

      // TODO M1-04: Build messages with context assembly
      // const messages = await buildMessages(ctx)

      // TODO M1-05: Stream model response
      // const response = yield* streamModel(ctx, messages)

      // Stub: For now just complete immediately
      yield {
        type: 'message.completed',
        content: 'Query loop stub - M1-04 will implement full loop',
      }

      logger.log('turn.completed', { turn })

      // Exit after first turn in stub
      break

      // TODO M1-06: Tool execution
      // if (response.toolCalls.length === 0) {
      //   yield { type: 'message.completed', content: response.text }
      //   break
      // }

      // Check tool call limit
      // totalToolCalls += response.toolCalls.length
      // if (totalToolCalls > ctx.limits.maxToolCalls) {
      //   yield { type: 'run.exhausted', reason: 'max_tool_calls' }
      //   return
      // }

      // const results = yield* executeTools(ctx, response.toolCalls)
      // ctx = appendResults(ctx, response, results)
    }

    yield {
      type: 'run.completed',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        turns: turn,
        toolCalls: totalToolCalls,
      },
    }

    logger.log('run.completed', { turn, totalToolCalls })
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
 * Execute tool calls and yield progress events
 * TODO M1-06: Implement tool execution with concurrency control
 * @see docs/specs/agent-loop.md §4
 */
// async function* _executeTools(
//   _ctx: QueryContext,
//   _calls: ToolCall[],
// ): AsyncGenerator<QueryEvent, ToolResult[]> {
//   // - Check if all tools are concurrencySafe && readOnly
//   // - If yes, run in parallel
//   // - Otherwise, run serially
//   // - Yield progress events
//   // - Handle errors with tombstoning
//   return []
// }

/**
 * Stream model response and yield text/tool_call deltas
 * TODO M1-05: Implement model gateway streaming
 * @see docs/specs/agent-loop.md §5
 */
// async function* _streamModel(
//   _ctx: QueryContext,
//   _messages: unknown[],
// ): AsyncGenerator<QueryEvent, { text: string; toolCalls: ToolCall[] }> {
//   // - Call gateway.stream()
//   // - Yield message.delta for text chunks
//   // - Accumulate tool calls
//   // - Return final response
//   return { text: '', toolCalls: [] }
// }
