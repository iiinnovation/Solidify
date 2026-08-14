/**
 * Context assembly and budget management
 * @module lib/engine/context-budget
 * @see docs/specs/agent-loop.md §6
 */

import type { QueryContext } from './types'
import type { ClaudeMessage, ClaudeContent } from './messages'
import type { MemoryState } from '../memory/types'

/**
 * Token estimation.
 *
 * ~4 characters per token holds for Latin text but is ~4x optimistic for CJK,
 * where a character is roughly one token. This product is Chinese-first, so the
 * two ranges are counted separately — a uniform /4 would let a long Chinese
 * conversation report a quarter of its real cost and blow past the window.
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (
      (code >= 0x3040 && code <= 0x30ff)   // kana
      || (code >= 0x3400 && code <= 0x4dbf) // CJK ext A
      || (code >= 0x4e00 && code <= 0x9fff) // CJK unified
      || (code >= 0xf900 && code <= 0xfaff) // compatibility ideographs
      || (code >= 0xac00 && code <= 0xd7af) // hangul
      || (code >= 0x20000 && code <= 0x2ebef) // CJK ext B-F
    ) cjk++
  }
  const rest = [...text].length - cjk
  return Math.ceil(cjk + rest / 4)
}

/**
 * Estimate tokens for message content
 */
function estimateMessageTokens(content: string | ClaudeContent[]): number {
  if (typeof content === 'string') {
    return estimateTokens(content)
  }

  return content.reduce((sum, part) => {
    if (part.type === 'text') {
      return sum + estimateTokens(part.text)
    }
    if (part.type === 'tool_use') {
      return sum + estimateTokens(JSON.stringify(part.input)) + 20 // overhead
    }
    if (part.type === 'tool_result') {
      return sum + estimateTokens(part.content) + 20
    }
    if (part.type === 'image_url') {
      return sum + 1000 // rough estimate for image tokens
    }
    return sum
  }, 0)
}

/**
 * Context budget configuration
 */
export interface ContextBudget {
  /** Total available tokens */
  total: number
  /** Measured system prompt cost (not trimmable) */
  system: number
  /** Reserved for output generation */
  output: number
  /** Remaining for messages and tool results */
  available: number
}

/**
 * Conservative fallback when the provider does not report a context window.
 * Deliberately not 200k: assuming Claude-sized windows overflows every smaller
 * model (DeepSeek, gpt-*-16k, custom OpenAI-compatible endpoints) with a hard
 * provider 400 that trimming never gets a chance to prevent.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/**
 * Calculate context budget from model config.
 *
 * `systemPrompt` must be the *actual* assembled system prompt. It is never
 * trimmed, so it has to be measured rather than assumed — it carries the skill
 * body, the tool section and retrieved context, all of which vary by orders of
 * magnitude.
 */
export function calculateBudget(ctx: QueryContext, systemPrompt = ''): ContextBudget {
  const declared = ctx.model?.contextWindow
  const total = declared && declared > 0 ? declared : DEFAULT_CONTEXT_WINDOW
  const output = ctx.limits.maxOutputTokens || 4096
  const system = estimateTokens(systemPrompt)

  // Never hand back a negative or absurdly small budget: if the system prompt
  // alone crowds out the window, still allow a floor so the run can report a
  // real provider error rather than sending zero messages.
  const available = Math.max(1024, total - output - system)

  return { total, system, output, available }
}

/**
 * Handle threshold for large tool results (8KB)
 */
export const HANDLE_THRESHOLD = 8192

/**
 * Handleize large tool result.
 *
 * Storing the payload is best-effort: a failed store (disk full, read-only
 * volume, revoked workspace) must degrade to inline truncation, never reject.
 * `executeCall` promises it always returns a ToolResult, and this sits on that
 * path — a rejection here would leave every `tool_use` in the turn unanswered.
 */
