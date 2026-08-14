/**
 * Tool execution scheduler: validate → execute → normalize
 * M1-14 (dispatch), M1-15 (concurrency), M1-16 (timeout & retry)
 *
 * M2 policy and lifecycle interception wrap this scheduler in engine/query.ts.
 *
 * @module lib/tools/executor
 * @see docs/specs/tool-interface.md §4 (流程), §5 (并发)
 */

import type {
  Tool,
  ToolCall,
  ToolResult,
  ToolUseContext,
  ToolProgress,
} from './types'
import type { Platform } from '../harness/types'
import type { JSONSchema } from '../types/json-schema'
import { HANDLE_THRESHOLD, handleizeLargeResult } from '../engine/context-budget'

// ============================================================================
// Step ③: Input schema validation
// ============================================================================

export interface ValidationResult {
  ok: boolean
  /** Model-facing error descriptions, one per violation */
  errors: string[]
}

/**
 * Validate input against the JSONSchema subset used by tools.
 * Covers: type, required, properties, items, enum, min/max, pattern.
 */
export function validateInput(input: unknown, schema: JSONSchema): ValidationResult {
  const errors: string[] = []
  validateNode(input, schema, '$', errors)
  return { ok: errors.length === 0, errors }
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function validateNode(
  value: unknown,
  schema: JSONSchema,
  path: string,
  errors: string[],
): void {
  // Type check
  if (schema.type) {
    const actual = typeOf(value)
    // 'integer' is not a JS type: it is 'number' plus an integrality constraint.
    // Without it, `read_file{offset: 3.7}` validated and then failed serde
    // deserialization into usize at the Rust boundary with an opaque message.
    if (schema.type === 'integer') {
      if (actual !== 'number' || !Number.isInteger(value)) {
        errors.push(`${path}: expected integer, got ${actual === 'number' ? String(value) : actual}`)
        return
      }
    } else if (actual !== schema.type) {
      errors.push(`${path}: expected ${schema.type}, got ${actual}`)
      return // Deeper checks are meaningless on wrong type
    }
  }

  // Enum check
  if (schema.enum && !schema.enum.some((v) => v === value)) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`)
    return
  }

  // Object checks. Driven by the actual value, not by a declared `type`:
  // a schema node that omits `type` used to disable every constraint beneath
  // it, so `required` and nested properties were silently unchecked.
  if (typeOf(value) === 'object' && (schema.required || schema.properties || schema.additionalProperties !== undefined)) {
    const obj = value as Record<string, unknown>
    const owns = (key: string) => Object.prototype.hasOwnProperty.call(obj, key)

    for (const key of schema.required ?? []) {
      // `key in obj` walks the prototype chain, so `required: ['toString']`
      // passed on `{}` and a property named `constructor` validated against
      // Object.prototype's.
      if (!owns(key)) {
        errors.push(`${path}: missing required parameter '${key}'`)
      }
    }

    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (owns(key)) {
          validateNode(obj[key], propSchema, `${path}.${key}`, errors)
        }
      }
    }

    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(obj)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
          errors.push(`${path}: unexpected parameter '${key}'`)
        }
      }
    }
  }

  // Array checks
  if (Array.isArray(value)) {
    if (schema.items) {
      value.forEach((item, i) => {
        validateNode(item, schema.items!, `${path}[${i}]`, errors)
      })
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: must have >= ${schema.minItems} items`)
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: must have <= ${schema.maxItems} items`)
    }
  }

  // String checks
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: length must be >= ${schema.minLength}`)
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: length must be <= ${schema.maxLength}`)
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: must match pattern ${schema.pattern}`)
    }
  }

  // Number checks
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: must be >= ${schema.minimum}`)
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: must be <= ${schema.maximum}`)
    }
  }
}

// ============================================================================
// Steps ①②③: Call preparation
// ============================================================================

export type PreparedCall =
  | { ok: true; tool: Tool }
  | {
      ok: false
      /** Feedback result so the model can self-correct */
      result: ToolResult
      /** Present only for the tombstoned cases (① unknown, ③ invalid input) */
      tombstone?: { reason: 'unknown_tool' | 'invalid_tool_args'; detail?: unknown }
    }

