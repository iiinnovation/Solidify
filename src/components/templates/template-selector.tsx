/**
 * 模板选择器组件
 * 在技能面板中显示可用模板
 */

import { useState } from 'react'
import { FileText, ChevronRight } from 'lucide-react'
import type { Template } from '@/lib/api/types'
import { useTemplates } from '@/hooks/use-templates'
import { cn } from '@/lib/utils'

interface TemplateSelectorProps {
  skillId?: string
  onSelect: (template: Template) => void
  className?: string
}

export function TemplateSelector({
  skillId,
  onSelect,
  className,
}: TemplateSelectorProps) {
  const [expanded, setExpanded] = useState(false)
  const { data: templates = [], isLoading } = useTemplates({
    skill_id: skillId,
    include_public: true,
  })

  if (isLoading) {
    return (
      <div className={cn('text-xs text-muted-foreground px-3 py-2', className)}>
        加载模板...
      </div>
    )
  }

  if (templates.length === 0) {
    return null
  }

  return (
    <div className={cn('border-t border-border', className)}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-muted-foreground hover:bg-background-secondary transition-colors"
      >
        <span className="font-medium">可用模板 ({templates.length})</span>
        <ChevronRight
          size={14}
          className={cn(
            'transition-transform',
            expanded && 'rotate-90'
          )}
        />
      </button>

      {expanded && (
        <div className="max-h-[200px] overflow-y-auto">
          {templates.map((template) => (
            <button
              key={template.id}
              onClick={() => onSelect(template)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-background-secondary transition-colors"
            >
              <FileText size={14} className="text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-text-primary truncate">
                  {template.name}
                </p>
                {template.description && (
                  <p className="text-xs text-muted-foreground truncate">
                    {template.description}
                  </p>
                )}
              </div>
              {template.is_public && (
                <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded shrink-0">
                  公开
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
