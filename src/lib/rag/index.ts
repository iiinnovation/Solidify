/**
 * RAG Provider Factory (简化版)
 *
 * 根据配置创建对应的 RAG Provider 实例
 *
 * 架构说明：
 * - Supabase Provider: 仅用于演示，不支持文档上传和向量搜索
 * - RagFlow Provider: 生产环境推荐，由 RagFlow 处理所有 RAG 功能
 */

import { SupabaseRAGProvider } from './supabase-provider'
import { RagFlowProvider } from './ragflow-provider'
import type { RAGProvider } from './types'

export type RAGProviderType = 'supabase' | 'ragflow'

/**
 * 获取配置的 RAG Provider 类型
 */
export function getRAGProviderType(): RAGProviderType {
  const providerType = import.meta.env.VITE_RAG_PROVIDER || 'ragflow'

  if (providerType !== 'supabase' && providerType !== 'ragflow') {
    console.warn(`Unknown RAG provider type: ${providerType}, falling back to ragflow`)
    return 'ragflow'
  }

  return providerType
}

/**
 * 创建 RAG Provider 实例
 */
export function createRAGProvider(type?: RAGProviderType): RAGProvider {
  const providerType = type || getRAGProviderType()

  switch (providerType) {
    case 'supabase':
      console.warn('Supabase Provider 仅用于演示，生产环境请使用 RagFlow')
      return new SupabaseRAGProvider()
    case 'ragflow':
    default:
      return new RagFlowProvider()
  }
}

/**
 * 默认的 RAG Provider 实例（单例）
 */
let defaultProvider: RAGProvider | null = null

export function getRAGProvider(): RAGProvider {
  if (!defaultProvider) {
    defaultProvider = createRAGProvider()
  }
  return defaultProvider
}

/**
 * 重置 RAG Provider（用于切换 Provider 类型）
 */
export function resetRAGProvider() {
  defaultProvider = null
}

// 导出类型和接口
export * from './types'
export { SupabaseRAGProvider } from './supabase-provider'
export { RagFlowProvider } from './ragflow-provider'
