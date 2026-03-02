import { useState, useEffect, useRef } from 'react'
import { Search, X, FileText, MessageSquare, Presentation } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useHotkeys } from 'react-hotkeys-hook'
import { useSearch } from '@/hooks/use-search'
import { cn } from '@/lib/utils'
import { HOTKEYS } from '@/lib/hotkeys'
import type { SearchResult } from '@/lib/api/search'

const typeIcons = {
  message: MessageSquare,
  artifact: FileText,
  conversation: Presentation,
}

const typeLabels = {
  message: '消息',
  artifact: 'Artifact',
  conversation: '对话',
}

interface SearchModalProps {
  open: boolean
  onClose: () => void
}

export function SearchModal({ open, onClose }: SearchModalProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  const { data: results, isLoading } = useSearch(query)

  useHotkeys('escape', onClose, { enabled: open })

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus()
    }
  }, [open])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!results || results.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((prev) => (prev + 1) % results.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((prev) => (prev - 1 + results.length) % results.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      handleSelect(results[selectedIndex])
    }
  }

  const handleSelect = (result: SearchResult) => {
    navigate(`/chat/${result.conversation_id}`)
    onClose()
    setQuery('')
  }

  const highlightText = (text: string, query: string) => {
    if (!query.trim()) return text

    const parts = text.split(new RegExp(`(${query})`, 'gi'))
    return parts.map((part, i) =>
      part.toLowerCase() === query.toLowerCase() ? (
        <mark key={i} className="bg-accent-light text-accent font-medium">
          {part}
        </mark>
      ) : (
        part
      )
    )
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-lg border border-border bg-surface shadow-lg">
        {/* Search Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border-light">
          <Search size={20} strokeWidth={1.75} className="text-text-tertiary shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索对话、消息、Artifacts..."
            className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="p-1 rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-primary transition-colors"
            >
              <X size={16} strokeWidth={1.75} />
            </button>
          )}
          <kbd className="px-2 py-1 rounded bg-background-secondary border border-border text-xs font-mono text-text-tertiary">
            Esc
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[60vh] overflow-y-auto">
          {isLoading && query.trim().length >= 2 && (
            <div className="px-4 py-8 text-center text-sm text-text-tertiary">
              搜索中...
            </div>
          )}

          {!isLoading && query.trim().length >= 2 && (!results || results.length === 0) && (
            <div className="px-4 py-8 text-center text-sm text-text-tertiary">
              没有找到匹配的结果
            </div>
          )}

          {query.trim().length < 2 && (
            <div className="px-4 py-8 text-center text-sm text-text-tertiary">
              输入至少 2 个字符开始搜索
            </div>
          )}

          {results && results.length > 0 && (
            <div className="py-2">
              {results.map((result, index) => {
                const Icon = typeIcons[result.result_type]
                const isSelected = index === selectedIndex

                return (
                  <button
                    key={`${result.result_type}-${result.result_id}`}
                    onClick={() => handleSelect(result)}
                    className={cn(
                      "w-full flex items-start gap-3 px-4 py-3 text-left transition-colors",
                      isSelected ? "bg-accent-light" : "hover:bg-background-secondary"
                    )}
                  >
                    <div className={cn(
                      "w-8 h-8 rounded-md flex items-center justify-center shrink-0 mt-0.5",
                      isSelected ? "bg-accent/10 text-accent" : "bg-background-secondary text-text-tertiary"
                    )}>
                      <Icon size={16} strokeWidth={1.75} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs text-text-tertiary">
                          {typeLabels[result.result_type]}
                        </span>
                        <span className="text-xs text-text-tertiary">·</span>
                        <span className="text-xs text-text-tertiary truncate">
                          {result.title}
                        </span>
                      </div>
                      {result.content && (
                        <p className="text-sm text-text-primary line-clamp-2">
                          {highlightText(result.content, query)}
                        </p>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-border-light text-xs text-text-tertiary">
          <span>使用 ↑↓ 导航，Enter 选择</span>
          <span>{results?.length || 0} 个结果</span>
        </div>
      </div>
    </div>
  )
}

/**
 * Hook: 全局搜索
 */
export function useGlobalSearch() {
  const [open, setOpen] = useState(false)

  useHotkeys(HOTKEYS.SEARCH, () => setOpen(true), { preventDefault: true })

  return {
    open,
    openSearch: () => setOpen(true),
    closeSearch: () => setOpen(false),
  }
}
