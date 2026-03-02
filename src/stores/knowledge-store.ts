/**
 * 知识库增强 Store
 * 管理知识库增强的开关状态和相关配置
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface KnowledgeEnhancementState {
  // 是否启用知识库增强
  enabled: boolean

  // 搜索配置
  matchCount: number  // 返回的知识条目数量
  matchThreshold: number  // 相似度阈值

  // 最近引用的知识
  recentSources: Array<{
    id: string
    title: string
    content: string
    similarity: number
    timestamp: number
  }>

  // 操作
  setEnabled: (enabled: boolean) => void
  setMatchCount: (count: number) => void
  setMatchThreshold: (threshold: number) => void
  addRecentSource: (source: {
    id: string
    title: string
    content: string
    similarity: number
  }) => void
  clearRecentSources: () => void
}

export const useKnowledgeEnhancementStore = create<KnowledgeEnhancementState>()(
  persist(
    (set) => ({
      enabled: true,  // 默认启用
      matchCount: 3,
      matchThreshold: 0.7,
      recentSources: [],

      setEnabled: (enabled) => set({ enabled }),

      setMatchCount: (count) => set({ matchCount: count }),

      setMatchThreshold: (threshold) => set({ matchThreshold: threshold }),

      addRecentSource: (source) =>
        set((state) => ({
          recentSources: [
            { ...source, timestamp: Date.now() },
            ...state.recentSources.slice(0, 9), // 保留最近 10 条
          ],
        })),

      clearRecentSources: () => set({ recentSources: [] }),
    }),
    {
      name: 'solidify-knowledge-enhancement',
    }
  )
)
