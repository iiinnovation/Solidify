import { useEffect, useState } from 'react'
import { FileText, FolderOpen, LoaderCircle, LogOut, MessageSquare, PanelRightOpen, Plus, Search, Trash2, X } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { FileTree } from '@/components/workspace/file-tree'
import { Button } from '@/components/ui/button'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDocumentStore } from '@/stores/document-store'
import { useChatStore } from '@/stores/chat-store'
import { useUIStore } from '@/stores/ui-store'
import type { WorkspaceSearchResult } from '@/lib/workspace'
import { cn } from '@/lib/utils'

const STAGES = [
  ['discovery', '调研'], ['requirements', '需求'], ['solution', '方案'], ['delivery', '交付'], ['completed', '完成'],
] as const

export function ProjectRail({ compact = false }: { compact?: boolean }) {
  const [flyout, setFlyout] = useState<'files' | 'chats' | null>(null)
  const openWorkspaceInspector = useUIStore((state) => state.openWorkspaceInspector)
  if (compact) {
    return (
      <div className="relative flex h-full w-11 flex-col items-center gap-1 bg-background-secondary py-2">
        <RailIcon label="项目文件" active={flyout === 'files'} onClick={() => setFlyout((value) => value === 'files' ? null : 'files')}><FolderOpen size={18} /></RailIcon>
        <RailIcon label="对话" active={flyout === 'chats'} onClick={() => setFlyout((value) => value === 'chats' ? null : 'chats')}><MessageSquare size={18} /></RailIcon>
        <RailIcon label="工作区检查器" active={false} onClick={() => { setFlyout(null); openWorkspaceInspector('deliverables') }}><PanelRightOpen size={18} /></RailIcon>
        {flyout && <div className="fixed bottom-0 left-11 top-12 z-40 w-[280px] border-r border-border bg-background-secondary shadow-lg"><RailContent key={flyout} initialTab={flyout} onClose={() => setFlyout(null)} /></div>}
      </div>
    )
  }
  return <RailContent />
}

function RailIcon({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} className={cn('flex h-9 w-9 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-primary', active && 'bg-accent-light text-accent')}>{children}</button>
}

