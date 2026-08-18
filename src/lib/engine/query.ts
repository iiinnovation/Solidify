/**
 * Agent query loop - Core implementation
 * @module lib/engine/query
 * @see docs/specs/agent-loop.md
 */

import type { QueryContext, QueryEvent, UsageStats, Message, MessageContent, RunError } from './types'
import type { Tool, ToolCall, ToolResult, ToolProgress } from '../tools/types'
import { prepareCall, executeCall, canRunInParallel } from '../tools/executor'
import { buildToolUseContext } from './tool-context'
import { SimpleRunLogger } from './logger'
import { streamModel } from './model'
import { isEnabled } from '../harness/flags'
import { createHarnessRuntime, hardGuard, recordToolCompleted, recordToolRequested, sessionGrantKey, type HarnessRuntime } from '../harness/builtin-hooks'
import { readWorkspaceFile } from '../tauri'
import { snapshotJson } from '../harness/ledger'

/**
 * How many times a single answer may be resumed after hitting the model's
 * output ceiling. Bounded so a model that never emits a stop sequence cannot
 * spin, but high enough that a full deck fits.
 */
const MAX_CONTINUATIONS = 4

/**
 * Drop the trailing assistant prefill so a resumed answer replaces it instead
 * of stacking a second assistant turn. Matched by content rather than assumed
 * to be last: a before_model_call hook may have rewritten the list in between.
 */
function dropPrefill(messages: Message[], prefill: string): Message[] {
  if (!prefill) return messages
  const last = messages.at(-1)
  return last?.role === 'assistant' && last.content === prefill ? messages.slice(0, -1) : messages
}

/**
 * Main query loop - async generator that yields events
 * @see docs/specs/agent-loop.md §1
 */
