/**
 * 知识库页面
 * 管理项目知识库
 */

import { useState } from 'react'
import { BookOpen, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { KnowledgeUpload } from '@/components/knowledge/knowledge-upload'
import { KnowledgeList } from '@/components/knowledge/knowledge-list'
import { KnowledgeStatsCard } from '@/components/knowledge/knowledge-stats'
import { useProjectStore } from '@/stores/project-store'
import { supabaseConfigured } from '@/lib/supabase'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getRAGProvider } from '@/lib/rag'

export function KnowledgePage() {
  const { activeProjectId } = useProjectStore()
  const [showUpload, setShowUpload] = useState(false)
  const queryClient = useQueryClient()

  // 获取知识列表
  const { data: entries = [], isLoading: isLoadingEntries } = useQuery({
    queryKey: ['knowledge', activeProjectId],
    queryFn: async () => {
      const provider = getRAGProvider()
      return provider.listKnowledge(activeProjectId || undefined)
    },
    enabled: supabaseConfigured,
  })

  // 获取统计信息
  const { data: stats, isLoading: isLoadingStats } = useQuery({
    queryKey: ['knowledge-stats', activeProjectId],
    queryFn: async () => {
      const provider = getRAGProvider()
      return provider.getStats(activeProjectId || undefined)
    },
    enabled: supabaseConfigured,
  })

  // 删除知识条目
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const provider = getRAGProvider()
      await provider.deleteKnowledge(id)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge', activeProjectId] })
      queryClient.invalidateQueries({ queryKey: ['knowledge-stats', activeProjectId] })
    },
  })

  // 批量删除
  const deleteBatchMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const provider = getRAGProvider()
      await provider.deleteKnowledgeBatch(ids)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge', activeProjectId] })
      queryClient.invalidateQueries({ queryKey: ['knowledge-stats', activeProjectId] })
    },
  })

  const handleUploadComplete = () => {
    setShowUpload(false)
    queryClient.invalidateQueries({ queryKey: ['knowledge', activeProjectId] })
    queryClient.invalidateQueries({ queryKey: ['knowledge-stats', activeProjectId] })
  }

  if (!supabaseConfigured) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="text-center space-y-3 max-w-md">
          <div className="w-16 h-16 rounded-2xl bg-warning-light border border-warning/10 flex items-center justify-center mx-auto">
            <BookOpen size={24} strokeWidth={1.75} className="text-warning" />
          </div>
          <p className="text-base font-medium text-text-primary">未配置 Supabase</p>
          <p className="text-sm text-text-tertiary leading-relaxed">
            知识库功能需要配置 Supabase 后端。请在 .env 文件中配置 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">知识库</h1>
            <p className="text-sm text-text-tertiary mt-1">
              上传文档构建知识库，AI 会自动引用相关知识回答问题
            </p>
          </div>
          <Button onClick={() => setShowUpload(!showUpload)}>
            <Plus size={18} strokeWidth={1.75} className="mr-2" />
            上传文档
          </Button>
        </div>

        {/* 统计卡片 */}
        {stats && <KnowledgeStatsCard stats={stats} isLoading={isLoadingStats} />}

        {/* 上传区域 */}
        {showUpload && (
          <div className="rounded-lg border border-border bg-surface p-6">
            <h2 className="text-base font-semibold text-text-primary mb-4">上传文档</h2>
            <KnowledgeUpload
              projectId={activeProjectId || undefined}
              onUploadComplete={handleUploadComplete}
              onUploadError={(error) => {
                console.error('Upload error:', error)
                alert(`上传失败: ${error.message}`)
              }}
            />
          </div>
        )}

        {/* 知识列表 */}
        <div className="rounded-lg border border-border bg-surface p-6">
          <h2 className="text-base font-semibold text-text-primary mb-4">知识条目</h2>
          <KnowledgeList
            entries={entries}
            isLoading={isLoadingEntries}
            onDelete={(id) => deleteMutation.mutate(id)}
            onDeleteBatch={(ids) => deleteBatchMutation.mutate(ids)}
          />
        </div>
      </div>
    </div>
  )
}
