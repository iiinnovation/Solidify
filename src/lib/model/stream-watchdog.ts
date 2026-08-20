/**
 * Shared stream stall watchdog for provider implementations
 * @module lib/model/stream-watchdog
 */

/**
 * Quiet time allowed between chunks when neither the request nor the caller's
 * transport budget says otherwise. Deliberately below the SDK's own timeout so
 * a gateway that accepts the connection and then goes silent surfaces as a
 * retryable timeout instead of hanging the run.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 30_000

/**
 * Resolve the quiet-time budget for one streaming request.
 *
 * A caller that sets an explicit transport `timeout` has already stated how
 * long the whole exchange may take; shrinking that to the shared default would
 * silently override it (the PPTD pipeline asks for 180s per page and would
 * otherwise be cut to 30s). `stallTimeoutMs` still wins when a caller wants
 * chunk-level detection tighter than its overall budget.
 */
export function resolveStallTimeout(request: { stallTimeoutMs?: number; timeout?: number }): number {
  return request.stallTimeoutMs ?? request.timeout ?? DEFAULT_STALL_TIMEOUT_MS
}

/**
 * Wrap an async iterable with a chunk-level stall watchdog.
 *
 * If no item arrives within `timeoutMs`, `onTimeout` runs (providers use it to
 * abort the underlying HTTP request) and the generator throws. The window
 * covers the first chunk too, so a connection that is accepted but never
 * produces a token is caught rather than waiting on the transport timeout.
 */
export async function* iterateWithStallTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]()
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.()
        reject(new Error(`Stream stalled: no chunk received for ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
    })

    try {
      const result = await Promise.race([iterator.next(), timeoutPromise])
      if (timer) clearTimeout(timer)
      if (result.done) break
      yield result.value
    } catch (error) {
      if (timer) clearTimeout(timer)
      try {
        await iterator.return?.()
      } catch {
        // Cleanup is best-effort; the original failure is what matters.
      }
      throw error
    }
  }
}
