import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_STALL_TIMEOUT_MS, iterateWithStallTimeout, resolveStallTimeout } from '../stream-watchdog'

describe('resolveStallTimeout', () => {
  it('prefers an explicit stall budget over everything else', () => {
    expect(resolveStallTimeout({ stallTimeoutMs: 5_000, timeout: 180_000 })).toBe(5_000)
  })

  it('does not shrink a caller-declared transport budget', () => {
    // The PPTD pipeline asks for 180s per page; defaulting to 30s of quiet time
    // would abort long prefills that the caller deliberately allowed for.
    expect(resolveStallTimeout({ timeout: 180_000 })).toBe(180_000)
  })

  it('falls back to the shared default when the caller says nothing', () => {
    expect(resolveStallTimeout({})).toBe(DEFAULT_STALL_TIMEOUT_MS)
  })
})

describe('iterateWithStallTimeout', () => {
  it('allows a task chunk after 30 seconds but still aborts at its finite budget', async () => {
    vi.useFakeTimers()
    try {
      const abort = vi.fn()
      const source: AsyncIterable<string> = {
        [Symbol.asyncIterator]() {
          let first = true
          return {
            next: () => {
              if (!first) return new Promise<IteratorResult<string>>(() => {})
              first = false
              return new Promise<IteratorResult<string>>((resolve) => setTimeout(() => resolve({ done: false, value: 'ready' }), 40_000))
            },
            return: async () => ({ done: true as const, value: undefined }),
          }
        },
      }
      const iterator = iterateWithStallTimeout(source, 120_000, abort)
      const first = iterator.next()
      await vi.advanceTimersByTimeAsync(40_000)
      expect(await first).toEqual({ done: false, value: 'ready' })
      expect(abort).not.toHaveBeenCalled()
      const stalled = expect(iterator.next()).rejects.toThrow('120s')
      await vi.advanceTimersByTimeAsync(120_000)
      await stalled
      expect(abort).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes chunks through untouched while they keep arriving', async () => {
    async function* source() {
      yield 'a'
      await new Promise((resolve) => setTimeout(resolve, 5))
      yield 'b'
    }

    const seen: string[] = []
    for await (const chunk of iterateWithStallTimeout(source(), 50)) seen.push(chunk)
    expect(seen).toEqual(['a', 'b'])
  })

  it('aborts and throws once the gap between chunks exceeds the budget', async () => {
    let released = false
    async function* source() {
      yield 'a'
      await new Promise((resolve) => setTimeout(resolve, 200))
      yield 'b'
    }

    const iterable = source()
    const original = iterable.return.bind(iterable)
    iterable.return = ((value?: unknown) => {
      released = true
      return original(value as never)
    }) as typeof iterable.return

    let aborted = false
    const seen: string[] = []
    await expect((async () => {
      for await (const chunk of iterateWithStallTimeout(iterable, 20, () => { aborted = true })) seen.push(chunk)
    })()).rejects.toThrow(/stalled/i)

    expect(seen).toEqual(['a'])
    expect(aborted).toBe(true)
    expect(released).toBe(true)
  })

  it('applies the budget to the wait for the very first chunk', async () => {
    async function* source() {
      await new Promise((resolve) => setTimeout(resolve, 200))
      yield 'a'
    }

    await expect((async () => {
      for await (const _chunk of iterateWithStallTimeout(source(), 20)) { /* drain */ }
    })()).rejects.toThrow(/stalled/i)
  })
})
