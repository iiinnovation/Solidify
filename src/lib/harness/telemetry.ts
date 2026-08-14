import { parseLedgerEvents, snapshotJson, type LedgerEvent, type JsonValue } from './ledger'

export interface RunTelemetry { runId: string; startedAt: string; durationMs: number; inputTokens: number; outputTokens: number; totalTokens: number; toolCalls: number; failed: boolean; cost?: number }
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
    toolCalls: events.filter((event) => event.type === 'tool.requested').length,
    failed: events.some((event) => event.type === 'run.failed' || event.type === 'run.exhausted'),
  }
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