export async function handleizeLargeResult(
  content: string,
  memory?: MemoryState,
): Promise<{ content: string; isHandleized: boolean; handle?: string }> {
  const bytes = new TextEncoder().encode(content).byteLength
  if (bytes <= HANDLE_THRESHOLD) {
    return { content, isHandleized: false }
  }

  const summary = safeSummary(content)
  if (!memory) {
    return {
      content: `${summary}\n\n[Result truncated: ${bytes} bytes, ${[...content].length} characters total.]`,
      isHandleized: true,
    }
  }

  let handle: string
  try {
    handle = await memory.store(content)
  } catch (error) {
    console.warn('[context-budget] Unable to store large result, truncating inline:', error)
    return {
      content: `${summary}\n\n[Result truncated: ${bytes} bytes, ${[...content].length} characters total. Storage was unavailable, so the full content cannot be retrieved.]`,
      isHandleized: true,
    }
  }

  const truncated = `${summary}\n\n[Result stored as ${handle}: ${bytes} bytes, ${[...content].length} characters total. Use read_handle to retrieve it.]`
  return { content: truncated, isHandleized: true, handle }
}

/**
 * First 500 *characters* — slicing UTF-16 code units can split a surrogate pair
 * and emit a lone surrogate, which becomes U+FFFD on the wire.
 */
function safeSummary(content: string): string {
  let out = ''
  let count = 0
  for (const char of content) {
    if (count >= 500) break
    out += char
    count++
  }
  return out
}

/**
 * Trim messages to fit budget.
 *
 * Strategy: keep the most recent messages. The cut must never land between an
 * assistant `tool_use` and the `user` message carrying its `tool_result` — the
 * APIs reject an unpaired block — so trimming works on *turn groups*: an
 * assistant message and the tool-result message that answers it are kept or
 * dropped together. The first kept message is also forced to `user` role.
 *
 * Always returns at least one message; an empty array is an API error.
 */
export function trimMessages(
  messages: ClaudeMessage[],
  availableTokens: number,
): ClaudeMessage[] {
  if (messages.length === 0) return messages

  const groups = groupByToolPairing(messages)
  let totalTokens = 0
  const kept: ClaudeMessage[][] = []

  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]
    const tokens = group.reduce((sum, msg) => sum + estimateMessageTokens(msg.content), 0)
    if (kept.length > 0 && totalTokens + tokens > availableTokens) break
    totalTokens += tokens
    kept.unshift(group)
  }

  const flat = kept.flat()
  // A conversation may not start mid-turn. Strip from the front while the first
  // message is an assistant turn or a bare tool_result — because groups keep
  // pairs together, this removes a whole unusable turn rather than half of one
  // (stripping only the assistant would orphan its tool_result).
  while (flat.length > 0 && (flat[0].role === 'assistant' || hasBlock(flat[0], 'tool_result'))) {
    flat.shift()
  }
  if (flat.length > 0) return flat

  // Nothing viable fit: fall back to the most recent standalone user message.
  // Over budget, but valid — the provider can then report a real error instead
  // of us sending an empty or unpaired request.
  const fallback = [...messages].reverse().find(
    msg => msg.role === 'user' && !hasBlock(msg, 'tool_result'),
  )
  return fallback ? [fallback] : messages.slice(-1)
}

/**
 * Group messages so that an assistant message containing `tool_use` stays with
 * the message(s) carrying the matching `tool_result`s.
 */
function groupByToolPairing(messages: ClaudeMessage[]): ClaudeMessage[][] {
  const groups: ClaudeMessage[][] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    const group = [message]
    if (hasBlock(message, 'tool_use')) {
      // Absorb every following message that answers this turn's tool calls.
      while (i + 1 < messages.length && hasBlock(messages[i + 1], 'tool_result')) {
        group.push(messages[++i])
      }
    }
    groups.push(group)
  }
  return groups
}

function hasBlock(message: ClaudeMessage, type: 'tool_use' | 'tool_result'): boolean {
  return typeof message.content !== 'string' && message.content.some(part => part.type === type)
}

