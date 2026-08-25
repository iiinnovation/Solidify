import { appendWorkspaceRecord, isTauri } from '@/lib/tauri'
import { isStorageQuotaError, setStorageItemWithQuotaRecovery } from '@/lib/storage-quota'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type LedgerEventType =
  | 'run.started'
  | 'run.planned'
  | 'phase.started'
  | 'capability.bound'
  | 'phase.completed'
  | 'phase.transitioned'
  | 'deliverable.validated'
  | 'deliverable.repairing'
  | 'skill.activated'
  | 'model.called'
  | 'model.completed'
  | 'model.retrying'
  | 'model.failed'
  | 'tool.requested'
  | 'approval.asked'
  | 'approval.decided'
  | 'permission.grant_added'
  | 'tool.completed'
  | 'artifact.created'
  | 'artifact.parse_failed'
  | 'run.completed'
  | 'run.failed'
  | 'run.exhausted'

const LEDGER_EVENT_TYPES = new Set<LedgerEventType>([
  'run.started', 'run.planned', 'phase.started', 'capability.bound', 'phase.completed', 'phase.transitioned',
  'deliverable.validated', 'deliverable.repairing',
  'skill.activated', 'model.called', 'model.completed', 'model.retrying', 'model.failed',
  'tool.requested', 'approval.asked', 'approval.decided',
  'permission.grant_added', 'tool.completed', 'artifact.created', 'artifact.parse_failed',
  'run.completed', 'run.failed', 'run.exhausted',
])

export interface LedgerEvent { seq: number; runId: string; ts: string; type: LedgerEventType; payload: JsonValue }

export interface RunTreeNode {
  runId: string
  parentRunId?: string
  events: LedgerEvent[]
  children: RunTreeNode[]
}

export function parseLedgerEvents(input: unknown, expectedRunId?: string): LedgerEvent[] {
  if (!Array.isArray(input)) throw new Error('Ledger snapshot must be an array')
  let runId = expectedRunId
  return input.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Invalid ledger event')
    const event = candidate as Record<string, unknown>
    if (!Number.isSafeInteger(event.seq) || event.seq !== index + 1) throw new Error('Invalid ledger sequence')
    if (typeof event.runId !== 'string' || event.runId.length === 0) throw new Error('Invalid ledger run ID')
    runId ??= event.runId
    if (event.runId !== runId) throw new Error('Mixed ledger run IDs')
    if (typeof event.ts !== 'string' || Number.isNaN(Date.parse(event.ts))) throw new Error('Invalid ledger timestamp')
    if (typeof event.type !== 'string' || !LEDGER_EVENT_TYPES.has(event.type as LedgerEventType)) throw new Error('Invalid ledger event type')
    return Object.freeze({
      seq: event.seq,
      runId: event.runId,
      ts: event.ts,
      type: event.type as LedgerEventType,
      payload: compactLedgerPayload(event.type as LedgerEventType, snapshotJson(event.payload)),
    })
  })
}

export function snapshotJson(value: unknown): JsonValue {
  const seen = new WeakSet<object>()
  const convert = (input: unknown): JsonValue => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
    if (typeof input === 'number') { if (!Number.isFinite(input)) throw new Error('Non-finite values are not serializable'); return input }
    if (typeof input !== 'object') throw new Error('Functions, undefined and runtime objects are not serializable')
    const prototype = Object.getPrototypeOf(input)
    if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) throw new Error('Special runtime objects are not serializable')
    if (seen.has(input as object)) throw new Error('Circular value is not serializable')
    seen.add(input as object)
    if (Array.isArray(input)) {
      const output = Object.freeze(input.map(convert)) as unknown as JsonValue[]
      seen.delete(input)
      return output
    }
    const output: Record<string, JsonValue> = {}
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (value === undefined) continue
      // `output[key] = ...` invokes the inherited __proto__ setter for that key:
      // the property is silently dropped and the object's prototype is replaced,
      // which then trips the prototype guard above on the next snapshot and
      // kills the run. A model can emit {"__proto__": {}} as tool input.
      Object.defineProperty(output, key, {
        value: convert(value),
        enumerable: true,
        writable: false,
        configurable: false,
      })
    }
    seen.delete(input as object)
    return Object.freeze(output)
  }
  return convert(value)
}

export class RunLedger {
  private events_: LedgerEvent[] = []
  readonly runId: string
  private readonly storageKey: string
  constructor(runId: string, storageKey = `solidify-ledger:${runId}`) { this.runId = runId; this.storageKey = storageKey; this.restore() }

