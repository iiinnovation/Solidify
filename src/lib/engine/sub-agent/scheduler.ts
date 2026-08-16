import { MAX_SUB_AGENT_CONCURRENCY } from './types'

export type ScheduledResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }

/** Bounded FIFO scheduler. A failed worker never rejects or cancels its siblings. */
export class SubAgentScheduler {
  readonly concurrency: number

  constructor(concurrency = MAX_SUB_AGENT_CONCURRENCY) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_SUB_AGENT_CONCURRENCY) {
      throw new Error(`Sub-agent concurrency must be between 1 and ${MAX_SUB_AGENT_CONCURRENCY}`)
    }
    this.concurrency = concurrency
  }

  async run<T, R>(
    items: readonly T[],
    worker: (item: T, index: number) => Promise<R>,
    signal?: AbortSignal,
  ): Promise<Array<ScheduledResult<R>>> {
    const results = new Array<ScheduledResult<R>>(items.length)
    let nextIndex = 0

    const consume = async () => {
      while (true) {
        const index = nextIndex++
        if (index >= items.length) return
        if (signal?.aborted) {
          results[index] = { status: 'rejected', reason: abortError(signal.reason) }
          continue
        }
        try {
          results[index] = { status: 'fulfilled', value: await worker(items[index], index) }
        } catch (reason) {
          results[index] = { status: 'rejected', reason }
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(this.concurrency, items.length) },
      () => consume(),
    )
    await Promise.all(workers)
    return results
  }
}

function abortError(reason: unknown): Error {
  const error = new Error(typeof reason === 'string' ? reason : 'Sub-agent dispatch aborted')
  error.name = 'AbortError'
  return error
}