function RailContent({ initialTab = 'files', onClose }: { initialTab?: 'files' | 'chats'; onClose?: () => void }) {
  const navigate = useNavigate()
  const { conversationId } = useParams<{ conversationId: string }>()
  const { workspaceRoot, project, entries, selectedPath, status, open, close, selectPath, search, setStage } = useWorkspaceStore()
  const conversations = useChatStore((state) => state.conversations)
  const deleteConversation = useChatStore((state) => state.deleteConversation)
  const setActivePath = useDocumentStore((state) => state.setActivePath)
  const openPreviewPanel = useUIStore((state) => state.openPreviewPanel)
  const openWorkspaceInspector = useUIStore((state) => state.openWorkspaceInspector)
  const [tab, setTab] = useState<'files' | 'chats'>(initialTab)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WorkspaceSearchResult[]>([])
  const [resultsQuery, setResultsQuery] = useState('')
  const [resultsWorkspaceRoot, setResultsWorkspaceRoot] = useState<string | null>(null)
  const workspaceConversations = workspaceRoot
    ? conversations.filter((conversation) => conversation.workspaceRoot === workspaceRoot)
    : conversations.filter((conversation) => !conversation.workspaceRoot)

  useEffect(() => {
    if (!query.trim() || !workspaceRoot) return
    let active = true
    const requestedQuery = query
    const requestedRoot = workspaceRoot
    const timer = window.setTimeout(() => void search(requestedQuery, 30).then((items) => {
      if (!active) return
      setResults(items)
      setResultsQuery(requestedQuery)
      setResultsWorkspaceRoot(requestedRoot)
    }), 200)
    return () => { active = false; window.clearTimeout(timer) }
  }, [query, search, workspaceRoot])

  const choosePath = (path: string) => {
    selectPath(path)
    setActivePath(path)
    openPreviewPanel('document')
    setQuery('')
    onClose?.()
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-background-secondary">
      <div className="flex h-11 items-center gap-2 border-b border-border-light px-2">
        <button type="button" onClick={() => void open()} title={workspaceRoot ?? '打开本地项目'} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface-hover">
          <FolderOpen size={15} className="shrink-0 text-accent" />
          <span className="truncate text-sm font-medium">{project?.name ?? (status === 'opening' ? '正在打开' : '打开项目')}</span>
        </button>
        {workspaceRoot && <button type="button" onClick={() => void close()} aria-label="关闭项目" title="关闭项目" className="p-1 text-text-tertiary hover:text-text-primary"><LogOut size={14} /></button>}
        <button type="button" onClick={() => openWorkspaceInspector('deliverables')} aria-label="打开工作区检查器" title="打开工作区检查器" className="p-1 text-text-tertiary hover:text-text-primary"><PanelRightOpen size={15} /></button>
        {onClose && <button type="button" onClick={onClose} aria-label="关闭面板" className="p-1 text-text-tertiary"><X size={15} /></button>}
      </div>
      {project && <div className="flex items-center gap-2 border-b border-border-light px-3 py-2"><span className="text-[11px] text-text-tertiary">阶段</span><select aria-label="项目阶段" value={project.stage} onChange={(event) => void setStage(event.target.value)} className="h-7 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-xs outline-none focus:border-border-focus">{STAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>}
      <div className="grid h-9 grid-cols-2 border-b border-border-light p-1">
        <button type="button" onClick={() => setTab('files')} className={cn('flex items-center justify-center gap-1.5 rounded text-xs text-text-tertiary', tab === 'files' && 'bg-surface text-text-primary shadow-xs')}><FileText size={13} />文件</button>
        <button type="button" onClick={() => setTab('chats')} className={cn('flex items-center justify-center gap-1.5 rounded text-xs text-text-tertiary', tab === 'chats' && 'bg-surface text-text-primary shadow-xs')}><MessageSquare size={13} />对话</button>
      </div>
      {tab === 'files' ? <>
        <div className="border-b border-border-light p-2"><div className="relative"><Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目文件" className="h-8 w-full rounded-md border border-border bg-surface pl-8 pr-2 text-xs outline-none focus:border-border-focus" /></div></div>
        <div className="min-h-0 flex-1">{query.trim()
          ? <SearchResults results={resultsQuery === query && resultsWorkspaceRoot === workspaceRoot ? results : []} onSelect={choosePath} />
          : <FileTree entries={entries} selectedPath={selectedPath} onSelect={choosePath} />}</div>
      </> : <>
        <div className="border-b border-border-light p-2"><Button variant="secondary" size="sm" className="w-full justify-start" onClick={() => { navigate('/chat'); onClose?.() }}><Plus size={14} />新建对话</Button></div>
        <div className="min-h-0 flex-1 overflow-auto p-2">{workspaceConversations.map((conversation) => {
          const running = conversation.messages.some((message) => message.agentRun?.status === 'running')
          return <div key={conversation.id} className="group relative"><button type="button" onClick={() => { navigate(`/chat/${conversation.id}`); onClose?.() }} className={cn('flex h-8 w-full items-center gap-2 rounded-md px-2 pr-8 text-left text-xs text-text-secondary hover:bg-surface-hover', conversation.id === conversationId && 'bg-accent-light text-text-primary')}><MessageSquare size={13} className="shrink-0" /><span className="min-w-0 flex-1 truncate">{conversation.title}</span>{running && <LoaderCircle size={12} aria-label="运行中" className="shrink-0 animate-spin text-accent group-hover:hidden" />}</button><button type="button" onClick={() => { deleteConversation(conversation.id); if (conversation.id === conversationId) navigate('/chat') }} aria-label={`删除 ${conversation.title}`} className="absolute right-1 top-1.5 hidden p-0.5 text-text-tertiary hover:text-error group-hover:block"><Trash2 size={12} /></button></div>
        })}{workspaceConversations.length === 0 && <p className="py-8 text-center text-xs text-text-tertiary">还没有对话</p>}</div>
      </>}
    </div>
  )
}

function SearchResults({ results, onSelect }: { results: WorkspaceSearchResult[]; onSelect: (path: string) => void }) {
  return <div className="h-full overflow-auto py-1">{results.map((result, index) => <button key={`${result.path}:${index}`} type="button" onClick={() => onSelect(result.path)} className="block w-full border-b border-border-light px-3 py-2 text-left hover:bg-surface-hover"><p className="truncate text-xs font-medium">{result.path}</p><p className="mt-0.5 line-clamp-2 text-[11px] text-text-tertiary">{result.text}</p></button>)}{results.length === 0 && <p className="p-4 text-center text-xs text-text-tertiary">没有匹配文件</p>}</div>
}
