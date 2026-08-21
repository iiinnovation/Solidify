/**
 * Result-aware loop protection for read/retrieval tools.
 *
 * The guard deliberately lives outside query.ts so tool families can opt in
 * through metadata instead of becoming business-name branches in the engine.
 */
import type { Tool, ToolCall, ToolResult } from '../tools/types'
import type { QueryContext, ToolLoopBudget } from './types'

export interface ToolLoopObservation {
  toolName: string
  group: string
  key: string
  callSignature: string
  resultSignature: string
  success: boolean
}

export type ToolLoopDecision =
  | { kind: 'allow' }
  | { kind: 'warn'; message: string }
  | { kind: 'replay'; result: ToolResult }
  | { kind: 'close'; message: string }

const DEFAULT_SOFT_THRESHOLD = 3
const DEFAULT_HARD_THRESHOLD = 5
const DEFAULT_ATTACHMENT_BUDGET: ToolLoopBudget = {
  maxCalls: 10,
  softThreshold: 3,
  hardThreshold: 5,
}

/** Stable JSON is intentionally small and dependency-free. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

/** A deterministic non-cryptographic digest is enough for equality detection. */
export function resultSignature(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${value.length}:${(hash >>> 0).toString(16)}`
}

function budgetFor(ctx: QueryContext, tool: Tool): ToolLoopBudget | undefined {
  const group = tool.loopGroup
  if (!group) return undefined
  const configured = ctx.limits.toolLoopBudgets ?? {}
  const key = tool.loopKey ? `${group}:${tool.loopKey}` : undefined
  if (key && configured[key]) return configured[key]
  if (configured[group]) return configured[group]
  // Attachment retrieval is enabled by the chat context, but low-level tests
  // often construct QueryContext directly. Keep the safety default there too.
  if (group === 'attachment-retrieval') return DEFAULT_ATTACHMENT_BUDGET
  return undefined
}

function loopKey(tool: Tool): string {
  return tool.loopKey ?? tool.name
}

function sameCall(a: ToolLoopObservation, tool: Tool, signature: string): boolean {
  return a.toolName === tool.name && a.callSignature === signature
}

function trailingRepeatCount(records: readonly ToolLoopObservation[], tool: Tool, signature: string): number {
  let count = 0
  for (let index = records.length - 1; index >= 0; index--) {
    if (!sameCall(records[index], tool, signature)) break
    count++
  }
  return count
}

function isPingPong(records: readonly ToolLoopObservation[], candidate: ToolLoopObservation): boolean {
  if (records.length < 3) return false
  const recent = [...records.slice(-3), candidate]
  if (recent[0].callSignature !== recent[2].callSignature || recent[1].callSignature !== recent[3].callSignature) return false
  if (recent[0].toolName !== recent[2].toolName || recent[1].toolName !== recent[3].toolName) return false
  return recent.every((item) => item.resultSignature === candidate.resultSignature)
}

/**
 * Tracks only opted-in tools. Successful repeated reads are not failures, so a
 * conventional failure streak cannot protect this class of loop.
 */
export class ToolLoopGuard {
  private readonly records_: ToolLoopObservation[] = []
  private readonly callsByBudget_ = new Map<string, number>()
  private readonly cachedResults_ = new Map<string, ToolResult>()
  private closedGroups_ = new Set<string>()

  private readonly ctx: QueryContext

  constructor(ctx: QueryContext) {
    this.ctx = ctx
  }

  isClosed(group: string): boolean {
    return this.closedGroups_.has(group)
  }

  inspect(call: ToolCall, tool: Tool): ToolLoopDecision {
    const group = tool.loopGroup
    if (!group) return { kind: 'allow' }
    const budget = budgetFor(this.ctx, tool)
    if (!budget) return { kind: 'allow' }
    if (this.closedGroups_.has(group)) {
      return { kind: 'close', message: this.closedMessage(group) }
    }

    const key = tool.loopKey ? `${group}:${tool.loopKey}` : group
    const groupBudget = (this.ctx.limits.toolLoopBudgets ?? {})[group]
    const groupUsed = this.callsByBudget_.get(group) ?? 0
    const keyUsed = this.callsByBudget_.get(key) ?? 0
    if (groupUsed >= (groupBudget?.maxCalls ?? Number.POSITIVE_INFINITY) || keyUsed >= budget.maxCalls) {
      this.closedGroups_.add(group)
      const limit = Math.min(groupBudget?.maxCalls ?? Number.POSITIVE_INFINITY, budget.maxCalls)
      return { kind: 'close', message: this.budgetMessage(group, limit) }
    }

    const signature = stableStringify(call.input)
    const cached = this.cachedResults_.get(`${tool.name}:${signature}`)
    const consecutive = trailingRepeatCount(this.records_, tool, signature)
    const soft = budget.softThreshold ?? DEFAULT_SOFT_THRESHOLD
    const hard = budget.hardThreshold ?? DEFAULT_HARD_THRESHOLD
    const reserve = () => {
      this.callsByBudget_.set(group, (this.callsByBudget_.get(group) ?? 0) + 1)
      // A tool without a loopKey shares the group's counter. Incrementing both
      // would spend its budget at double rate and close the group a call early.
      if (key !== group) this.callsByBudget_.set(key, (this.callsByBudget_.get(key) ?? 0) + 1)
    }

    if (cached && consecutive >= hard - 1) {
      this.closedGroups_.add(group)
      return { kind: 'close', message: this.noProgressMessage(tool.name, hard) }
    }
    if (cached && consecutive >= soft - 1) {
      if (tool.replaySafe) {
        reserve()
        return { kind: 'replay', result: { ...cached, metadata: { ...cached.metadata, durationMs: 0 } } }
      }
      reserve()
      return { kind: 'warn', message: this.noProgressMessage(tool.name, soft) }
    }

    // For ping-pong we can only predict the result when this exact call has
    // been seen before. That preserves legitimate pagination with new output.
    if (cached) {
      const candidate: ToolLoopObservation = {
        toolName: tool.name,
        group,
        key: loopKey(tool),
        callSignature: signature,
        resultSignature: resultSignature(cached.content),
        success: cached.success,
      }
      if (isPingPong(this.records_, candidate)) {
        this.closedGroups_.add(group)
        return { kind: 'close', message: `检测到 ${group} 工具在无新证据地来回调用，已关闭该检索阶段。请根据已有证据直接生成结果。` }
      }
    }
    reserve()
    return { kind: 'allow' }
  }

  observe(call: ToolCall, tool: Tool, result: ToolResult): void {
    const group = tool.loopGroup
    if (!group || !budgetFor(this.ctx, tool)) return
    const signature = stableStringify(call.input)
    const observation: ToolLoopObservation = {
      toolName: tool.name,
      group,
      key: loopKey(tool),
      callSignature: signature,
      resultSignature: resultSignature(result.content),
      success: result.success,
    }
    this.records_.push(observation)
    this.cachedResults_.set(`${tool.name}:${signature}`, result)

    // Catch semantic no-progress even when the model varies its query or
    // offset. A legitimate paginated read normally changes the result hash;
    // repeated identical evidence across the same loop group does not.
    const groupRecords = this.records_.filter((record) => record.group === group)
    const hard = budgetFor(this.ctx, tool)?.hardThreshold ?? DEFAULT_HARD_THRESHOLD
    const recent = groupRecords.slice(-hard)
    if (
      recent.length >= hard
      && recent.every((record) => record.success && record.resultSignature === observation.resultSignature)
    ) {
      this.closedGroups_.add(group)
    }
  }

  private budgetMessage(group: string, maxCalls: number): string {
    return `${group} 检索预算已用尽（最多 ${maxCalls} 次）。请停止读取附件，依据已获得证据直接生成结果。`
  }

  private closedMessage(group: string): string {
    return `${group} 检索阶段已关闭。请不要继续调用该组工具，依据已有证据直接生成结果。`
  }

  private noProgressMessage(toolName: string, threshold: number): string {
    return `检测到工具 ${toolName} 已连续 ${threshold} 次重复且没有新证据。请改用已有内容继续任务，不要再次读取相同附件片段。`
  }
}
