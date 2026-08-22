import { describe, expect, it } from 'vitest'
import type { LedgerEvent } from './ledger'
import { deriveBenchmarkObservation, deriveBenchmarkResult } from './telemetry'

function event(seq: number, type: LedgerEvent['type'], ts: string, payload: LedgerEvent['payload']): LedgerEvent {
  return { seq, runId: 'run-benchmark', type, ts, payload }
}

describe('benchmark telemetry export', () => {
  it('derives redacted timings, calls and cache usage from ledger facts', () => {
    const rows = [
      event(1, 'run.started', '2026-08-22T00:00:00.000Z', null),
      event(2, 'model.called', '2026-08-22T00:00:00.010Z', { turn: 1 }),
      event(3, 'model.completed', '2026-08-22T00:00:00.120Z', {
        firstChunkAt: '2026-08-22T00:00:00.050Z',
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40, cacheWriteTokens: 60 },
      }),
      event(4, 'tool.requested', '2026-08-22T00:00:00.130Z', { name: 'read_file' }),
      event(5, 'artifact.created', '2026-08-22T00:00:00.200Z', { id: 'artifact-1' }),
      event(6, 'run.completed', '2026-08-22T00:00:00.300Z', { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40, cacheWriteTokens: 60 } }),
    ]
    const result = deriveBenchmarkResult(rows, {
      caseId: 'plain-01', provider: 'fixture', model: 'fixture-model', runtimeVersion: 'test',
      quality: { coverage: 4, factuality: 4, acceptance: 4, format: 4, usability: 4 }, reviewerNotes: 'ok',
    })
    expect(result).toMatchObject({
      runId: 'run-benchmark', status: 'completed', providerCalls: 1, toolCalls: 1,
      firstChunkMs: 50, firstArtifactMs: 200, durationMs: 300,
      cacheReadTokens: 40, cacheWriteTokens: 60,
    })
  })

  it('classifies exhausted runs without retaining the error body', () => {
    const result = deriveBenchmarkResult([
      event(1, 'run.started', '2026-08-22T00:00:00.000Z', null),
      event(2, 'run.exhausted', '2026-08-22T00:00:00.100Z', { reason: 'max_tokens', error: 'private text' }),
    ], {
      caseId: 'failed-01', provider: 'fixture', model: 'fixture-model', runtimeVersion: 'test',
      quality: { coverage: 0, factuality: 0, acceptance: 0, format: 0, usability: 0 }, reviewerNotes: 'failed',
    })
    expect(result).toMatchObject({ status: 'failed', failureClass: 'max_tokens', durationMs: 100 })
    expect(JSON.stringify(result)).not.toContain('private text')
  })

  it('fails closed when an interrupted ledger has no terminal fact', () => {
    expect(() => deriveBenchmarkObservation([
      event(1, 'run.started', '2026-08-22T00:00:00.000Z', null),
      event(2, 'model.called', '2026-08-22T00:00:00.010Z', { turn: 1 }),
    ], { caseId: 'partial-01', provider: 'fixture', model: 'fixture-model', runtimeVersion: 'test' })).toThrow('terminal')
  })

  it('accepts a streamed Artifact timestamp when the UI parser owns the envelope', () => {
    const result = deriveBenchmarkObservation([
      event(1, 'run.started', '2026-08-22T00:00:00.000Z', null),
      event(2, 'model.completed', '2026-08-22T00:00:00.100Z', { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
      event(3, 'run.completed', '2026-08-22T00:00:01.000Z', { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
    ], { caseId: 'artifact-01', provider: 'fixture', model: 'fixture-model', runtimeVersion: 'test' }, {
      firstArtifactAt: Date.parse('2026-08-22T00:00:00.250Z'),
    })
    expect(result.firstArtifactMs).toBe(250)
  })
})
