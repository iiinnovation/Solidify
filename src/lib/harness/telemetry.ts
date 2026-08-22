import { parseLedgerEvents, snapshotJson, type LedgerEvent, type JsonValue } from './ledger'

export interface RunTelemetry {
  runId: string
  startedAt: string
  durationMs: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  toolCalls: number
  failed: boolean
  cost?: number
}

export interface BenchmarkQualityScores {
  coverage: number
  factuality: number
  acceptance: number
  format: number
  usability: number
}

export interface BenchmarkRunMetadata {
  caseId: string
  provider: string
  model: string
  runtimeVersion: string
  quality: BenchmarkQualityScores
  reviewerNotes: string
}

/** Provider-observed facts emitted before human quality review. */
export interface BenchmarkObservationMetadata {
  caseId: string
  provider: string
  model: string
  runtimeVersion: string
}

export interface BenchmarkResultRow extends BenchmarkRunMetadata {
  runId: string
  status: 'completed' | 'failed'
  providerCalls: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  firstChunkMs: number
  firstArtifactMs: number | null
  durationMs: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  failureClass?: string
}
export interface BenchmarkObservationRow extends BenchmarkObservationMetadata {
  runId: string
  status: 'completed' | 'failed'
  providerCalls: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  firstChunkMs: number
  firstArtifactMs: number | null
  durationMs: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  failureClass?: string
}
export interface BenchmarkObservationOptions {
  /** Wall-clock timestamp captured when the streamed Artifact envelope opens. */
  firstArtifactAt?: number
}
export type TelemetrySanitizer = (event: LedgerEvent) => LedgerEvent | null

export function deriveRunTelemetry(events: readonly LedgerEvent[]): RunTelemetry {
  const first = events[0]?.ts ? Date.parse(events[0].ts) : Date.now()
  const last = events.at(-1)?.ts ? Date.parse(events.at(-1)!.ts) : first
  const terminal = [...events].reverse().find((event) => event.type === 'run.completed' || event.type === 'run.exhausted' || event.type === 'run.failed')
  const terminalPayload = terminal?.payload as Record<string, JsonValue> | undefined
  const usage = terminalPayload?.usage && typeof terminalPayload.usage === 'object' && !Array.isArray(terminalPayload.usage)
    ? terminalPayload.usage as Record<string, JsonValue>
    : terminalPayload
  return {
    runId: events[0]?.runId ?? '', startedAt: events[0]?.ts ?? new Date(first).toISOString(), durationMs: Math.max(0, last - first),
    inputTokens: Number(usage?.inputTokens ?? 0), outputTokens: Number(usage?.outputTokens ?? 0), totalTokens: Number(usage?.totalTokens ?? 0),
    cacheReadTokens: Number(usage?.cacheReadTokens ?? 0), cacheWriteTokens: Number(usage?.cacheWriteTokens ?? 0),
    toolCalls: events.filter((event) => event.type === 'tool.requested').length,
    failed: events.some((event) => event.type === 'run.failed' || event.type === 'run.exhausted'),
  }
}

/**
 * Convert a persisted run ledger into the redacted row consumed by the
 * agent-pipeline benchmark gate. The reviewer supplies quality scores; all
 * timings and token counts come from ledger facts rather than UI state.
 */
export function deriveBenchmarkResult(
  events: readonly LedgerEvent[],
  metadata: BenchmarkRunMetadata,
): BenchmarkResultRow {
  return { ...deriveBenchmarkObservation(events, metadata), quality: metadata.quality, reviewerNotes: metadata.reviewerNotes }
}

/**
 * Convert a ledger into objective benchmark facts without inventing a quality
 * score. The live runner writes these rows first; a reviewer later merges the
 * five rubric scores through the preparation script.
 */
