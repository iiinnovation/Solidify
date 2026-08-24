import type { MemoryFragment, MemoryState } from './types'
import { MemdirMemory } from './memdir'
import { InMemoryState } from './in-memory'
import { WorkspaceRAGProvider } from '@/lib/rag/workspace-provider'

export async function retrieveWorkspaceMemory(root: string, query: string, limit = 5): Promise<MemoryFragment[]> {
  const matches = await new WorkspaceRAGProvider(root).searchKnowledge(query, { matchCount: limit })
  return matches.map((match) => ({
    content: match.content,
    relevance: match.similarity,
    source: typeof match.metadata?.path === 'string' ? match.metadata.path : match.id,
    timestamp: match.created_at,
  }))
}

export class WorkspaceMemory implements MemoryState {
  private readonly memdir: MemdirMemory
  private readonly fallback = new InMemoryState()
  private readonly root: string

  constructor(root: string) {
    this.root = root
    this.memdir = new MemdirMemory(root)
  }

  async store(data: string): Promise<string> {
    try {
      return await this.memdir.store(data)
    } catch (error) {
      // A selected workspace may be read-only, temporarily unavailable, or
      // missing its cache directory. The handle is needed for this run even if
      // persistence is unavailable, so retain it in the per-run memory store.
      console.warn('[memory] Workspace memdir unavailable; using in-memory handle:', error)
      return this.fallback.store(data)
    }
  }

  async retrieve(handle: string): Promise<string | null> {
    if (handle.startsWith('handle-')) return this.fallback.retrieve(handle)
    try {
      return await this.memdir.retrieve(handle) ?? await this.fallback.retrieve(handle)
    } catch {
      return this.fallback.retrieve(handle)
    }
  }

  async clear(): Promise<void> {
    await Promise.allSettled([this.memdir.clear(), this.fallback.clear()])
  }

  async search(query: string, limit = 10): Promise<MemoryFragment[]> {
    const [durable, transient, workspace] = await Promise.allSettled([
      this.memdir.search(query, limit),
      this.fallback.search(query, limit),
      retrieveWorkspaceMemory(this.root, query, limit),
    ])
    const fragments = (result: PromiseSettledResult<MemoryFragment[]>) => result.status === 'fulfilled' ? result.value : []
    // Rank the merged set instead of concatenating: a plain concat let
    // short-term handles occupy every slot and starve indexed workspace hits.
    return [...fragments(durable), ...fragments(transient), ...fragments(workspace)]
      .sort((left, right) => (right.relevance ?? 0) - (left.relevance ?? 0))
      .slice(0, limit)
  }
}
