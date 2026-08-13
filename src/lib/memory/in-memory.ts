import type { MemoryFragment, MemoryState } from './types'

/** Per-run handle store. M3 replaces this implementation with memdir persistence. */
export class InMemoryState implements MemoryState {
  private readonly values = new Map<string, string>()
  private readonly handlesByValue = new Map<string, string>()
  private nextId = 0

  async store(data: string): Promise<string> {
    const existing = this.handlesByValue.get(data)
    if (existing) return existing
    const handle = `handle-${++this.nextId}`
    this.values.set(handle, data)
    this.handlesByValue.set(data, handle)
    return handle
  }

  async retrieve(handle: string): Promise<string | null> {
    return this.values.get(handle) ?? null
  }

  async search(query: string, limit = 10): Promise<MemoryFragment[]> {
    const normalized = query.toLowerCase()
    return Array.from(this.values.entries())
      .filter(([, value]) => value.toLowerCase().includes(normalized))
      .slice(0, limit)
      .map(([source, content]) => ({
        content,
        relevance: 1,
        source,
        timestamp: new Date().toISOString(),
      }))
  }

  async clear(): Promise<void> {
    this.values.clear()
    this.handlesByValue.clear()
  }
}
