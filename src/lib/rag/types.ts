/**
 * RAG Provider 抽象接口
 *
 * 定义知识库系统的统一接口，支持多种 RAG 实现：
 * - Supabase (默认)
 * - RagFlow
 * - 其他自定义实现
 */

export interface KnowledgeEntry {
  id: string
  project_id: string | null
  source_type: 'conversation' | 'artifact' | 'manual'
  source_id?: string
  title: string
  content: string
  embedding?: number[]
  metadata?: Record<string, any>
  created_at: string
  updated_at: string
}

export interface SearchResult {
  id: string
  title: string
  content: string
  source_type: string
  metadata?: Record<string, any>
  similarity: number
  created_at: string
}

export interface UploadOptions {
  projectId?: string
  sourceType?: 'conversation' | 'artifact' | 'manual'
  sourceId?: string
  metadata?: Record<string, any>
}

export interface SearchOptions {
  projectId?: string
  matchThreshold?: number
  matchCount?: number
  useHybridSearch?: boolean
}

export interface KnowledgeStats {
  total_entries: number
  by_source_type: Record<string, number>
  total_size_bytes: number
  avg_content_length: number
  created_today: number
  created_this_week: number
  created_this_month: number
}

/**
 * RAG Provider 接口
 */
export interface RAGProvider {
  /**
   * 上传文档到知识库
   * @param file 文件对象
   * @param options 上传选项
   * @returns 创建的知识条目 ID 列表
   */
  uploadDocument(file: File, options?: UploadOptions): Promise<string[]>

  /**
   * 搜索知识库
   * @param query 查询文本
   * @param options 搜索选项
   * @returns 搜索结果列表
   */
  searchKnowledge(query: string, options?: SearchOptions): Promise<SearchResult[]>

  /**
   * 获取知识条目详情
   * @param id 知识条目 ID
   * @returns 知识条目
   */
  getKnowledge(id: string): Promise<KnowledgeEntry | null>

  /**
   * 列出知识条目
   * @param projectId 项目 ID（可选，null 表示全局知识）
   * @param limit 返回数量限制
   * @param offset 偏移量
   * @returns 知识条目列表
   */
  listKnowledge(projectId?: string | null, limit?: number, offset?: number): Promise<KnowledgeEntry[]>

  /**
   * 删除知识条目
   * @param id 知识条目 ID
   */
  deleteKnowledge(id: string): Promise<void>

  /**
   * 批量删除知识条目
   * @param ids 知识条目 ID 列表
   */
  deleteKnowledgeBatch(ids: string[]): Promise<void>

  /**
   * 获取知识库统计信息
   * @param projectId 项目 ID
   * @returns 统计信息
   */
  getStats(projectId?: string): Promise<KnowledgeStats>
}