export function deriveBenchmarkObservation(
  events: readonly LedgerEvent[],
  metadata: BenchmarkObservationMetadata,
  options: BenchmarkObservationOptions = {},
): BenchmarkObservationRow {
  if (events.length === 0) throw new Error('Cannot benchmark an empty run ledger')
  const startedAt = Date.parse(events[0].ts)
  const terminal = [...events].reverse().find((event) => event.type === 'run.completed' || event.type === 'run.exhausted' || event.type === 'run.failed')
  if (!terminal) throw new Error('Cannot benchmark a run ledger without a terminal event')
  const terminalAt = Date.parse(terminal.ts)
  const failed = terminal?.type === 'run.failed' || terminal?.type === 'run.exhausted'
  const terminalPayload = asRecord(terminal?.payload)
  const usage = asRecord(terminalPayload?.usage) ?? terminalPayload ?? {}
  const firstChunkMs = earliestOffset(events, (event) => {
    if (event.type !== 'model.completed') return undefined
    const timestamp = asRecord(event.payload)?.firstChunkAt
    return typeof timestamp === 'string' ? Date.parse(timestamp) : undefined
  }, startedAt)
  const ledgerFirstArtifactMs = earliestOffsetOrNull(events, (event) => event.type === 'artifact.created' ? Date.parse(event.ts) : undefined, startedAt)
  const firstArtifactMs = options.firstArtifactAt === undefined
    ? ledgerFirstArtifactMs
    : Math.max(0, options.firstArtifactAt - startedAt)
  const result: BenchmarkObservationRow = {
    ...metadata,
    runId: events[0].runId,
    status: failed ? 'failed' : 'completed',
    providerCalls: events.filter((event) => event.type === 'model.called').length,
    toolCalls: events.filter((event) => event.type === 'tool.requested').length,
    inputTokens: nonNegativeInt(usage.inputTokens),
    outputTokens: nonNegativeInt(usage.outputTokens),
    totalTokens: nonNegativeInt(usage.totalTokens),
    firstChunkMs: firstChunkMs ?? Math.max(0, terminalAt - startedAt),
    firstArtifactMs,
    durationMs: Math.max(0, terminalAt - startedAt),
  }
  const cacheReadTokens = nonNegativeIntOrUndefined(usage.cacheReadTokens)
  const cacheWriteTokens = nonNegativeIntOrUndefined(usage.cacheWriteTokens)
  if (cacheReadTokens !== undefined) result.cacheReadTokens = cacheReadTokens
  if (cacheWriteTokens !== undefined) result.cacheWriteTokens = cacheWriteTokens
  if (failed) result.failureClass = safeFailureClass(terminalPayload?.reason ?? terminalPayload?.kind)
  return result
}

export function sanitizeTelemetry(events: readonly LedgerEvent[], sanitizer: TelemetrySanitizer): LedgerEvent[] {
  const output: LedgerEvent[] = []
  for (const event of events) {
    try {
      const isolated = cloneLedgerEvent(event)
      const sanitized = sanitizer(isolated)
      if (sanitized) output.push(cloneLedgerEvent(sanitized))
    }
    catch { /* fail closed: retain neither raw nor partially sanitized event */ }
  }
  return output
}

function cloneLedgerEvent(event: LedgerEvent): LedgerEvent {
  return Object.freeze({
    seq: event.seq,
    runId: event.runId,
    ts: event.ts,
    type: event.type,
    payload: snapshotJson(event.payload),
  })
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined
}

function nonNegativeInt(value: JsonValue | undefined): number {
  return nonNegativeIntOrUndefined(value) ?? 0
}

function nonNegativeIntOrUndefined(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function safeFailureClass(value: JsonValue | undefined): string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9:_-]{0,63}$/i.test(value) ? value : 'unknown'
}

function earliestOffset(
  events: readonly LedgerEvent[],
  getTimestamp: (event: LedgerEvent) => number | undefined,
  startedAt: number,
): number | undefined {
  const timestamps = events.map(getTimestamp).filter((value): value is number => value !== undefined && Number.isFinite(value))
  return timestamps.length ? Math.max(0, Math.min(...timestamps) - startedAt) : undefined
}

function earliestOffsetOrNull(
  events: readonly LedgerEvent[],
  getTimestamp: (event: LedgerEvent) => number | undefined,
  startedAt: number,
): number | null {
  return earliestOffset(events, getTimestamp, startedAt) ?? null
}

export function loadRecentRunTelemetry(limit = 20): RunTelemetry[] {
  if (typeof localStorage === 'undefined') return []
  const runs: RunTelemetry[] = []
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (!key?.startsWith('solidify-ledger:')) continue
    try {
      const runId = key.slice('solidify-ledger:'.length)
      const events = parseLedgerEvents(JSON.parse(localStorage.getItem(key) ?? '[]'), runId)
      if (events.length > 0) runs.push(deriveRunTelemetry(events))
    } catch { /* corrupted local telemetry is omitted */ }
  }
  return runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, limit)
}

export class TelemetrySink {
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private readonly emit: (event: LedgerEvent) => void | Promise<void>
  constructor(emit: (event: LedgerEvent) => void | Promise<void>) { this.emit = emit }
  push(event: LedgerEvent): void { if (this.disposed) return; this.queue = this.queue.then(() => this.emit(event)).catch(() => undefined) }
  async dispose(): Promise<void> { this.disposed = true; await this.queue }
}
