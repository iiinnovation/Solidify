import { describe, expect, it } from 'vitest'
import { decideOutputRecovery, dropTrailingPrefill, MAX_CONTINUATIONS } from './recovery'

const baseResponse = {
  text: '',
  toolCalls: [],
  stopReason: 'end_turn',
  reasoningLength: 0,
}

describe('output recovery policy', () => {
  it('continues visible output as one trimmed assistant prefill', () => {
    const decision = decideOutputRecovery({
      response: { ...baseResponse, text: 'partial answer\n\n', stopReason: 'max_tokens' },
      messages: [{ role: 'user', content: 'task' }],
      prefill: '',
      continuations: 0,
      reasoningRecoveryUsed: false,
      turn: 1,
      maxTurns: 10,
    })

    expect(decision).toMatchObject({
      kind: 'continue_output',
      continuations: 1,
      prefill: 'partial answer',
    })
    if (decision.kind === 'continue_output') {
      expect(decision.messages.at(-1)).toEqual({ role: 'assistant', content: 'partial answer' })
    }
  })

  it('never continues a truncated tool call', () => {
    const decision = decideOutputRecovery({
      response: {
        ...baseResponse,
        stopReason: 'max_tokens',
        toolCalls: [{ id: 'call-1', name: 'write_file', input: { path: 'a' } }],
      },
      messages: [{ role: 'user', content: 'task' }],
      prefill: '',
      continuations: 0,
      reasoningRecoveryUsed: false,
      turn: 1,
      maxTurns: 10,
    })

    expect(decision).toEqual({ kind: 'exhausted', reason: 'max_tokens', thoughtOnly: false })
  })

  it('permits exactly one compact retry for reasoning-only exhaustion', () => {
    const first = decideOutputRecovery({
      response: { ...baseResponse, stopReason: 'max_tokens', reasoningLength: 100 },
      messages: [{ role: 'user', content: 'task' }],
      prefill: '',
      continuations: 0,
      reasoningRecoveryUsed: false,
      turn: 1,
      maxTurns: 10,
    })
    const second = decideOutputRecovery({
      response: { ...baseResponse, stopReason: 'max_tokens', reasoningLength: 100 },
      messages: [{ role: 'user', content: 'task' }],
      prefill: '',
      continuations: 0,
      reasoningRecoveryUsed: true,
      turn: 2,
      maxTurns: 10,
    })

    expect(first).toEqual({ kind: 'compact_recovery' })
    expect(second).toEqual({ kind: 'exhausted', reason: 'max_output_tokens', thoughtOnly: true })
  })

  it('stops visible continuations at the hard bound', () => {
    const decision = decideOutputRecovery({
      response: { ...baseResponse, text: 'more', stopReason: 'max_tokens' },
      messages: [{ role: 'user', content: 'task' }],
      prefill: 'existing',
      continuations: MAX_CONTINUATIONS,
      reasoningRecoveryUsed: false,
      turn: 5,
      maxTurns: 10,
    })
    expect(decision).toEqual({ kind: 'exhausted', reason: 'max_tokens', thoughtOnly: false })
  })

  it('removes only the matching trailing prefill', () => {
    const messages = [
      { role: 'user' as const, content: 'task' },
      { role: 'assistant' as const, content: 'partial' },
    ]
    expect(dropTrailingPrefill(messages, 'partial')).toEqual([messages[0]])
    expect(dropTrailingPrefill(messages, 'different')).toEqual(messages)
  })
})
