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
import { isEnabled } from '../harness/flags'
import { createHarnessRuntime, hardGuard, recordToolCompleted, recordToolRequested, sessionGrantKey, type HarnessRuntime } from '../harness/builtin-hooks'
import { readWorkspaceFile } from '../tauri'
import { snapshotJson } from '../harness/ledger'

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
  const harness = isEnabled('harness') ? createHarnessRuntime(runCtx) : undefined

  // Current conversation state (reconstructed per turn or restored from the
  // last completed tool turn after a renderer restart).
  let currentMessages = [...ctx.messages]
  let harnessContext = [...(ctx.harnessContext ?? [])]

  try {
    harness?.ledger.append('run.started', { conversationId: ctx.conversationId })
    yield { type: 'run.started', runId: ctx.runId }
    logger.log('run.started', { runId: ctx.runId, conversationId: ctx.conversationId })
    if (harness) {
      const beforeQuery = await harness.hooks.waterfall('before_query', { messages: currentMessages }, { type: 'before_query', runId: ctx.runId, signal: runCtx.signal, onHookError: (id, error) => logger.warn('hook.failed', { id, error: String(error) }) })
      if (beforeQuery.action === 'abort') throw new Error(beforeQuery.reason)
      if (beforeQuery.action === 'continue' && typeof beforeQuery.value === 'object' && beforeQuery.value && Array.isArray((beforeQuery.value as { context?: unknown }).context)) {
        harnessContext = (beforeQuery.value as { context: unknown[] }).context.filter((text): text is string => typeof text === 'string')
      }
    }

    if (!ctx.restoreSnapshot && ctx.snapshots) {
      await clearSnapshot(ctx, logger)
    } else if (ctx.restoreSnapshot && ctx.snapshots) {
      try {
        const snapshot = await ctx.snapshots.loadLatest(ctx.conversationId)
        if (!snapshot) throw new Error('No recoverable Agent snapshot was found')
        if (snapshot.runId !== ctx.runId) {
          throw new Error('The recoverable Agent snapshot belongs to a different run')
        }
        turn = snapshot.turn
        currentMessages = [...snapshot.messages]
        Object.assign(usage, snapshot.usage)
        totalToolCalls = snapshot.usage.toolCalls
        logger.log('snapshot.restored', { turn, messageCount: currentMessages.length })
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
        const beforeModel = await harness.hooks.waterfall('before_model_call', { messages: currentMessages, usage }, { type: 'before_model_call', runId: ctx.runId, signal: runCtx.signal, onHookError: (id, error) => logger.warn('hook.failed', { id, error: String(error) }) })
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
        }, logger, {
          onModelPrepared: harness ? (request) => { harness.ledger.append('model.called', { turn, request }) } : undefined,
          onToolRequested: harness ? (call) => recordToolRequested(harness, call) : undefined,
        })
      } catch (error) {
        harness?.ledger.append('model.failed', { turn, message: error instanceof Error ? error.message : String(error) })
        throw error
      }
      harness?.ledger.append('model.completed', { turn, text: response.text, toolCalls: response.toolCalls, usage: response.usage, stopReason: response.stopReason })
      await harness?.hooks.observe('after_model_call', { type: 'after_model_call', runId: ctx.runId, response, onHookError: (id, error) => logger.warn('hook.failed', { id, error: String(error) }) })

      // Accumulate token usage
      if (response.usage) {
        usage.inputTokens += response.usage.inputTokens
        usage.outputTokens += response.usage.outputTokens
        usage.totalTokens += response.usage.totalTokens
      }

      // Handle stop reason (M1-10)
      if (response.stopReason === 'max_tokens') {
        harness?.ledger.append('run.exhausted', { reason: 'max_tokens', usage })
        yield { type: 'run.exhausted', reason: 'max_tokens' }
        logger.log('run.exhausted', { reason: 'stop_reason_max_tokens', usage })
        return
      }

      // Check token budget
      if (usage.totalTokens > ctx.limits.maxTokens) {
        harness?.ledger.append('run.exhausted', { reason: 'max_tokens', usage })
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
        harness?.ledger.append('run.exhausted', { reason: 'max_tool_calls', usage })
        yield { type: 'run.exhausted', reason: 'max_tool_calls' }
        logger.log('run.exhausted', { reason: 'max_tool_calls', totalToolCalls })
        return
      }

      // Execute tools (M1-14, M1-15, M1-16)
      const results = yield* executeTools(runCtx, response.toolCalls, logger, harness)

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
            runId: ctx.runId,
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
      harness?.ledger.append('run.exhausted', { reason: 'max_turns', usage })
      yield { type: 'run.exhausted', reason: 'max_turns' }
      logger.log('run.exhausted', { reason: 'max_turns', turns: turn })
      return
    }

    harness?.ledger.append('run.completed', usage)
    yield { type: 'run.completed', usage }
    logger.log('run.completed', { usage })
    await harness?.hooks.observe('on_run_completed', { type: 'on_run_completed', runId: ctx.runId, usage, onHookError: (id, error) => logger.warn('hook.failed', { id, error: String(error) }) })
    if (ctx.restoreSnapshot) await clearSnapshot(ctx, logger)

  } catch (error) {
    await harness?.hooks.observe('on_error', { type: 'on_error', runId: ctx.runId, error, onHookError: (id, hookError) => logger.warn('hook.failed', { id, error: String(hookError) }) })
    if (ctx.signal.aborted) {
      appendTerminalFact(harness, logger, 'run.failed', { kind: 'aborted', message: 'Run was aborted by user', usage })
      yield {
        type: 'run.failed',
        error: { kind: 'aborted', message: 'Run was aborted by user' },
      }
      logger.log('run.aborted')
    } else {
      const message = error instanceof Error ? error.message : String(error)
      appendTerminalFact(harness, logger, 'run.failed', { kind: 'internal', message, usage })
      yield {
        type: 'run.failed',
        error: {
          kind: 'internal',
          message,
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

  const makeOpts = (call: ToolCall) => ({
    ctx: toolCtx,
    signal: ctx.signal,
    defaultTimeoutMs: ctx.limits.toolTimeoutMs,
    onProgress: (p: ToolProgress) =>
      logger.log('tool.progress', { callId: call.id, ...p }),
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
      const policy = harness.policy.evaluate(tool, call, {
        workspace: toolCtx.workspace,
        platform: toolCtx.platform,
        settings: toolCtx.settings,
        permissions: toolCtx.permissions,
        toolContext: toolCtx,
        isOnline: typeof navigator === 'undefined' || navigator.onLine,
      })
      await harness.hooks.observe('on_permission', { type: 'on_permission', runId: ctx.runId, callId: call.id, call, decision: policy, onHookError: (id, error) => logger.warn('hook.failed', { id, error: String(error) }) })
      let denied = policy.kind === 'deny' ? policy.reason : undefined
      const grantKey = sessionGrantKey(tool, call)
      if (policy.kind === 'ask' && !harness.approvals.hasSessionGrant(grantKey)) {
        const prompt = await enrichConfirmationPrompt(policy.prompt, tool, call, ctx)
        const requestId = `approval_${ctx.runId}_${call.id}`
        harness.ledger.append('approval.asked', { requestId, callId: call.id, toolName: tool.name, reason: policy.reason, prompt })
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

    const executed = harness
      ? await harness.hooks.around('execute_tool', { type: 'execute_tool', runId: ctx.runId, callId: call.id, call, signal: ctx.signal }, () => executeCall(tool, call, makeOpts(call)))
      : await executeCall(tool, call, makeOpts(call))
    const result = { ...executed, callId: call.id }
    results.push(result)
    if (harness) recordToolCompleted(harness, call.id, result)
    yield { type: 'tool.completed', callId: call.id, result }
    await harness?.hooks.observe('after_tool_call', { type: 'after_tool_call', runId: ctx.runId, callId: call.id, result, onHookError: (id, error) => logger.warn('hook.failed', { id, error: String(error) }) })
    logger.log('tool.completed', {
      callId: call.id,
      name: call.name,
      success: result.success,
      durationMs: result.metadata?.durationMs
    })
  }

  return results
}

function isMessageEnvelope(value: unknown): value is { messages: Message[] } {
  if (!value || typeof value !== 'object') return false
  const messages = (value as { messages?: unknown }).messages
  return Array.isArray(messages) && messages.every((message) => message && typeof message === 'object' && ((message as Message).role === 'user' || (message as Message).role === 'assistant'))
}

function appendTerminalFact(
  harness: HarnessRuntime | undefined,
  logger: SimpleRunLogger,
  type: 'run.failed',
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
