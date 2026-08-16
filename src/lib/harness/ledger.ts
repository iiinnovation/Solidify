import { appendWorkspaceRecord, isTauri } from '@/lib/tauri'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type LedgerEventType = 'run.started' | 'model.called' | 'model.completed' | 'model.failed' | 'tool.requested' | 'approval.asked' | 'approval.decided' | 'permission.grant_added' | 'tool.completed' | 'artifact.created' | 'run.completed' | 'run.failed' | 'run.exhausted'

const LEDGER_EVENT_TYPES = new Set<LedgerEventType>([
  'run.started', 'model.called', 'model.completed', 'model.failed',
  'tool.requested', 'approval.asked', 'approval.decided',
  'permission.grant_added', 'tool.completed', 'artifact.created',
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
      payload: snapshotJson(event.payload),
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

  append(type: LedgerEventType, payload: unknown): LedgerEvent {
    const event: LedgerEvent = Object.freeze({ seq: this.events_.length + 1, runId: this.runId, ts: new Date().toISOString(), type, payload: snapshotJson(payload) })
    this.events_.push(event)
    try { this.persist() } catch (error) { this.events_.pop(); throw error }
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
  private persist(): void { if (typeof localStorage !== 'undefined') localStorage.setItem(this.storageKey, JSON.stringify(this.events_)) }
  private restore(): void {
    if (typeof localStorage === 'undefined') return
    try { this.events_ = parseLedgerEvents(JSON.parse(localStorage.getItem(this.storageKey) ?? '[]'), this.runId) }
    catch { this.events_ = [] }
  }
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

/** Load all localStorage ledgers and return the requested task tree. */
export function loadRunTree(rootRunId: string): RunTreeNode | null {
  if (typeof localStorage === 'undefined') return null
  const ledgers: RunLedger[] = []
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (!key?.startsWith('solidify-ledger:')) continue
    const runId = key.slice('solidify-ledger:'.length)
    if (!runId) continue
    ledgers.push(new RunLedger(runId, key))
  }
  return buildRunTree(ledgers, rootRunId)
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
