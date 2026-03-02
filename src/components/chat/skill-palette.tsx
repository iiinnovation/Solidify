import { useEffect, useRef } from 'react'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Skill } from '@/lib/skills'
import type { Template } from '@/lib/api/types'
import { TemplateSelector } from '@/components/templates/template-selector'

// Type guard to check if a value is a valid Lucide icon component
function isLucideIcon(icon: unknown): icon is React.ComponentType<LucideIcons.LucideProps> {
  return typeof icon === 'function'
}

// Get icon component by name, fallback to Sparkles
function getIconComponent(iconName: string): React.ComponentType<LucideIcons.LucideProps> {
  const icon = (LucideIcons as Record<string, unknown>)[iconName]
  if (isLucideIcon(icon)) {
    return icon
  }
  return LucideIcons.Sparkles
}

interface SkillPaletteProps {
  skills: Skill[]
  selectedIndex: number
  onSelect: (skill: Skill) => void
  onSelectTemplate?: (template: Template) => void
  activeSkillId?: string
}

export function SkillPalette({
  skills,
  selectedIndex,
  onSelect,
  onSelectTemplate,
  activeSkillId
}: SkillPaletteProps) {
  const listRef = useRef<HTMLDivElement>(null)

  // Scroll selected item into view
  useEffect(() => {
    const container = listRef.current
    if (!container) return
    // Skip the header div (children[0]) and get the actual skill item
    const item = container.children[selectedIndex + 1] as HTMLElement | undefined
    if (item) {
      item.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  if (skills.length === 0) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-1.5 rounded-lg border border-border bg-surface shadow-md z-50 p-3">
        <p className="text-xs text-text-tertiary text-center">无匹配的技能</p>
      </div>
    )
  }

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1.5 rounded-lg border border-border bg-surface shadow-md z-50 py-1 max-h-[420px] overflow-y-auto"
    >
      <div className="px-3 py-1.5">
        <p className="text-xs text-text-tertiary font-medium">技能</p>
      </div>
      {skills.map((skill, index) => {
        const Icon = getIconComponent(skill.icon)
        return (
          <button
            key={skill.id}
            onClick={() => onSelect(skill)}
            className={cn(
              'w-full flex items-center gap-3 px-3 py-2 text-left transition-colors',
              index === selectedIndex
                ? 'bg-accent-light'
                : 'hover:bg-background-secondary'
            )}
          >
            <div className={cn(
              'w-7 h-7 rounded-md flex items-center justify-center shrink-0',
              index === selectedIndex
                ? 'bg-accent/10 text-accent'
                : 'bg-background-secondary text-text-tertiary'
            )}>
              <Icon size={15} strokeWidth={1.75} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text-primary">{skill.name}</p>
              <p className="text-xs text-text-tertiary truncate">{skill.description}</p>
              {skill.recommendedModels && skill.recommendedModels.length > 0 && (
                <p className="text-xs text-accent mt-0.5">
                  推荐: {skill.recommendedModels.join(', ')}
                </p>
              )}
            </div>
          </button>
        )
      })}

      {/* 模板选择器 */}
      {activeSkillId && onSelectTemplate && (
        <TemplateSelector
          skillId={activeSkillId}
          onSelect={onSelectTemplate}
        />
      )}
    </div>
  )
}
