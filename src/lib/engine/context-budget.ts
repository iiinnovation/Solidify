/**
 * Context assembly and budget management
 * @module lib/engine/context-budget
 * @see docs/specs/agent-loop.md §6
 */

import type { QueryContext } from './types'
import type { ClaudeMessage, ClaudeContent } from './messages'
import type { MemoryState } from '../memory/types'

/**
 * Token estimation (1 token ≈ 4 characters)
 * TODO M2: Replace with tiktoken for accurate counting
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
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
  /** Reserved for system prompt (not trimmed) */
  system: number
  /** Reserved for current skill (not trimmed) */
  skill: number
  /** Reserved for skill index (not trimmed) */
  skillIndex: number
  /** Reserved for output generation */
  output: number
  /** Remaining for messages and tool results */
  available: number
}

/**
 * Calculate context budget from model config
 */
export function calculateBudget(ctx: QueryContext): ContextBudget {
  // Default context window sizes (Claude models typically 200k)
  const total = 200_000
  const output = ctx.limits.maxOutputTokens || 4096

  // Fixed allocations (not trimmed)
  const system = 2000 // Base system prompt
  const skill = ctx.skill ? 4000 : 0 // Current skill content
  const skillIndex = 500 // Skill index (small)

  const available = total - output - system - skill - skillIndex

  return {
    total,
    system,
    skill,
    skillIndex,
    output,
    available,
  }
}

/**
 * Handle threshold for large tool results (8KB)
 */
export const HANDLE_THRESHOLD = 8192

/**
 * Handleize large tool result
 */
export async function handleizeLargeResult(
  content: string,
  memory?: MemoryState,
): Promise<{ content: string; isHandleized: boolean; handle?: string }> {
  const bytes = new TextEncoder().encode(content).byteLength
  if (bytes <= HANDLE_THRESHOLD) {
    return { content, isHandleized: false }
  }

  const summary = content.slice(0, 500)
  if (!memory) {
    return {
      content: `${summary}\n\n[Result truncated: ${bytes} bytes, ${content.length} UTF-16 code units total.]`,
      isHandleized: true,
    }
  }

  const handle = await memory.store(content)
  const truncated = `${summary}\n\n[Result stored as ${handle}: ${bytes} bytes, ${content.length} UTF-16 code units total. Use read_handle to retrieve it.]`

  return { content: truncated, isHandleized: true, handle }
}

/**
 * Trim messages to fit budget
 * Strategy: Keep most recent messages, drop older ones
 */
export function trimMessages(
  messages: ClaudeMessage[],
  availableTokens: number,
): ClaudeMessage[] {
  let totalTokens = 0
  const kept: ClaudeMessage[] = []

  // Work backwards from most recent
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const tokens = estimateMessageTokens(msg.content)

    if (totalTokens + tokens > availableTokens) {
      // Budget exhausted
      break
    }

    totalTokens += tokens
    kept.unshift(msg) // Add to front
  }

  return kept
}

/**
 * Process messages with budget constraints
 * - Remove orphan tool_result (M1-11 tombstoning)
 * - Handleize large tool results
 * - Trim old messages if needed
 */
export async function applyBudget(
  ctx: QueryContext,
  messages: ClaudeMessage[],
): Promise<ClaudeMessage[]> {
  const budget = calculateBudget(ctx)

  // Step 1: M1-11 - Detect and remove orphan tool_results
  const { cleanedMessages, orphanCount } = removeOrphanToolResults(messages)
  if (orphanCount > 0) {
    console.warn(`[context-budget] Removed ${orphanCount} orphan tool_result(s)`)
  }

  // Step 2: Handleize large tool results
  const processedMessages = await Promise.all(cleanedMessages.map(async msg => {
    if (typeof msg.content === 'string') {
      return msg
    }

    const processedContent = await Promise.all(msg.content.map(async part => {
      if (part.type === 'tool_result') {
        const { content, isHandleized } = await handleizeLargeResult(part.content, ctx.memory)
        if (isHandleized) {
          // Log handleization (in production, emit event)
          console.debug(`[context-budget] Handleized tool result ${part.tool_use_id}`)
        }
        return { ...part, content }
      }
      return part
    }))

    return { ...msg, content: processedContent }
  }))

  // Step 3: Calculate current usage
  const currentTokens = processedMessages.reduce(
    (sum, msg) => sum + estimateMessageTokens(msg.content),
    0,
  )

  // Step 4: Trim if over budget
  if (currentTokens > budget.available) {
    console.debug(
      `[context-budget] Trimming messages: ${currentTokens} > ${budget.available}`,
    )
    return trimMessages(processedMessages, budget.available)
  }

  return processedMessages
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