/**
 * Steps ① registry lookup, ② availability, ③ schema validation.
 * ③ runs before any policy/confirmation (spec: don't ask the user to
 * authorize a call whose arguments are invalid).
 */
export function prepareCall(
  call: ToolCall,
  tools: readonly Tool[],
  platform?: Platform,
): PreparedCall {
  // ① Registry lookup
  const tool = tools.find((t) => t.name === call.name)
  if (!tool) {
    const available = tools.map((t) => t.name)
    const message = `Tool '${call.name}' does not exist. Available tools: ${available.join(', ') || '(none)'}`
    return {
      ok: false,
      result: {
        success: false,
        content: message,
        error: { kind: 'invalid_input', message, recoverable: true },
        metadata: { durationMs: 0 },
      },
      tombstone: {
        reason: 'unknown_tool',
        detail: { toolName: call.name, availableTools: available },
      },
    }
  }

  // ② Environment availability. Registry.resolve() is the primary filter;
  // this is defense in depth, active only when the caller knows the platform.
  // 'online-only' failures surface at runtime with a meaningful error instead.
  if (platform && tool.availability === 'tauri-only' && platform !== 'tauri') {
    const message = `Tool '${call.name}' requires the desktop app and is not available on ${platform}`
    return {
      ok: false,
      result: {
        success: false,
        content: message,
        error: { kind: 'permission_denied', message, recoverable: false },
        metadata: { durationMs: 0 },
      },
    }
  }

  // ③ Input schema validation
  const validation = validateInput(call.input, tool.inputSchema)
  if (!validation.ok) {
    const message = `Invalid arguments for tool '${call.name}': ${validation.errors.join('; ')}`
    return {
      ok: false,
      result: {
        success: false,
        content: message,
        error: { kind: 'invalid_input', message, recoverable: true },
        metadata: { durationMs: 0 },
      },
      tombstone: {
        reason: 'invalid_tool_args',
        detail: { toolName: call.name, errors: validation.errors, providedArgs: call.input },
      },
    }
  }

  return { ok: true, tool }
}

// ============================================================================
// Steps ⑥⑦: Execution with timeout & retry (M1-16), normalization
// ============================================================================

export interface ExecuteCallOptions {
  ctx: ToolUseContext
  signal: AbortSignal
  /** Fallback when the tool declares no timeoutMs (RunLimits.toolTimeoutMs) */
  defaultTimeoutMs: number
  onProgress?: (p: ToolProgress) => void
}

/**
 * Execute one prepared call: timeout enforcement, declared retry policy,
 * result normalization. Never throws — always returns a ToolResult.
 */
export async function executeCall(
  tool: Tool,
  call: ToolCall,
  opts: ExecuteCallOptions,
): Promise<ToolResult> {
  const maxAttempts = Math.max(1, tool.retry?.maxAttempts ?? 1)
  const backoffMs = tool.retry?.backoffMs ?? 0

  let last: ToolResult | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await executeOnce(tool, call, opts)
    if (last.success || !shouldRetry(tool, last)) break

    if (attempt < maxAttempts) {
      const completed = await abortableSleep(backoffMs * attempt, opts.signal)
      if (!completed) {
        last = abortedResult(tool.name, 0)
        break
      }
    }
  }

  return normalizeResult(last!, opts.ctx.memory)
}

/**
 * Retry only transient failures, and only for tools that are safe to re-run.
 *
 * A timeout means "we stopped waiting", not "nothing happened": the underlying
 * Tauri command has no cancellation path, so a timed-out `write_file` may still
 * land. Re-running a side-effecting tool would double-apply it. The gate lives
 * here rather than relying on every tool author to omit a `retry` policy.
 */
function shouldRetry(tool: Tool, result: ToolResult): boolean {
  const kind = result.error?.kind
  const transient = (kind === 'timeout' || kind === 'runtime') && result.error?.recoverable !== false
  if (!transient) return false
  // A timeout may have partially applied; only replay tools with no side effects.
  if (kind === 'timeout' && !(tool.readOnly && !tool.destructive)) return false
  return true
}

