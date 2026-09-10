/**
 * Bounded recovery policy for model turns that exhaust their output window.
 *
 * This module is deliberately free of logging, ledger and phase side effects.
 * It decides whether the loop should continue an answer, retry once with a
 * compact input, or terminate. The coordinator remains responsible for
 * applying the returned state and emitting durable facts.
 *
 * @module lib/engine/recovery
 */

import type { Message, UsageStats } from './types'
import type { ToolCall } from '../tools/types'

/** A bounded continuation count prevents a provider without a stop sequence from spinning. */
export const MAX_CONTINUATIONS = 4

export interface RecoverableModelTurn {
  text: string
  toolCalls: readonly ToolCall[]
  usage?: UsageStats
  stopReason?: string
  reasoningLength: number
}

export type OutputRecoveryDecision =
  | { kind: 'none' }
  | {
      kind: 'continue_output'
      continuations: number
      messages: Message[]
      prefill: string
    }
  | { kind: 'compact_recovery' }
  | {
      kind: 'exhausted'
      reason: 'max_tokens' | 'max_output_tokens'
      thoughtOnly: boolean
    }

export interface OutputRecoveryInput {
  response: RecoverableModelTurn
  messages: readonly Message[]
  prefill: string
  continuations: number
  reasoningRecoveryUsed: boolean
  turn: number
  maxTurns: number
}

/**
 * Decide the only legal recovery action for an output-ceiling turn.
 * Truncated tool calls are never continued because their arguments may have
 * been cut mid-object and replaying them can duplicate side effects.
 */
export function decideOutputRecovery(input: OutputRecoveryInput): OutputRecoveryDecision {
  const { response } = input
  if (response.stopReason !== 'max_tokens') return { kind: 'none' }

  if (
    response.toolCalls.length === 0
    && response.text.trim()
    && input.continuations < MAX_CONTINUATIONS
  ) {
    const resumed = `${input.prefill}${response.text}`.replace(/\s+$/, '')
    if (resumed) {
      return {
        kind: 'continue_output',
        continuations: input.continuations + 1,
        messages: [
          ...dropTrailingPrefill(input.messages, input.prefill),
          { role: 'assistant', content: resumed },
        ],
        prefill: resumed,
      }
    }
  }

  const thoughtOnly = !response.text.trim()
    && response.toolCalls.length === 0
    && response.reasoningLength > 0

  if (thoughtOnly && !input.reasoningRecoveryUsed && input.turn < input.maxTurns) {
    return { kind: 'compact_recovery' }
  }

  return {
    kind: 'exhausted',
    reason: thoughtOnly ? 'max_output_tokens' : 'max_tokens',
    thoughtOnly,
  }
}

/**
 * Drop the trailing assistant prefill so a resumed answer replaces it instead
 * of stacking a second assistant turn. Hooks may have rewritten the list, so
 * match by content instead of assuming a particular index.
 */
export function dropTrailingPrefill(messages: readonly Message[], prefill: string): Message[] {
  if (!prefill) return [...messages]
  const last = messages.at(-1)
  return last?.role === 'assistant' && last.content === prefill
    ? messages.slice(0, -1)
    : [...messages]
}
