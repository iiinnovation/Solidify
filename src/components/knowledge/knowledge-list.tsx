/**
 * 知识库列表组件
 * 展示已上传的知识条目
 */

import { useState } from 'react'
import { FileText, Trash2, Search, Filter, Calendar } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { KnowledgeEntry } from '@/lib/rag'

interface KnowledgeListProps {
  entries: KnowledgeEntry[]
  isLoading?: boolean
  onDelete?: (id: string) => void
  onDeleteBatch?: (ids: string[]) => void
}

export function KnowledgeList({ entries, isLoading, onDelete, onDeleteBatch }: KnowledgeListProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [filterType, setFilterType] = useState<string>('all')

  // 过滤和搜索
  const filteredEntries = entries.filter(entry => {
    const matchesSearch =
      entry.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      entry.content.toLowerCase().includes(searchQuery.toLowerCase())

    const matchesFilter =
      filterType === 'all' || entry.source_type === filterType

    return matchesSearch && matchesFilter
  })

  const handleSelectAll = () => {
    if (selectedIds.size === filteredEntries.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredEntries.map(e => e.id)))
    }
  }

  const handleSelectOne = (id: string) => {
    const newSelected = new Set(selectedIds)
    if (newSelected.has(id)) {
      newSelected.delete(id)
    } else {
      newSelected.add(id)
    }
    setSelectedIds(newSelected)
  }

  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) return

    if (confirm(`确定要删除选中的 ${selectedIds.size} 个知识条目吗？`)) {
      onDeleteBatch?.(Array.from(selectedIds))
      setSelectedIds(new Set())
    }
  }

  const handleDeleteOne = (id: string) => {
    if (confirm('确定要删除这个知识条目吗？')) {
      onDelete?.(id)
      selectedIds.delete(id)
      setSelectedIds(new Set(selectedIds))
    }
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffDays === 0) return '今天'
    if (diffDays === 1) return '昨天'
    if (diffDays < 7) return `${diffDays} 天前`
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} 周前`
    if (diffDays < 365) return `${Math.floor(diffDays / 30)} 月前`
    return date.toLocaleDateString('zh-CN')
  }

  const getSourceTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      manual: '手动上传',
      conversation: '对话生成',
      artifact: 'Artifact',
    }
    return labels[type] || type
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-sm text-text-tertiary">加载中...</div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* 搜索和过滤 */}
      <div className="flex items-center gap-3">
        <div className="flex-1 relative">
          <Search size={18} strokeWidth={1.75} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input
            type="text"
            placeholder="搜索知识库..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-md border border-border bg-surface text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter size={18} strokeWidth={1.75} className="text-text-tertiary" />
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="px-3 py-2 rounded-md border border-border bg-surface text-sm text-text-primary focus:outline-none focus:border-border-focus"
          >
            <option value="all">全部类型</option>
            <option value="manual">手动上传</option>
            <option value="conversation">对话生成</option>
            <option value="artifact">Artifact</option>
          </select>
        </div>
      </div>

      {/* 批量操作 */}
      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between p-3 rounded-lg bg-accent-light border border-accent/20">
          <span className="text-sm text-text-primary">
            已选择 {selectedIds.size} 个知识条目
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDeleteSelected}
            className="text-error hover:text-error hover:bg-error-light"
          >
            <Trash2 size={16} strokeWidth={1.75} className="mr-2" />
            删除选中
          </Button>
        </div>
      )}

      {/* 列表 */}
      {filteredEntries.length === 0 ? (
        <div className="text-center py-12">
          <FileText size={48} strokeWidth={1.5} className="mx-auto mb-4 text-text-tertiary" />
          <p className="text-base font-medium text-text-primary mb-2">
            {searchQuery || filterType !== 'all' ? '没有找到匹配的知识' : '还没有知识条目'}
          </p>
          <p className="text-sm text-text-tertiary">
            {searchQuery || filterType !== 'all' ? '尝试调整搜索条件' : '上传文档开始构建知识库'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {/* 全选 */}
          <div className="flex items-center gap-2 px-3 py-2 text-sm text-text-tertiary">
            <input
              type="checkbox"
              checked={selectedIds.size === filteredEntries.length}
              onChange={handleSelectAll}
              className="rounded border-border"
            />
            <span>全选 ({filteredEntries.length})</span>
          </div>

          {/* 条目列表 */}
          {filteredEntries.map((entry) => (
            <div
              key={entry.id}
              className={cn(
                'flex items-start gap-3 p-4 rounded-lg border transition-colors',
                selectedIds.has(entry.id)
                  ? 'border-accent bg-accent-light'
                  : 'border-border bg-surface hover:bg-surface-hover'
              )}
            >
              <input
                type="checkbox"
                checked={selectedIds.has(entry.id)}
                onChange={() => handleSelectOne(entry.id)}
                className="mt-1 rounded border-border"
              />
              <FileText size={20} strokeWidth={1.75} className="text-text-tertiary shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-medium text-text-primary mb-1 truncate">
                  {entry.title}
                </h3>
                <p className="text-sm text-text-secondary line-clamp-2 mb-2">
                  {entry.content}
                </p>
                <div className="flex items-center gap-3 text-xs text-text-tertiary">
                  <span className="inline-flex items-center gap-1">
                    <Calendar size={12} strokeWidth={1.75} />
                    {formatDate(entry.created_at)}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-background-secondary text-text-tertiary">
                    {getSourceTypeLabel(entry.source_type)}
                  </span>
                  {entry.metadata?.filename && (
                    <span className="truncate">
                      来源: {entry.metadata.filename}
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleDeleteOne(entry.id)}
                className="p-2 rounded hover:bg-surface-hover text-text-tertiary hover:text-error transition-colors shrink-0"
                title="删除"
              >
                <Trash2 size={16} strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
