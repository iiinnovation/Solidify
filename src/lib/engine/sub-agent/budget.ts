import type { TaskTreeBudget, TaskTreeBudgetSnapshot } from './types'

/** Shared monotonic token counter and cancellation source for one task tree. */
export class SharedTaskTreeBudget implements TaskTreeBudget {
  private readonly controller = new AbortController()
  private readonly usage = new Map<string, number>()
  private usedTokens = 0
  private reason?: string
  private unlinkParent: () => void = () => {}

  readonly limit: number

  constructor(limit: number, parentSignal?: AbortSignal) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error('Task-tree token budget must be a positive integer')
    }
    this.limit = limit
    this.unlinkParent = linkAbort(parentSignal, () => this.abort('parent_aborted'))
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get abortReason(): string | undefined {
    return this.reason
  }

  consume(runId: string, tokens: number): boolean {
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      throw new Error('Consumed tokens must be a non-negative integer')
    }
    if (this.signal.aborted) return false
    if (tokens === 0) return true

    this.usedTokens += tokens
    this.usage.set(runId, (this.usage.get(runId) ?? 0) + tokens)
    if (this.usedTokens > this.limit) {
      this.abort('budget_exhausted')
      return false
    }
    return true
  }

  snapshot(): TaskTreeBudgetSnapshot {
    return Object.freeze({
      limit: this.limit,
      used: this.usedTokens,
      remaining: Math.max(0, this.limit - this.usedTokens),
      exhausted: this.reason === 'budget_exhausted',
      byRun: Object.freeze(Object.fromEntries(this.usage)),
    })
  }

  abort(reason = 'cancelled'): void {
    if (this.controller.signal.aborted) return
    this.reason = reason
    const unlink = this.unlinkParent
    this.unlinkParent = () => {}
    unlink()
    this.controller.abort(reason)
  }
}

function linkAbort(signal: AbortSignal | undefined, abort: () => void): () => void {
  if (!signal) return () => {}
  if (signal.aborted) {
    abort()
    return () => {}
  }
  signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}
