import { useState, useRef, useEffect } from 'react'
import { Plus, MessageSquare, Trash2, Pencil, Search, X, Check } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { useHotkeys } from 'react-hotkeys-hook'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/stores/chat-store'
import { useProjectStore } from '@/stores/project-store'
import { useConversations } from '@/hooks/use-conversations'
import { ProjectSelector } from '@/components/layout/project-selector'
import { toast } from '@/stores/toast-store'
import { supabaseConfigured } from '@/lib/supabase'
import { HOTKEYS } from '@/lib/hotkeys'

function ConversationItem({
  conv,
  isActive,
  onNavigate,
  onDelete,
  onRename
}: {
  conv: { id: string; title: string }
  isActive: boolean
  onNavigate: () => void
  onDelete: () => void
  onRename: (title: string) => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(conv.title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleSave = () => {
    const trimmed = editTitle.trim()
    if (trimmed && trimmed !== conv.title) {
      onRename(trimmed)
      toast.success('已重命名')
    }
    setIsEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSave()
    } else if (e.key === 'Escape') {
      setEditTitle(conv.title)
      setIsEditing(false)
    }
  }

  if (isEditing) {
    return (
      <div className="flex items-center gap-1 px-2 py-1">
        <input
          ref={inputRef}
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSave}
          className="flex-1 px-2 py-1 text-sm bg-surface border border-border-focus rounded-md outline-none"
        />
        <button
          onClick={handleSave}
          className="p-1 rounded hover:bg-surface-hover text-text-tertiary hover:text-success transition-colors"
        >
          <Check size={14} strokeWidth={2} />
        </button>
      </div>
    )
  }

  return (
    <div className="group relative">
      <button
        onClick={onNavigate}
        onDoubleClick={() => setIsEditing(true)}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2 pr-16 rounded-md text-sm text-text-secondary transition-all",
          "hover:bg-surface-hover hover:text-text-primary",
          isActive && "bg-accent-subtle text-text-primary font-medium"
        )}
      >
        <MessageSquare size={16} strokeWidth={1.75} className="shrink-0" />
        <span className="truncate min-w-0">{conv.title}</span>
      </button>
      <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto flex items-center gap-0.5 transition-opacity z-10 group-hover:bg-surface-hover rounded-md px-1 py-0.5">
        <button
          onClick={(e) => {
            e.stopPropagation()
            setIsEditing(true)
          }}
          className="p-1 rounded hover:bg-surface-hover text-text-tertiary hover:text-text-primary transition-colors"
          title="重命名"
        >
          <Pencil size={13} strokeWidth={1.75} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="p-1 rounded hover:bg-error-light text-text-tertiary hover:text-error transition-colors"
          title="删除"
        >
          <Trash2 size={13} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  )
}

export function Sidebar() {
  const navigate = useNavigate()
  const { conversationId } = useParams<{ conversationId: string }>()
  const { activeProjectId } = useProjectStore()

  // 如果配置了 Supabase，从云端加载对话；否则使用本地 store
  const { data: cloudConversations } = useConversations(supabaseConfigured ? activeProjectId ?? undefined : undefined)
  const localConversations = useChatStore((s) => s.conversations)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const renameConversation = useChatStore((s) => s.renameConversation)
  const [searchQuery, setSearchQuery] = useState('')

  // 优先使用云端数据，否则使用本地数据
  const conversations = supabaseConfigured && cloudConversations ? cloudConversations : localConversations

  const filteredConversations = searchQuery.trim()
    ? conversations.filter((c) =>
        c.title.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : conversations

  // 快捷键：新建对话
  useHotkeys(HOTKEYS.NEW_CHAT, () => navigate('/chat'), { preventDefault: true })

  return (
    <div className="h-full flex flex-col bg-background-secondary">
      {/* 项目选择器 */}
      {supabaseConfigured && <ProjectSelector />}

      <Separator />

      <div className="p-3 space-y-2">
        <Button
          variant="secondary"
          className="w-full justify-start gap-2"
          onClick={() => navigate('/chat')}
          title={`新建对话 (${HOTKEYS.NEW_CHAT.replace('mod', navigator.platform.toUpperCase().indexOf('MAC') >= 0 ? '⌘' : 'Ctrl')})`}
        >
          <Plus size={16} strokeWidth={1.75} />
          新建对话
        </Button>

        {/* 搜索框 */}
        <div className="relative">
          <Search size={14} strokeWidth={1.75} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索对话..."
            className="w-full pl-8 pr-8 py-1.5 text-sm bg-surface border border-border rounded-md outline-none focus:border-border-focus placeholder:text-text-tertiary"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-surface-hover text-text-tertiary"
            >
              <X size={12} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>

      <Separator />

      <div className="flex-1 overflow-y-auto">
        <div className="p-3 space-y-0.5">
          {conversations.length === 0 && (
            <div className="px-3 py-8 text-center">
              <p className="text-sm text-text-tertiary">还没有对话</p>
              <p className="text-xs text-text-tertiary mt-1">点击上方按钮开始</p>
            </div>
          )}

          {conversations.length > 0 && filteredConversations.length === 0 && (
            <div className="px-3 py-6 text-center">
              <p className="text-sm text-text-tertiary">没有匹配的对话</p>
            </div>
          )}

          {filteredConversations.map((conv) => (
            <ConversationItem
              key={conv.id}
              conv={conv}
              isActive={conv.id === conversationId}
              onNavigate={() => navigate(`/chat/${conv.id}`)}
              onDelete={() => {
                deleteConversation(conv.id)
                if (conv.id === conversationId) navigate('/chat')
                toast.success('已删除对话')
              }}
              onRename={(title) => renameConversation(conv.id, title)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