  append(type: LedgerEventType, payload: unknown, options: { requirePersistence?: boolean } = {}): LedgerEvent {
    const event: LedgerEvent = Object.freeze({ seq: this.events_.length + 1, runId: this.runId, ts: new Date().toISOString(), type, payload: compactLedgerPayload(type, snapshotJson(payload)) })
    this.events_.push(event)
    try {
      this.persist()
    } catch (error) {
      if (!isStorageQuotaError(error) || options.requirePersistence) {
        this.events_.pop()
        throw error
      }
      console.warn('[ledger] Browser storage is full; keeping this run event in memory only')
    }
    if (workspaceLedgerRoot && isTauri) {
      const root = workspaceLedgerRoot
      workspaceLedgerQueue = workspaceLedgerQueue
        .then(() => appendWorkspaceRecord(root, 'ledger', this.runId, event))
        .catch((error) => { console.error('Unable to append workspace ledger:', error) })
    }
    return event
  }
  events(): LedgerEvent[] { return this.events_.map((event) => ({ ...event, payload: snapshotJson(event.payload) })) }
  find(type: LedgerEventType): LedgerEvent[] { return this.events_.filter((event) => event.type === type) }
  clear(): void { this.events_ = []; if (typeof localStorage !== 'undefined') localStorage.removeItem(this.storageKey) }
  private persist(): void {
    if (typeof localStorage !== 'undefined') {
      setStorageItemWithQuotaRecovery(localStorage, this.storageKey, JSON.stringify(this.events_))
    }
  }
  private restore(): void {
    if (typeof localStorage === 'undefined') return
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(this.storageKey) ?? '[]')
      this.events_ = parseLedgerEvents(raw, this.runId)
      if (containsVerboseLegacyModelPayload(raw)) {
        try { this.persist() }
        catch (error) { console.warn('[ledger] Unable to compact a legacy model payload:', error) }
      }
    }
    catch { this.events_ = [] }
  }
}

/**
 * Model prompts and answers belong to conversation snapshots, not telemetry.
 * Keep this at the persistence boundary so old ledgers are compacted on read
 * and a future caller cannot accidentally reintroduce full request bodies.
 */
function compactLedgerPayload(type: LedgerEventType, payload: JsonValue): JsonValue {
  if (!isRecord(payload)) return payload
  if (type === 'model.called' && isRecord(payload.request)) {
    const request = payload.request
    return snapshotJson({
      ...payload,
      request: {
        model: request.model ?? null,
        temperature: request.temperature ?? null,
        maxTokens: request.maxTokens ?? null,
        topP: request.topP ?? null,
        stream: request.stream ?? null,
        messageCount: Array.isArray(request.messages) ? request.messages.length : request.messageCount ?? 0,
        toolCount: Array.isArray(request.tools) ? request.tools.length : request.toolCount ?? 0,
        toolChoice: request.toolChoice ?? 'auto',
        promptCache: request.promptCache ?? null,
      },
    })
  }
  if (type === 'model.completed') {
    const legacyText = typeof payload.text === 'string' ? payload.text : undefined
    const legacyToolCalls = Array.isArray(payload.toolCalls) ? payload.toolCalls : undefined
    const { text: _text, toolCalls: _toolCalls, ...rest } = payload
    return snapshotJson({
      ...rest,
      textLength: payload.textLength ?? legacyText?.length ?? 0,
      toolCallCount: payload.toolCallCount ?? legacyToolCalls?.length ?? 0,
      toolCallNames: payload.toolCallNames ?? legacyToolCalls?.map((call) => isRecord(call) && typeof call.name === 'string' ? call.name : 'unknown') ?? [],
    })
  }
  return payload
}

function containsVerboseLegacyModelPayload(input: unknown): boolean {
  if (!Array.isArray(input)) return false
  return input.some((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
    const event = candidate as Record<string, unknown>
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return false
    const payload = event.payload as Record<string, unknown>
    if (event.type === 'model.completed') return 'text' in payload || 'toolCalls' in payload
    if (event.type !== 'model.called' || !payload.request || typeof payload.request !== 'object' || Array.isArray(payload.request)) return false
    const request = payload.request as Record<string, unknown>
    return 'system' in request || 'messages' in request || Array.isArray(request.tools)
  })
}

/** Build a parent → child ledger tree from already loaded run ledgers. */
export function buildRunTree(ledgers: readonly RunLedger[], rootRunId: string): RunTreeNode | null {
  const nodes = new Map<string, RunTreeNode>()
  for (const ledger of ledgers) {
    const events = ledger.events()
    const started = events.find((event) => event.type === 'run.started')
    const parent = started && isRecord(started.payload) && typeof started.payload.parentRunId === 'string'
      ? started.payload.parentRunId
      : undefined
    nodes.set(ledger.runId, { runId: ledger.runId, ...(parent ? { parentRunId: parent } : {}), events, children: [] })
  }
  const root = nodes.get(rootRunId)
  if (!root) return null
  for (const node of nodes.values()) {
    if (!node.parentRunId) continue
    const parent = nodes.get(node.parentRunId)
    if (parent && parent !== node && !parent.children.includes(node)) parent.children.push(node)
  }
  return root
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

let workspaceLedgerRoot: string | null = null
let workspaceLedgerQueue = Promise.resolve()

export function configureLedgerWorkspace(root: string | null): void {
  workspaceLedgerRoot = root
}

export function flushWorkspaceLedger(): Promise<void> {
  return workspaceLedgerQueue
}

export function recoverLedger(events: readonly LedgerEvent[]): Array<LedgerEvent & { outcomeUnknown?: boolean }> {
  const completed = new Set(events.filter((event) => event.type === 'tool.completed').map((event) => (event.payload as Record<string, JsonValue>).callId))
  return events.map((event) => event.type === 'tool.requested' && !completed.has((event.payload as Record<string, JsonValue>).callId)
    ? { ...event, outcomeUnknown: true }
    : event)
}
