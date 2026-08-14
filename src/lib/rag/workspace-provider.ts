import { getWorkspaceIndexStats, readWorkspaceFile, readWorkspaceTree, searchWorkspaceIndex } from '@/lib/tauri'
import type { KnowledgeEntry, KnowledgeStats, RAGProvider, SearchOptions, SearchResult, UploadOptions } from './types'

export class WorkspaceRAGProvider implements RAGProvider {
  private readonly root: string

  constructor(root: string) { this.root = root }

  async uploadDocument(_file: File, _options?: UploadOptions): Promise<string[]> {
    throw new Error('工作区文档由文件系统索引器管理，请先把文件放入项目目录。')
  }

  async searchKnowledge(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const matches = await searchWorkspaceIndex(this.root, query, options?.matchCount ?? 10)
    return matches.map((match) => ({
      id: match.path,
      title: match.path.split('/').pop() ?? match.path,
      content: match.text,
      source_type: 'workspace',
      metadata: { path: match.path },
      similarity: 1 / (1 + Math.max(0, match.score)),
      created_at: new Date().toISOString(),
    }))
  }

  async getKnowledge(id: string): Promise<KnowledgeEntry | null> {
    try {
      const result = await readWorkspaceFile(id, this.root)
      if (result.binary || result.content === null) return null
      return {
        id,
        project_id: null,
        source_type: 'manual',
        title: id.split('/').pop() ?? id,
        content: result.content,
        metadata: { path: id, source: 'workspace' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
    } catch {
      return null
    }
  }

  async listKnowledge(_projectId?: string | null, limit = 100, offset = 0): Promise<KnowledgeEntry[]> {
    const entries = (await readWorkspaceTree(this.root)).filter((entry) => entry.kind === 'file').slice(offset, offset + limit)
    const records = await Promise.all(entries.map((entry) => this.getKnowledge(entry.path)))
    return records.filter((record): record is KnowledgeEntry => record !== null)
  }

  async deleteKnowledge(_id: string): Promise<void> {
    throw new Error('请通过工作区文件操作删除本地知识源。')
  }

  async deleteKnowledgeBatch(_ids: string[]): Promise<void> {
    throw new Error('请通过工作区文件操作删除本地知识源。')
  }

  async getStats(_projectId?: string): Promise<KnowledgeStats> {
    const stats = await getWorkspaceIndexStats(this.root)
    return {
      total_entries: stats.indexedDocuments,
      by_source_type: { workspace: stats.indexedDocuments },
      total_size_bytes: 0,
      avg_content_length: 0,
      created_today: 0,
      created_this_week: 0,
      created_this_month: 0,
    }
  }
}
