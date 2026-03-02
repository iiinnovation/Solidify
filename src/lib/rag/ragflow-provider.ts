/**
 * RagFlow RAG Provider
 *
 * 使用公司 RagFlow 知识库系统
 * RagFlow 负责文档切片、向量化、存储和检索
 */

import type {
  RAGProvider,
  KnowledgeEntry,
  SearchResult,
  UploadOptions,
  SearchOptions,
  KnowledgeStats,
} from './types'

/**
 * RagFlow API 客户端
 */
class RagFlowClient {
  private baseUrl: string
  private apiKey: string

  constructor() {
    this.baseUrl = import.meta.env.VITE_RAGFLOW_API_URL || 'http://localhost:9380'
    this.apiKey = import.meta.env.VITE_RAGFLOW_API_KEY || ''

    if (!this.apiKey) {
      console.warn('RagFlow API Key not configured')
    }
  }

  private async request(endpoint: string, options: RequestInit = {}) {
    const url = `${this.baseUrl}${endpoint}`
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      ...options.headers,
    }

    const response = await fetch(url, {
      ...options,
      headers,
    })

    if (!response.ok) {
      throw new Error(`RagFlow API error: ${response.statusText}`)
    }

    return response.json()
  }

  /**
   * 上传文档到 RagFlow
   * RagFlow 会自动处理文档切片和向量化
   */
  async uploadDocument(file: File, datasetId: string) {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('dataset_id', datasetId)

    const response = await fetch(`${this.baseUrl}/api/document/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: formData,
    })

    if (!response.ok) {
      throw new Error(`Failed to upload document: ${response.statusText}`)
    }

    return response.json()
  }

  /**
   * 搜索知识库
   * RagFlow 使用已经切片和向量化的数据进行检索
   */
  async search(query: string, datasetId: string, topK: number = 5) {
    return this.request('/api/retrieval/search', {
      method: 'POST',
      body: JSON.stringify({
        query,
        dataset_id: datasetId,
        top_k: topK,
      }),
    })
  }

  async listDocuments(datasetId: string) {
    return this.request(`/api/document/list?dataset_id=${datasetId}`)
  }

  async deleteDocument(documentId: string) {
    return this.request(`/api/document/delete`, {
      method: 'POST',
      body: JSON.stringify({
        document_id: documentId,
      }),
    })
  }

  async getDatasets() {
    return this.request('/api/dataset/list')
  }

  async createDataset(name: string, description?: string) {
    return this.request('/api/dataset/create', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description,
      }),
    })
  }
}

export class RagFlowProvider implements RAGProvider {
  private client: RagFlowClient

  constructor() {
    this.client = new RagFlowClient()
  }

  /**
   * 获取或创建项目对应的 RagFlow Dataset
   */
  private async getOrCreateDataset(projectId?: string): Promise<string> {
    const datasetName = projectId ? `solidify-project-${projectId}` : 'solidify-default'

    try {
      // 尝试获取已有的 dataset
      const datasets = await this.client.getDatasets()
      const existing = datasets.datasets?.find((d: any) => d.name === datasetName)

      if (existing) {
        return existing.id
      }

      // 创建新的 dataset
      const result = await this.client.createDataset(
        datasetName,
        `Solidify project ${projectId || 'default'} knowledge base`
      )

      return result.dataset_id
    } catch (error) {
      console.error('Failed to get or create dataset:', error)
      // 降级：使用默认 dataset ID
      return 'default'
    }
  }

  /**
   * 上传文档到 RagFlow
   * RagFlow 会自动处理切片、向量化和存储
   */
  async uploadDocument(file: File, options?: UploadOptions): Promise<string[]> {
    const datasetId = await this.getOrCreateDataset(options?.projectId)

    const result = await this.client.uploadDocument(file, datasetId)

    // RagFlow 返回的文档 ID
    return [result.document_id]
  }

  /**
   * 搜索知识库
   * 使用 RagFlow 已经切片和向量化的数据
   */
  async searchKnowledge(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const datasetId = await this.getOrCreateDataset(options?.projectId)

    const result = await this.client.search(
      query,
      datasetId,
      options?.matchCount || 5
    )

    // 转换 RagFlow 结果为统一格式
    return (result.chunks || []).map((chunk: any) => ({
      id: chunk.chunk_id,
      title: chunk.document_name,
      content: chunk.content,
      source_type: 'manual',
      metadata: {
        document_id: chunk.document_id,
        score: chunk.score,
        chunk_index: chunk.chunk_index,
      },
      similarity: chunk.score,
      created_at: chunk.created_at || new Date().toISOString(),
    }))
  }

  async getKnowledge(_id: string): Promise<KnowledgeEntry | null> {
    // RagFlow 不支持直接通过 chunk_id 获取
    console.warn('RagFlow does not support getting knowledge by chunk ID')
    return null
  }

  async listKnowledge(
    projectId?: string | null,
    limit: number = 50,
    offset: number = 0
  ): Promise<KnowledgeEntry[]> {
    const datasetId = await this.getOrCreateDataset(projectId || undefined)

    const result = await this.client.listDocuments(datasetId)

    // 转换 RagFlow 文档列表为统一格式
    return (result.documents || []).slice(offset, offset + limit).map((doc: any) => ({
      id: doc.document_id,
      project_id: projectId,
      source_type: 'manual' as const,
      title: doc.name,
      content: doc.content || '',
      metadata: {
        size: doc.size,
        status: doc.status,
        chunk_count: doc.chunk_count,
      },
      created_at: doc.created_at,
      updated_at: doc.updated_at,
    }))
  }

  async deleteKnowledge(id: string): Promise<void> {
    await this.client.deleteDocument(id)
  }

  async deleteKnowledgeBatch(ids: string[]): Promise<void> {
    // RagFlow 不支持批量删除，逐个删除
    await Promise.all(ids.map(id => this.deleteKnowledge(id)))
  }

  async getStats(projectId?: string): Promise<KnowledgeStats> {
    const datasetId = await this.getOrCreateDataset(projectId)

    const result = await this.client.listDocuments(datasetId)

    // 计算统计信息
    const documents = result.documents || []
    const totalSize = documents.reduce((sum: number, doc: any) => sum + (doc.size || 0), 0)
    const totalChunks = documents.reduce((sum: number, doc: any) => sum + (doc.chunk_count || 0), 0)

    return {
      total_entries: totalChunks, // 使用 chunk 数量作为条目数
      by_source_type: {
        manual: documents.length,
      },
      total_size_bytes: totalSize,
      avg_content_length: documents.length > 0 ? totalSize / documents.length : 0,
      created_today: 0, // RagFlow 不提供时间统计
      created_this_week: 0,
      created_this_month: 0,
    }
  }
}