async function executeOnce(
  tool: Tool,
  call: ToolCall,
  opts: ExecuteCallOptions,
): Promise<ToolResult> {
  const timeoutMs = tool.timeoutMs ?? opts.defaultTimeoutMs
  const started = Date.now()

  // Per-attempt controller: fires on external abort OR timeout.
  // Tools receive this signal and are expected to cancel themselves.
  const attempt = new AbortController()
  const onExternalAbort = () => attempt.abort()
  opts.signal.addEventListener('abort', onExternalAbort, { once: true })
  if (opts.signal.aborted) attempt.abort()

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    attempt.abort()
  }, timeoutMs)

  try {
    const result = await raceWithAbort(
      tool.execute(call.input, opts.ctx, attempt.signal, opts.onProgress),
      attempt.signal,
    )
    return withDuration(result, started)
  } catch (err) {
    const durationMs = Date.now() - started

    if (opts.signal.aborted) {
      return abortedResult(tool.name, durationMs)
    }
    if (timedOut) {
      const message = `Tool '${tool.name}' timed out after ${timeoutMs}ms`
      return {
        success: false,
        content: message,
        error: { kind: 'timeout', message, recoverable: true },
        metadata: { durationMs },
      }
    }
    // Tool threw: convert to an explainable runtime error for the model
    const message = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      content: `Tool '${tool.name}' failed: ${message}`,
      error: { kind: 'runtime', message, recoverable: true },
      metadata: { durationMs },
    }
  } finally {
    clearTimeout(timer)
    opts.signal.removeEventListener('abort', onExternalAbort)
  }
}

/**
 * Race a tool promise against its abort signal, so tools that ignore
 * the signal cannot hang the loop. Late settlement of the abandoned
 * promise is swallowed to avoid unhandled rejections.
 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('Aborted'))
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/** Sleep that resolves false if aborted before the delay elapses */
function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!signal.aborted)
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function abortedResult(toolName: string, durationMs: number): ToolResult {
  return {
    success: false,
    content: `Tool '${toolName}' was aborted`,
    error: {
      kind: 'aborted',
      message: 'Run was aborted during tool execution',
      recoverable: false,
    },
    metadata: { durationMs },
  }
}

function withDuration(result: ToolResult, started: number): ToolResult {
  // `??` does not fall through 0, and several tools return a literal
  // `durationMs: 0`, so an explicit zero must be treated as "unset".
  const declared = result.metadata?.durationMs
  return {
    ...result,
    metadata: {
      ...result.metadata,
      durationMs: declared ? declared : Date.now() - started,
    },
  }
}

/**
 * Step ⑦: normalize the result shape and handleize oversized content
 * so a single tool cannot blow up the context window.
 *
 * Must not throw: `executeCall` guarantees it always returns a ToolResult, and
 * a rejection here would leave the whole turn's tool_use blocks unanswered.
 * `handleizeLargeResult` already degrades a failed store to inline truncation.
 */
async function normalizeResult(result: ToolResult, memory: ToolUseContext['memory']): Promise<ToolResult> {
  const content = typeof result.content === 'string' ? result.content : ''
  const { content: sized, isHandleized, handle } = await handleizeLargeResult(content, memory)

  return {
    ...result,
    content: sized,
    // Oversized tool payloads must not survive in persisted runEvents through
    // the UI-only data field; the handle is the single source of full content.
    data: isHandleized && isLargeStructuredData(result.data) ? undefined : result.data,
    handle: result.handle ?? handle,
    truncated: result.truncated || isHandleized,
    // withDuration has already stamped the real elapsed time; the 0 is only a
    // floor for results that never went through it.
    metadata: { durationMs: 0, ...result.metadata },
  }
}

function isLargeStructuredData(data: unknown): boolean {
  if (data === undefined) return false
  try {
    return new TextEncoder().encode(JSON.stringify(data)).byteLength > HANDLE_THRESHOLD
  } catch {
    return true
  }
}

// ============================================================================
// M1-15: Concurrency plan (spec §5 — conservative)
// ============================================================================

/**
 * Parallel only when EVERY call's tool is readOnly && concurrencySafe.
 * Anything else runs serially in model-returned order.
 */
export function canRunInParallel(
  calls: readonly ToolCall[],
  tools: readonly Tool[],
): boolean {
  if (calls.length <= 1) return false
  return calls.every((call) => {
    const tool = tools.find((t) => t.name === call.name)
    return tool !== undefined && tool.readOnly && tool.concurrencySafe
  })
}
