/**
 * Supabase RAG Provider (简化版)
 *
 * 注意：此 Provider 仅用于演示和开发环境
 * 生产环境建议使用 RagFlow 等专业知识库系统
 */

import { supabase } from '@/lib/supabase'
import type {
  RAGProvider,
  KnowledgeEntry,
  SearchResult,
  UploadOptions,
  SearchOptions,
  KnowledgeStats,
} from './types'

export class SupabaseRAGProvider implements RAGProvider {
  async uploadDocument(_file: File, _options?: UploadOptions): Promise<string[]> {
    throw new Error(
      'Supabase Provider 不支持文档上传。请使用 RagFlow Provider 或直接在 RagFlow 中上传文档。'
    )
  }

  async searchKnowledge(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    if (!supabase) {
      console.warn('Supabase not configured')
      return []
    }

    // 简单的全文搜索（不使用向量）
    const { data, error } = await supabase
      .from('knowledge_entries')
      .select('*')
      .or(`title.ilike.%${query}%,content.ilike.%${query}%`)
      .limit(options?.matchCount || 5)

    if (error) {
      throw new Error(`Failed to search knowledge: ${error.message}`)
    }

    return (data || []).map(entry => ({
      id: entry.id,
      title: entry.title,
      content: entry.content,
      source_type: entry.source_type,
      metadata: entry.metadata,
      similarity: 0.8, // 模拟相似度
      created_at: entry.created_at,
    }))
  }

  async getKnowledge(id: string): Promise<KnowledgeEntry | null> {
    if (!supabase) {
      console.warn('Supabase not configured')
      return null
    }

    const { data, error } = await supabase
      .from('knowledge_entries')
      .select('*')
      .eq('id', id)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return null
      }
      throw new Error(`Failed to get knowledge: ${error.message}`)
    }

    return data
  }

  async listKnowledge(
    projectId?: string | null,
    limit: number = 50,
    offset: number = 0
  ): Promise<KnowledgeEntry[]> {
    if (!supabase) {
      console.warn('Supabase not configured')
      return []
    }

    let query = supabase
      .from('knowledge_entries')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (projectId !== undefined) {
      if (projectId === null) {
        query = query.is('project_id', null)
      } else {
        query = query.eq('project_id', projectId)
      }
    }

    const { data, error } = await query

    if (error) {
      throw new Error(`Failed to list knowledge: ${error.message}`)
    }

    return data || []
  }

  async deleteKnowledge(id: string): Promise<void> {
    if (!supabase) {
      throw new Error('Supabase not configured')
    }

    const { error } = await supabase
      .from('knowledge_entries')
      .delete()
      .eq('id', id)

    if (error) {
      throw new Error(`Failed to delete knowledge: ${error.message}`)
    }
  }

  async deleteKnowledgeBatch(ids: string[]): Promise<void> {
    if (!supabase) {
      throw new Error('Supabase not configured')
    }

    const { error } = await supabase
      .from('knowledge_entries')
      .delete()
      .in('id', ids)

    if (error) {
      throw new Error(`Failed to delete knowledge batch: ${error.message}`)
    }
  }

  async getStats(projectId?: string): Promise<KnowledgeStats> {
    if (!supabase) {
      console.warn('Supabase not configured')
      return {
        total_entries: 0,
        by_source_type: {},
        total_size_bytes: 0,
        avg_content_length: 0,
        created_today: 0,
        created_this_week: 0,
        created_this_month: 0,
      }
    }

    // 简单的统计查询
    let query = supabase
      .from('knowledge_entries')
      .select('*', { count: 'exact', head: false })

    if (projectId) {
      query = query.eq('project_id', projectId)
    }

    const { data, count, error } = await query

    if (error) {
      throw new Error(`Failed to get knowledge stats: ${error.message}`)
    }

    const entries = data || []
    const totalSize = entries.reduce((sum, e) => sum + (e.content?.length || 0), 0)
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
    const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)

    return {
      total_entries: count || 0,
      by_source_type: entries.reduce((acc, e) => {
        acc[e.source_type] = (acc[e.source_type] || 0) + 1
        return acc
      }, {} as Record<string, number>),
      total_size_bytes: totalSize,
      avg_content_length: entries.length > 0 ? totalSize / entries.length : 0,
      created_today: entries.filter(e => new Date(e.created_at) >= today).length,
      created_this_week: entries.filter(e => new Date(e.created_at) >= weekAgo).length,
      created_this_month: entries.filter(e => new Date(e.created_at) >= monthAgo).length,
    }
  }
}