/**
 * Process messages with budget constraints
 * - Handleize large tool results
 * - Trim old messages if needed (pair-aware)
 * - Remove orphan tool_result (M1-11 tombstoning)
 *
 * Order matters: trimming must happen *before* orphan removal. Trimming drops
 * whole turns from the front, which can strand a `tool_result` whose `tool_use`
 * was cut; running the orphan sweep first would leave that unpaired block in the
 * request and the provider rejects it with a hard 400 that reproduces on every
 * retry, because the same history is rebuilt each turn.
 */
export async function applyBudget(
  ctx: QueryContext,
  messages: ClaudeMessage[],
  systemPrompt = '',
): Promise<ClaudeMessage[]> {
  const budget = calculateBudget(ctx, systemPrompt)

  // Step 1: Handleize large tool results
  const processedMessages = await Promise.all(messages.map(async msg => {
    if (typeof msg.content === 'string') {
      return msg
    }

    const processedContent = await Promise.all(msg.content.map(async part => {
      if (part.type === 'tool_result') {
        const { content, isHandleized } = await handleizeLargeResult(part.content, ctx.memory)
        if (isHandleized) {
          console.debug(`[context-budget] Handleized tool result ${part.tool_use_id}`)
        }
        return { ...part, content }
      }
      return part
    }))

    return { ...msg, content: processedContent }
  }))

  // Step 2: Trim if over budget
  const currentTokens = processedMessages.reduce(
    (sum, msg) => sum + estimateMessageTokens(msg.content),
    0,
  )
  const trimmed = currentTokens > budget.available
    ? trimMessages(processedMessages, budget.available)
    : processedMessages
  if (trimmed.length !== processedMessages.length) {
    console.debug(
      `[context-budget] Trimmed ${processedMessages.length - trimmed.length} message(s): ${currentTokens} > ${budget.available}`,
    )
  }

  // Step 3: M1-11 - Detect and remove orphan tool_results left by the trim
  const { cleanedMessages, orphanCount } = removeOrphanToolResults(trimmed)
  if (orphanCount > 0) {
    console.warn(`[context-budget] Removed ${orphanCount} orphan tool_result(s)`)
  }

  // Step 4: Drop messages the sweep emptied — both APIs reject empty content
  const nonEmpty = cleanedMessages.filter(
    msg => typeof msg.content === 'string' ? msg.content.length > 0 : msg.content.length > 0,
  )

  return nonEmpty.length > 0 ? nonEmpty : messages.slice(-1)
}

/**
 * Remove orphan tool_result blocks that don't have corresponding tool_use
 * M1-11: Tombstoning strategy
 */
function removeOrphanToolResults(
  messages: ClaudeMessage[],
): { cleanedMessages: ClaudeMessage[]; orphanCount: number } {
  // Collect all tool_use IDs
  const toolUseIds = new Set<string>()
  for (const msg of messages) {
    if (typeof msg.content !== 'string') {
      for (const part of msg.content) {
        if (part.type === 'tool_use') {
          toolUseIds.add(part.id)
        }
      }
    }
  }

  // Filter out orphan tool_results
  let orphanCount = 0
  const cleanedMessages = messages.map(msg => {
    if (typeof msg.content === 'string') {
      return msg
    }

    const filteredContent = msg.content.filter(part => {
      if (part.type === 'tool_result') {
        const hasParent = toolUseIds.has(part.tool_use_id)
        if (!hasParent) {
          orphanCount++
          console.debug(
            `[context-budget] Orphan tool_result detected: ${part.tool_use_id}`,
          )
          return false // Remove orphan
        }
      }
      return true
    })

    return { ...msg, content: filteredContent }
  })

  return { cleanedMessages, orphanCount }
}

/**
 * Get budget status for debugging/monitoring
 */
export function getBudgetStatus(ctx: QueryContext, messages: ClaudeMessage[]) {
  const budget = calculateBudget(ctx)
  const usedTokens = messages.reduce(
    (sum, msg) => sum + estimateMessageTokens(msg.content),
    0,
  )

  return {
    budget,
    used: usedTokens,
    available: budget.available,
    utilization: Math.round((usedTokens / budget.available) * 100),
  }
}
