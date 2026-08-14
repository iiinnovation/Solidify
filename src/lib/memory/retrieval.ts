import type { MemoryFragment, MemoryState } from './types'
import { MemdirMemory } from './memdir'
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
  private readonly root: string

  constructor(root: string) {
    this.root = root
    this.memdir = new MemdirMemory(root)
  }

  store(data: string): Promise<string> { return this.memdir.store(data) }
  retrieve(handle: string): Promise<string | null> { return this.memdir.retrieve(handle) }
  clear(): Promise<void> { return this.memdir.clear() }

  async search(query: string, limit = 10): Promise<MemoryFragment[]> {
    const [shortTerm, workspace] = await Promise.all([
      this.memdir.search(query, limit),
      retrieveWorkspaceMemory(this.root, query, limit),
    ])
    return [...shortTerm, ...workspace].slice(0, limit)
  }
}
