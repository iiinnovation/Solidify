/**
 * 知识库统计组件
 * 显示知识库的统计信息
 */

import { FileText, Database, TrendingUp, Calendar } from 'lucide-react'
import type { KnowledgeStats } from '@/lib/rag'

interface KnowledgeStatsProps {
  stats: KnowledgeStats
  isLoading?: boolean
}

export function KnowledgeStatsCard({ stats, isLoading }: KnowledgeStatsProps) {
  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const formatNumber = (num: number) => {
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`
    return num.toString()
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="rounded-lg border border-border bg-surface p-6 animate-pulse">
            <div className="h-10 w-10 rounded-md bg-background-secondary mb-4" />
            <div className="h-4 w-20 bg-background-secondary rounded mb-2" />
            <div className="h-8 w-16 bg-background-secondary rounded" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {/* 总条目数 */}
      <div className="rounded-lg border border-border bg-surface p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="w-10 h-10 rounded-md bg-accent-light flex items-center justify-center">
            <FileText size={20} strokeWidth={1.75} className="text-accent" />
          </div>
        </div>
        <p className="text-sm text-text-tertiary mb-1">总知识条目</p>
        <p className="text-2xl font-semibold text-text-primary">
          {formatNumber(stats.total_entries)}
        </p>
      </div>

      {/* 总大小 */}
      <div className="rounded-lg border border-border bg-surface p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="w-10 h-10 rounded-md bg-info-light flex items-center justify-center">
            <Database size={20} strokeWidth={1.75} className="text-info" />
          </div>
        </div>
        <p className="text-sm text-text-tertiary mb-1">存储空间</p>
        <p className="text-2xl font-semibold text-text-primary">
          {formatSize(stats.total_size_bytes)}
        </p>
      </div>

      {/* 平均长度 */}
      <div className="rounded-lg border border-border bg-surface p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="w-10 h-10 rounded-md bg-success-light flex items-center justify-center">
            <TrendingUp size={20} strokeWidth={1.75} className="text-success" />
          </div>
        </div>
        <p className="text-sm text-text-tertiary mb-1">平均长度</p>
        <p className="text-2xl font-semibold text-text-primary">
          {Math.round(stats.avg_content_length)}
          <span className="text-base text-text-secondary ml-1">字</span>
        </p>
      </div>

      {/* 本周新增 */}
      <div className="rounded-lg border border-border bg-surface p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="w-10 h-10 rounded-md bg-warning-light flex items-center justify-center">
            <Calendar size={20} strokeWidth={1.75} className="text-warning" />
          </div>
        </div>
        <p className="text-sm text-text-tertiary mb-1">本周新增</p>
        <p className="text-2xl font-semibold text-text-primary">
          {stats.created_this_week}
        </p>
      </div>
    </div>
  )
}