export async function* runQuery(ctx: QueryContext): AsyncGenerator<QueryEvent> {
  const logger = new SimpleRunLogger(ctx.runId)
  let turn = 0
  let totalToolCalls = 0
  let completed = false
  let continuations = 0
  let prefill = ''
  // `usage.totalTokens` remains the provider-reported cost for telemetry. The
  // run budget deliberately does not charge the same history input again on
  // every turn: only the first input plus all generated output counts toward
  // the progress budget.
  let budgetTokens = 0
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
  const harness = isEnabled('harness') ? createHarnessRuntime(runCtx, { skillRegistry: runCtx.skillRegistry }) : undefined

  // Current conversation state (reconstructed per turn or restored from the
  // last completed tool turn after a renderer restart).
  let currentMessages = [...ctx.messages]
  let harnessContext = [...(ctx.harnessContext ?? [])]
  let retrievedContext = ctx.retrievedContext
  let isFirstTurn = true

  try {
    harness?.ledger.append('run.started', {
      conversationId: ctx.conversationId,
      parentRunId: ctx.parentRunId ?? null,
      model: {
        provider: ctx.model.provider,
        model: ctx.model.model,
        temperature: ctx.model.temperature,
      },
      skill: ctx.skill ? {
        name: ctx.skill.metadata.name,
        version: ctx.skill.metadata.version,
        source: ctx.skill.source ?? ctx.skill.metadata.source,
      } : null,
    })
    yield { type: 'run.started', runId: ctx.runId }
    logger.log('run.started', { runId: ctx.runId, conversationId: ctx.conversationId })
    if (harness) {
      const beforeQuery = await harness.hooks.waterfall('before_query', { messages: currentMessages }, { type: 'before_query', runId: ctx.runId, signal: runCtx.signal, onHookError: (id, error) => logger.warn('hook.failed', { id, error: String(error) }) })
      if (beforeQuery.action === 'abort') throw new Error(beforeQuery.reason)
      if (beforeQuery.action === 'continue' && typeof beforeQuery.value === 'object' && beforeQuery.value) {
        const envelope = beforeQuery.value as { context?: unknown; retrievedContext?: unknown }
        if (Array.isArray(envelope.context)) {
          harnessContext = envelope.context.filter((text): text is string => typeof text === 'string')
        }
        if (typeof envelope.retrievedContext === 'string') {
          retrievedContext = envelope.retrievedContext
        }
      }
    }

    if (!ctx.restoreSnapshot && ctx.snapshots) {
      await clearSnapshot(ctx, logger)
    } else if (ctx.restoreSnapshot && ctx.snapshots) {
      try {
        const snapshot = await ctx.snapshots.loadLatest(ctx.conversationId)
        if (!snapshot) {
          logger.warn('snapshot.missing', {
            fallback: 'conversation_history',
            messageCount: currentMessages.length,
          })
        } else if (snapshot.runId !== ctx.runId) {
          throw new Error('The recoverable Agent snapshot belongs to a different run')
        } else {
          turn = snapshot.turn
          isFirstTurn = turn === 0
          currentMessages = [...snapshot.messages]
          Object.assign(usage, snapshot.usage)
          // New snapshots persist the de-duplicated progress charge. Older
          // snapshots predate that field, so use their provider total as a
          // conservative fallback instead of silently resetting the budget.
          budgetTokens = snapshot.budgetTokens ?? snapshot.usage.totalTokens
          totalToolCalls = snapshot.usage.toolCalls
          logger.log('snapshot.restored', { turn, messageCount: currentMessages.length })
        }
      } catch (snapshotError) {
        logger.warn('snapshot.restore_failed', {
          error: snapshotError instanceof Error
            ? snapshotError.message
            : String(snapshotError),
        })
        throw snapshotError
      }
    }

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
      if (harness) {
        const beforeModel = await harness.hooks.waterfall('before_model_call', { messages: currentMessages, usage, budgetTokens }, { type: 'before_model_call', runId: ctx.runId, signal: runCtx.signal, onHookError: (id, error) => logger.warn('hook.failed', { id, error: String(error) }) })
        if (beforeModel.action === 'abort') throw new Error(beforeModel.reason)
        if (beforeModel.action === 'continue' && isMessageEnvelope(beforeModel.value)) currentMessages = [...beforeModel.value.messages]
      }

      // Stream model response (M1-05, M1-06, M1-07)
      let response: { text: string; toolCalls: ToolCall[]; usage?: UsageStats; stopReason?: string }
      try {
        response = yield* streamModelResponse({
          ...runCtx,
          messages: currentMessages,
          harnessContext,
          retrievedContext: isFirstTurn ? retrievedContext : undefined,
        }, logger, {
          onModelPrepared: harness ? (request) => { harness.ledger.append('model.called', { turn, request }) } : undefined,
          onToolRequested: harness ? (call) => recordToolRequested(harness, call) : undefined,
        })
      } catch (error) {
        harness?.ledger.append('model.failed', { turn, message: error instanceof Error ? error.message : String(error) })
        throw error
      }
      // Retrieved workspace memory is useful for grounding the initial request;
      // subsequent turns should rely on the conversation and tool results.
      isFirstTurn = false
      harness?.ledger.append('model.completed', { turn, text: response.text, toolCalls: response.toolCalls, usage: response.usage, stopReason: response.stopReason })
      await harness?.hooks.observe('after_model_call', { type: 'after_model_call', runId: ctx.runId, response, onHookError: (id, error) => logger.warn('hook.failed', { id, error: String(error) }) })

      // Accumulate token usage
      if (response.usage) {
        usage.inputTokens += response.usage.inputTokens
        usage.outputTokens += response.usage.outputTokens
        usage.totalTokens += response.usage.totalTokens
        const charge = response.usage.outputTokens + (turn === 1 ? response.usage.inputTokens : 0)
        budgetTokens += charge
        if (runCtx.taskTree && !runCtx.taskTree.budget.consume(runCtx.runId, charge)) {
          harness?.ledger.append('run.exhausted', {
            reason: 'max_tokens',
            scope: 'task_tree',
            usage,
            budget: runCtx.taskTree.budget.snapshot(),
          })
          yield { type: 'run.exhausted', reason: 'max_tokens', usage: { ...usage } }
          logger.log('run.exhausted', { reason: 'task_tree_max_tokens', usage })
          return
        }
      }

      // Handle stop reason (M1-10)
      // A deliverable longer than one output window is ordinary, not a failure:
      // resume from the partial text so the artifact envelope can still close.
      // Truncated tool calls are not resumable — their JSON arguments are cut
      // mid-object — so those still end the run rather than risk replaying a
      // malformed call.
      if (response.stopReason === 'max_tokens' && response.toolCalls.length === 0 && response.text.trim() && continuations < MAX_CONTINUATIONS) {
        // The whole partial answer travels as ONE assistant message: providers
        // reject two assistant turns in a row, and Anthropic rejects a prefill
        // that ends in whitespace.
        const resumed = `${prefill}${response.text}`.replace(/\s+$/, '')
        if (resumed) {
          continuations++
          currentMessages = [...dropPrefill(currentMessages, prefill), { role: 'assistant', content: resumed }]
          prefill = resumed
          logger.log('turn.continued', { turn, continuations, reason: 'max_tokens' })
          continue
        }
      }

      if (response.stopReason === 'max_tokens') {
        harness?.ledger.append('run.exhausted', { reason: 'max_tokens', usage })
        yield { type: 'run.exhausted', reason: 'max_tokens', usage: { ...usage } }
        logger.log('run.exhausted', { reason: 'stop_reason_max_tokens', usage })
        return
      }

      // Check token budget
      // Let a tool call already emitted by the model run once so a deliverable
      // is not discarded merely because the preceding input was large.
      if (budgetTokens > ctx.limits.maxTokens && response.toolCalls.length === 0) {
        harness?.ledger.append('run.exhausted', { reason: 'max_tokens', usage })
        yield { type: 'run.exhausted', reason: 'max_tokens', usage: { ...usage } }
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
        completed = true
        break
      }

      // Check tool call limit
      totalToolCalls += response.toolCalls.length
      usage.toolCalls = totalToolCalls
      if (totalToolCalls > ctx.limits.maxToolCalls) {
        harness?.ledger.append('run.exhausted', { reason: 'max_tool_calls', usage })
        yield { type: 'run.exhausted', reason: 'max_tool_calls', usage: { ...usage } }
        logger.log('run.exhausted', { reason: 'max_tool_calls', totalToolCalls })
        return
      }

      // Execute tools (M1-14, M1-15, M1-16)
      // Tool input repairs (for example resolving a mistaken read_handle
      // placeholder) need the latest tool-result messages, not only the
      // immutable context from the start of the run.
      const results = yield* executeTools({ ...runCtx, messages: currentMessages }, response.toolCalls, logger, harness)

      // Some deterministic generators own their final artifact contract. Their
      // tool result stores the complete assistant payload behind a memory
      // handle so it bypasses another lossy model round and the normal 24KB tool
      // result clipping boundary.
      const directAssistant = await readDirectAssistantContent(results, runCtx)
      if (directAssistant) {
        usage.inputTokens += directAssistant.usage.inputTokens
        usage.outputTokens += directAssistant.usage.outputTokens
        usage.totalTokens += directAssistant.usage.totalTokens
        budgetTokens += directAssistant.usage.outputTokens
        yield { type: 'message.delta', text: directAssistant.content }
        yield { type: 'message.completed', content: directAssistant.content }
        harness?.ledger.append('artifact.created', { id: directAssistant.callId, ...directAssistant.artifact })
        completed = true
        break
      }

      // generate_pptd owns a stateful, one-shot pipeline. If it fails after
      // starting, feeding the error back to the model invites a second call
      // that can never succeed and only produces the misleading "already
      // started" guard error. Preserve the original pipeline failure and end
      // this run; the user can start a fresh run after adjusting the brief.
      const failedPptd = results.find((result) =>
        !result.success
        && response.toolCalls.some((call) => call.id === result.callId && call.name === 'generate_pptd'),
      )
      if (failedPptd) {
        const message = failedPptd.error?.message || failedPptd.content || 'generate_pptd 执行失败'
        const error: RunError = { kind: 'internal', message }
        appendTerminalFact(harness, logger, 'run.failed', { ...error, usage })
        yield { type: 'run.failed', error, usage: { ...usage } }
        logger.error('run.failed', error)
        return
      }

      if (budgetTokens > ctx.limits.maxTokens) {
        harness?.ledger.append('run.exhausted', { reason: 'max_tokens', usage })
        yield { type: 'run.exhausted', reason: 'max_tokens', usage: { ...usage } }
        logger.log('run.exhausted', { reason: 'progress_budget', usage, budgetTokens })
        return
      }

      // Append assistant message with tool calls
      // A resumed answer already sits in the trailing prefill message; fold it
      // in rather than appending a second assistant turn.
      const assistantMessage: Message = {
        role: 'assistant',
        content: buildAssistantContent(prefill + response.text, response.toolCalls)
      }
      currentMessages = [...dropPrefill(currentMessages, prefill), assistantMessage]
      prefill = ''

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
            runId: ctx.runId,
            turn,
            messages: currentMessages,
            usage: { ...usage },
            budgetTokens,
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

    // Only exhausted if the loop ran out of turns. A run that produced its final
    // answer on the last allowed turn completed normally — reporting it as
    // exhausted would suppress run.completed, the usage payload, the
    // on_run_completed hook and snapshot cleanup.
    if (!completed && turn >= ctx.limits.maxTurns) {
      harness?.ledger.append('run.exhausted', { reason: 'max_turns', usage })
      yield { type: 'run.exhausted', reason: 'max_turns', usage: { ...usage } }
      logger.log('run.exhausted', { reason: 'max_turns', turns: turn })
      return
    }

    harness?.ledger.append('run.completed', usage)
    yield { type: 'run.completed', usage }
    logger.log('run.completed', { usage })
    await harness?.hooks.observe('on_run_completed', { type: 'on_run_completed', runId: ctx.runId, usage, onHookError: (id, error) => logger.warn('hook.failed', { id, error: String(error) }) })
    // Only the restore path clears here; a normal run's snapshot is cleared when
    // the next run starts (see the !restoreSnapshot branch above), which keeps it
    // available as a resume point if the renderer dies right after completion.
    if (ctx.restoreSnapshot) await clearSnapshot(ctx, logger)

  } catch (error) {
    await harness?.hooks.observe('on_error', { type: 'on_error', runId: ctx.runId, error, onHookError: (id, hookError) => logger.warn('hook.failed', { id, error: String(hookError) }) })
    if (ctx.taskTree?.budget.abortReason === 'budget_exhausted') {
      appendTerminalFact(harness, logger, 'run.exhausted', {
        reason: 'max_tokens',
        scope: 'task_tree',
        usage,
        budget: ctx.taskTree.budget.snapshot(),
      })
      yield { type: 'run.exhausted', reason: 'max_tokens', usage: { ...usage } }
      logger.log('run.exhausted', { reason: 'task_tree_max_tokens', usage })
    } else if (error instanceof Error && error.message === 'Run token budget exhausted') {
      appendTerminalFact(harness, logger, 'run.exhausted', { reason: 'max_tokens', usage, budgetTokens })
      yield { type: 'run.exhausted', reason: 'max_tokens', usage: { ...usage } }
      logger.log('run.exhausted', { reason: 'progress_budget', usage, budgetTokens })
    } else if (ctx.signal.aborted) {
      appendTerminalFact(harness, logger, 'run.failed', { kind: 'aborted', message: 'Run was aborted by user', usage })
      yield {
        type: 'run.failed',
        error: { kind: 'aborted', message: 'Run was aborted by user' },
        usage: { ...usage },
      }
      logger.log('run.aborted')
    } else {
      const message = error instanceof Error ? error.message : String(error)
      const kind = error instanceof ModelStreamError ? error.runErrorKind : 'internal'
      appendTerminalFact(harness, logger, 'run.failed', { kind, message, usage })
      yield {
        type: 'run.failed',
        error: { kind, message },
        usage: { ...usage },
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

interface DirectAssistantToolData {
  directAssistantContent: true
  contentHandle: string
  artifact: { title: string; type: string; path: string }
  usage: { inputTokens: number; outputTokens: number; totalTokens: number }
}

async function readDirectAssistantContent(
  results: Array<ToolResult & { callId: string }>,
  ctx: QueryContext,
): Promise<{ callId: string; content: string; artifact: DirectAssistantToolData['artifact']; usage: DirectAssistantToolData['usage'] } | undefined> {
  const direct = results.find((result) => isDirectAssistantToolData(result.data))
  if (!direct || !isDirectAssistantToolData(direct.data)) return undefined
  const content = await ctx.memory.retrieve(direct.data.contentHandle)
  if (!content) throw new Error(`无法读取工具生成的最终 artifact：${direct.data.contentHandle}`)
  return { callId: direct.callId, content, artifact: direct.data.artifact, usage: direct.data.usage }
}

function isDirectAssistantToolData(value: unknown): value is DirectAssistantToolData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const data = value as Record<string, unknown>
  const artifact = data.artifact as Record<string, unknown> | undefined
  const usage = data.usage as Record<string, unknown> | undefined
  return data.directAssistantContent === true
    && typeof data.contentHandle === 'string'
    && Boolean(artifact && typeof artifact.title === 'string' && typeof artifact.type === 'string' && typeof artifact.path === 'string')
    && Boolean(usage && typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number' && typeof usage.totalTokens === 'number')
}

/**
 * Fatal model-stream failure that preserves the provider's classification.
 * Without this every API failure surfaced as `kind: 'internal'`, so the UI could
 * never tell a 429 from a genuine bug and the RunError union's rate_limit /
 * api_error / timeout variants were unreachable.
 */
class ModelStreamError extends Error {
  readonly runErrorKind: RunError['kind']
  readonly retryable: boolean

  constructor(error: { message: string; type?: string; retryable?: boolean }) {
    super(`Model error: ${error.message}`)
    this.name = 'ModelStreamError'
    this.retryable = error.retryable === true
    switch (error.type) {
      case 'rate_limit': this.runErrorKind = 'rate_limit'; break
      case 'timeout': this.runErrorKind = 'timeout'; break
      case 'api_error':
      case 'network':
      case 'invalid_request':
      case 'authentication': this.runErrorKind = 'api_error'; break
      default: this.runErrorKind = 'internal'
    }
  }
}

async function clearSnapshot(ctx: QueryContext, logger: SimpleRunLogger): Promise<void> {
  if (!ctx.snapshots) return
  try {
    await ctx.snapshots.clear(ctx.conversationId)
    logger.log('snapshot.cleared')
  } catch (snapshotError) {
    logger.warn('snapshot.clear_failed', {
      error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
    })
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
  logger: SimpleRunLogger,
  callbacks: {
    onModelPrepared?: Parameters<typeof streamModel>[1]
    onToolRequested?: (call: ToolCall) => void | Promise<void>
  } = {},
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
    for await (const chunk of streamModel(ctx, callbacks.onModelPrepared)) {
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
            const toolCall = snapshotJson({
              id: builder.id,
              name: builder.name,
              input: chunk.input // Use the parsed input from chunk
            }) as unknown as ToolCall
            toolCalls.push(toolCall)
            await callbacks.onToolRequested?.(toolCall)
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
            // Fatal error - throw and stop processing. The provider's
            // classification is carried on the thrown error so the terminal
            // run.failed can distinguish "retry in a minute" (rate_limit /
            // api_error) from "your code is broken" (internal).
            logger.error('stream.fatal_error', chunk.error)
            throw new ModelStreamError(chunk.error)
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
  logger: SimpleRunLogger,
  harness?: HarnessRuntime,
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
    harness?.ledger.append('tool.completed', { callId: call.id, success: result.success, content: result.content, error: result.error, metadata: result.metadata })
    yield { type: 'tool.completed', callId: call.id, result }
    logger.log('tool.rejected', {
      callId: call.id,
      name: call.name,
      kind: prep.result.error?.kind,
      tombstone: prep.tombstone?.reason
    })
  }

  const makeOpts = (call: ToolCall, relay?: (progress: ToolProgress) => void) => ({
    ctx: toolCtx,
    signal: ctx.signal,
    defaultTimeoutMs: ctx.limits.toolTimeoutMs,
    onProgress: (p: ToolProgress) => {
      logger.log('tool.progress', { callId: call.id, ...p })
      relay?.(p)
    },
  })

  // M1-15: Parallel only when EVERY tool is readOnly && concurrencySafe.
  // Start all, then yield completions in model-returned order.
  if (!harness && canRunInParallel(runnable.map(r => r.call), ctx.tools)) {
    for (const { call } of runnable) {
      yield {
        type: 'tool.progress',
        callId: call.id,
        progress: { phase: 'executing', current: 0 }
      }
    }

    // Every promise gets a handler at creation time. Awaiting them one at a time
    // would leave the later ones unhandled if an earlier one rejects (or if the
    // consumer abandons the generator at the yield below), producing
    // unhandledrejection and discarding results that already completed.
    const promises = runnable.map(({ tool, call }) =>
      executeCall(tool, call, makeOpts(call)).catch((error): ToolResult => ({
        success: false,
        content: `工具执行失败：${error instanceof Error ? error.message : String(error)}`,
        error: {
          kind: 'runtime',
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        },
        metadata: { durationMs: 0 },
      })),
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

    // Cancellation may happen while the previous tool or approval is active.
    // Stop before invoking any hook or policy for the next tool.
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
        if (harness) recordToolCompleted(harness, remaining.id, result)
        yield { type: 'tool.completed', callId: remaining.id, result }
        logger.log('tool.aborted', { callId: remaining.id, name: remaining.name })
      }
      break
    }

    if (harness) {
      const authoritativeName = call.name
      const authoritativeInput = JSON.stringify(call.input)
      const hookCall = snapshotJson(call) as unknown as ToolCall
      const beforeTool = await harness.hooks.waterfall('before_tool_call', hookCall, { type: 'before_tool_call', runId: ctx.runId, callId: call.id, signal: ctx.signal, onHookError: (id, error) => logger.warn('hook.failed', { id, error: String(error) }) })
      if (beforeTool.action === 'abort') {
        const result: ToolResult & { callId: string } = { callId: call.id, success: false, content: beforeTool.reason, error: { kind: 'permission_denied', message: beforeTool.reason, recoverable: true }, metadata: { durationMs: 0 } }
        results.push(result); recordToolCompleted(harness, call.id, result); yield { type: 'tool.completed', callId: call.id, result }; continue
      }
      if (beforeTool.action === 'short_circuit') {
        const result = { ...beforeTool.result, callId: call.id }; results.push(result); recordToolCompleted(harness, call.id, result); yield { type: 'tool.completed', callId: call.id, result }; continue
      }
      if (beforeTool.value.name !== authoritativeName || JSON.stringify(beforeTool.value.input) !== authoritativeInput || call.name !== authoritativeName || JSON.stringify(call.input) !== authoritativeInput) {
        const reason = '工具请求落账后不可修改名称或参数，请发起新的工具调用。'
        const result: ToolResult & { callId: string } = { callId: call.id, success: false, content: reason, error: { kind: 'permission_denied', message: reason, recoverable: true }, metadata: { durationMs: 0 } }
        results.push(result); recordToolCompleted(harness, call.id, result); yield { type: 'tool.completed', callId: call.id, result }; continue
      }
      const policy = Object.freeze(harness.policy.evaluate(tool, call, {
        workspace: toolCtx.workspace,
        platform: toolCtx.platform,
        settings: toolCtx.settings,
        permissions: toolCtx.permissions,
        toolContext: toolCtx,
        skillResources: toolCtx.skillResources,
        isOnline: typeof navigator === 'undefined' || navigator.onLine,
      }))
      // `observe` is the least-privileged hook mode and its exceptions are
      // swallowed, so it must not be able to widen a decision. The decision is
      // frozen and re-read from the frozen object after the await.
      await harness.hooks.observe('on_permission', { type: 'on_permission', runId: ctx.runId, callId: call.id, call, decision: policy, onHookError: (id, error) => logger.warn('hook.failed', { id, error: String(error) }) })
      let denied = policy.kind === 'deny' ? policy.reason : undefined
      const grantKey = sessionGrantKey(tool, call)
      if (policy.kind === 'ask' && !harness.approvals.hasSessionGrant(grantKey)) {
        const prompt = await enrichConfirmationPrompt(policy.prompt, tool, call, ctx)
        const requestId = `approval_${ctx.runId}_${call.id}`
        harness.ledger.append('approval.asked', { requestId, callId: call.id, toolName: tool.name, reason: policy.reason, prompt }, { requirePersistence: true })
        yield { type: 'permission.required', requestId, callId: call.id, prompt }
        const approval = await harness.approvals.request({ requestId, askedAlready: true, runId: ctx.runId, callId: call.id, toolName: tool.name, grantKey, reason: policy.reason, prompt, signal: ctx.signal })
        yield { type: 'permission.resolved', requestId, callId: call.id, outcome: approval.outcome }
        if (approval.outcome !== 'allowed_once') denied = approval.outcome === 'cancelled' ? '用户已停止运行，未执行该操作。' : '用户未授权该操作，已跳过执行。'
      }
      const guard = hardGuard(ctx, tool, call)
      if (guard.kind === 'deny') denied = guard.reason
      if (denied) {
        const result: ToolResult & { callId: string } = { callId: call.id, success: false, content: denied, error: { kind: 'permission_denied', message: denied, recoverable: true }, metadata: { durationMs: 0 } }
        results.push(result)
        recordToolCompleted(harness, call.id, result)
        yield { type: 'tool.completed', callId: call.id, result }
        continue
      }
    }

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
        if (harness) recordToolCompleted(harness, remaining.id, result)
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

    // A throw here would leave every tool_use in this turn without a matching
    // tool_result, which the APIs reject outright. Tools tombstone instead.
    let executed: ToolResult
    try {
      executed = yield* relayExecutionProgress(call.id, (onProgress) => harness
        ? harness.hooks.around('execute_tool', { type: 'execute_tool', runId: ctx.runId, callId: call.id, call, signal: ctx.signal }, () => executeCall(tool, call, makeOpts(call, onProgress)))
        : executeCall(tool, call, makeOpts(call, onProgress)))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn('tool.threw', { callId: call.id, name: call.name, error: message })
      executed = {
        success: false,
        content: `工具执行失败：${message}`,
        error: { kind: 'runtime', message, recoverable: true },
        metadata: { durationMs: 0 },
      }
    }
    const result = { ...executed, callId: call.id }
    results.push(result)
    if (harness) recordToolCompleted(harness, call.id, result)
    yield { type: 'tool.completed', callId: call.id, result }
    // Frozen: an after_tool_call observer must not be able to rewrite the result
    // after it has been ledgered, which would diverge the audit trail from what
    // the model actually sees.
    await harness?.hooks.observe('after_tool_call', { type: 'after_tool_call', runId: ctx.runId, callId: call.id, result: Object.freeze({ ...result }), onHookError: (id, error) => logger.warn('hook.failed', { id, error: String(error) }) })
    logger.log('tool.completed', {
      callId: call.id,
      name: call.name,
      success: result.success,
      durationMs: result.metadata?.durationMs
    })
  }

  return results
}

/** Relay progress emitted during a pending tool promise without buffering it until completion. */
async function* relayExecutionProgress(
  callId: string,
  execute: (onProgress: (progress: ToolProgress) => void) => Promise<ToolResult>,
): AsyncGenerator<QueryEvent, ToolResult> {
  const queue: ToolProgress[] = []
  let wake: (() => void) | undefined
  let settled = false
  let result: ToolResult | undefined
  let failure: unknown

  const notify = () => {
    const current = wake
    wake = undefined
    current?.()
  }
  const promise = Promise.resolve()
    .then(() => execute((progress) => {
      queue.push(progress)
      notify()
    }))
    .then(
      (value) => { result = value },
      (error) => { failure = error },
    )
    .finally(() => {
      settled = true
      notify()
    })

  while (!settled || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => { wake = resolve })
    }
    while (queue.length > 0) {
      yield { type: 'tool.progress', callId, progress: queue.shift()! }
    }
  }
  await promise
  if (failure) throw failure
  if (!result) throw new Error('Tool execution completed without a result')
  return result
}

function isMessageEnvelope(value: unknown): value is { messages: Message[] } {
  if (!value || typeof value !== 'object') return false
  const messages = (value as { messages?: unknown }).messages
  return Array.isArray(messages) && messages.every((message) => message && typeof message === 'object' && ((message as Message).role === 'user' || (message as Message).role === 'assistant'))
}

function appendTerminalFact(
  harness: HarnessRuntime | undefined,
  logger: SimpleRunLogger,
  type: 'run.failed' | 'run.exhausted',
  payload: unknown,
): void {
  try { harness?.ledger.append(type, payload) }
  catch (error) { logger.error('ledger.terminal_write_failed', error) }
}

async function enrichConfirmationPrompt(prompt: import('../harness/policy').ConfirmationPrompt, tool: Tool, call: ToolCall, ctx: QueryContext) {
  if (tool.name !== 'write_file' || typeof call.input?.path !== 'string' || typeof call.input?.content !== 'string') return prompt
  const bytes = new TextEncoder().encode(call.input.content).byteLength
  const previewLimit = 8_000
  const after = call.input.content.length > previewLimit
    ? `${call.input.content.slice(0, previewLimit)}\n\n[预览已截断，共 ${bytes} 字节]`
    : call.input.content
  try {
    const existing = await readWorkspaceFile(call.input.path, ctx.cwd, 0, previewLimit)
    const before = !existing.binary && existing.content
      ? existing.truncated ? `${existing.content}\n\n[预览已截断，共 ${existing.bytes} 字节]` : existing.content
      : undefined
    return { ...prompt, detail: `将写入 ${call.input.path}，约 ${bytes} 字节，覆盖已有文件（当前 ${existing.bytes} 字节）`, diff: { before, after } }
  } catch {
    return { ...prompt, detail: `将写入 ${call.input.path}，约 ${bytes} 字节；若文件已存在将被覆盖`, diff: { after } }
  }
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
