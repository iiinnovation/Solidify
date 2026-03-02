/**
 * 模板列表组件
 */

import { useState } from 'react'
import { Edit, Trash2, Copy, FileText } from 'lucide-react'
import type { Template } from '@/lib/api/types'
import { Button } from '@/components/ui/button'
import { formatDistanceToNow } from 'date-fns'
import { zhCN } from 'date-fns/locale'

interface TemplateListProps {
  templates: Template[]
  onEdit: (template: Template) => void
  onDelete: (id: string) => void
  onDuplicate: (id: string) => void
  onUse: (template: Template) => void
}

export function TemplateList({
  templates,
  onEdit,
  onDelete,
  onDuplicate,
  onUse,
}: TemplateListProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  if (templates.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <FileText className="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>暂无模板</p>
        <p className="text-sm mt-1">创建你的第一个模板</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {templates.map((template) => (
        <div
          key={template.id}
          className={`border rounded-lg p-4 hover:border-primary/50 transition-colors cursor-pointer ${
            selectedId === template.id ? 'border-primary bg-primary/5' : ''
          }`}
          onClick={() => setSelectedId(template.id)}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="font-medium truncate">{template.name}</h3>
                {template.is_public && (
                  <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded">
                    公开
                  </span>
                )}
              </div>
              {template.description && (
                <p className="text-sm text-muted-foreground line-clamp-2 mb-2">
                  {template.description}
                </p>
              )}
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span>
                  {formatDistanceToNow(new Date(template.created_at), {
                    addSuffix: true,
                    locale: zhCN,
                  })}
                </span>
                <span>使用 {template.usage_count} 次</span>
                {template.variables.length > 0 && (
                  <span>{template.variables.length} 个变量</span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation()
                  onUse(template)
                }}
              >
                使用
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation()
                  onEdit(template)
                }}
              >
                <Edit className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation()
                  onDuplicate(template.id)
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm('确定要删除这个模板吗？')) {
                    onDelete(template.id)
                  }
                }}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
