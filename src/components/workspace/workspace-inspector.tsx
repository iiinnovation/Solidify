import { useEffect, useMemo, useState } from 'react'
import {
  Boxes,
  CheckCircle2,
  Eye,
  FileCode2,
  Files,
  GitCompareArrows,
  Search,
  X,
  XCircle,
} from 'lucide-react'
import { ArtifactPanel } from '@/components/artifacts/artifact-panel'
import { DocumentViewer } from '@/components/documents/document-viewer'
import { FileTree } from '@/components/workspace/file-tree'
import { conversationChanges, conversationDeliverables, type WorkspaceDeliverable } from '@/lib/workspace/inspector'
import type { WorkspaceSearchResult } from '@/lib/workspace'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/stores/chat-store'
import { useDocumentStore } from '@/stores/document-store'
import { useUIStore, type PreviewPanelKind, type WorkspaceInspectorTab } from '@/stores/ui-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

const tabs: Array<{ id: WorkspaceInspectorTab; label: string; icon: typeof Boxes }> = [
  { id: 'deliverables', label: '交付物', icon: Boxes },
  { id: 'files', label: '文件', icon: Files },
  { id: 'changes', label: '变更', icon: GitCompareArrows },
  { id: 'preview', label: '预览', icon: Eye },
]

export function WorkspaceInspector({ conversationId, onClose }: { conversationId?: string; onClose: () => void }) {
  const tab = useUIStore((state) => state.workspaceInspectorTab)
  const setTab = useUIStore((state) => state.setWorkspaceInspectorTab)
  const previewKind = useUIStore((state) => state.previewPanelKind)
  const conversations = useChatStore((state) => state.conversations)
  const artifacts = useChatStore((state) => state.artifacts)
  const conversation = conversations.find((candidate) => candidate.id === conversationId)
  const deliverables = useMemo(
    () => conversationDeliverables(conversation, artifacts),
    [artifacts, conversation],
  )
  const changes = useMemo(() => conversationChanges(conversation), [conversation])

  return (
    <div className="flex h-full min-w-0 flex-col bg-background" aria-label="工作区检查器">
      <div className="flex h-11 shrink-0 items-center border-b border-border-light bg-background-secondary px-2">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" role="tablist" aria-label="工作区视图">
          {tabs.map(({ id, label, icon: Icon }) => {
            const count = id === 'deliverables' ? deliverables.length : id === 'changes' ? changes.length : undefined
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={cn(
                  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors',
                  tab === id
                    ? 'bg-surface text-text-primary shadow-xs'
                    : 'text-text-tertiary hover:bg-surface-hover hover:text-text-primary',
                )}
              >
                <Icon size={13} strokeWidth={1.75} />
                {label}
                {count !== undefined && count > 0 && <span className="text-[10px] tabular-nums text-text-tertiary">{count}</span>}
              </button>
            )
          })}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭工作区检查器"
          title="关闭"
          className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          <X size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1" role="tabpanel">
        {tab === 'deliverables' && <DeliverablesView items={deliverables} />}
        {tab === 'files' && <WorkspaceFilesView />}
        {tab === 'changes' && <WorkspaceChangesView conversationId={conversationId} />}
        {tab === 'preview' && <PreviewView conversationId={conversationId} kind={previewKind} />}
      </div>
    </div>
  )
}

function DeliverablesView({ items }: { items: WorkspaceDeliverable[] }) {
  const setActiveArtifact = useChatStore((state) => state.setActiveArtifact)
  const setActivePath = useDocumentStore((state) => state.setActivePath)
  const selectPath = useWorkspaceStore((state) => state.selectPath)
  const openPreview = useUIStore((state) => state.openPreviewPanel)

  const openItem = (item: WorkspaceDeliverable) => {
    if (item.kind === 'artifact' && item.artifactId) {
      setActiveArtifact(item.artifactId)
      openPreview('artifact')
      return
    }
    if (!item.path) return
    selectPath(item.path)
    setActivePath(item.path)
    openPreview('document')
  }

  if (items.length === 0) {
    return <InspectorEmpty icon={Boxes} title="还没有交付物" detail="当前任务生成的文档、图表和文件会集中显示在这里" />
  }

  return (
    <div className="h-full overflow-auto py-1">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => openItem(item)}
          className="flex w-full min-w-0 items-center gap-3 border-b border-border-light px-4 py-3 text-left transition-colors hover:bg-surface-hover"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background-secondary text-text-tertiary">
            <FileCode2 size={15} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-text-primary">{item.title}</span>
            <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">
              {item.path ?? artifactKindLabel(item.kind)} · 版本 {item.version}
            </span>
          </span>
          <Eye size={14} className="shrink-0 text-text-tertiary" />
        </button>
      ))}
    </div>
  )
}

function WorkspaceFilesView() {
  const workspaceRoot = useWorkspaceStore((state) => state.workspaceRoot)
  const entries = useWorkspaceStore((state) => state.entries)
  const selectedPath = useWorkspaceStore((state) => state.selectedPath)
  const status = useWorkspaceStore((state) => state.status)
  const selectPath = useWorkspaceStore((state) => state.selectPath)
  const search = useWorkspaceStore((state) => state.search)
  const setActivePath = useDocumentStore((state) => state.setActivePath)
  const openPreview = useUIStore((state) => state.openPreviewPanel)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WorkspaceSearchResult[]>([])
  const [resultsQuery, setResultsQuery] = useState('')
  const [resultsWorkspaceRoot, setResultsWorkspaceRoot] = useState<string | null>(null)

  useEffect(() => {
    if (!query.trim() || !workspaceRoot) return
    let active = true
    const requestedQuery = query
    const requestedRoot = workspaceRoot
    const timer = window.setTimeout(() => {
      void search(requestedQuery, 30).then((items) => {
        if (!active) return
        setResults(items)
        setResultsQuery(requestedQuery)
        setResultsWorkspaceRoot(requestedRoot)
      })
    }, 200)
    return () => { active = false; window.clearTimeout(timer) }
  }, [query, search, workspaceRoot])

  const choosePath = (path: string) => {
    selectPath(path)
    setActivePath(path)
    openPreview('document')
  }

  if (!workspaceRoot) {
    return <InspectorEmpty icon={Files} title="未打开工作区" detail="打开本地项目后，可在这里浏览任务文件" />
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border-light p-2">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索工作区文件"
            className="h-8 w-full rounded-md border border-border bg-surface pl-8 pr-2 text-xs outline-none focus:border-border-focus"
          />
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-text-tertiary">
          {status === 'indexing' ? '正在建立索引' : `${entries.filter((entry) => entry.kind === 'file').length} 个文件`}
        </p>
      </div>
      <div className="min-h-0 flex-1">
        {query.trim()
          ? <FileSearchResults results={resultsQuery === query && resultsWorkspaceRoot === workspaceRoot ? results : []} onSelect={choosePath} />
          : <FileTree entries={entries} selectedPath={selectedPath} onSelect={choosePath} />}
      </div>
    </div>
  )
}

function WorkspaceChangesView({ conversationId }: { conversationId?: string }) {
  const conversation = useChatStore((state) => state.conversations.find((item) => item.id === conversationId))
  const changes = useMemo(() => conversationChanges(conversation), [conversation])
  const workspaceRoot = useWorkspaceStore((state) => state.workspaceRoot)
  const selectPath = useWorkspaceStore((state) => state.selectPath)
  const setActivePath = useDocumentStore((state) => state.setActivePath)
  const openPreview = useUIStore((state) => state.openPreviewPanel)

  if (changes.length === 0) {
    return <InspectorEmpty icon={GitCompareArrows} title="当前任务没有文件变更" detail="Agent 成功写入或生成文件后，会在这里留下可检查的记录" />
  }

  return (
    <div className="h-full overflow-auto py-1">
      <div className="border-b border-border-light px-4 py-2 text-[11px] leading-relaxed text-text-tertiary">
        这里展示当前任务的写入记录。只有保存了修改前版本的交付物才可在预览中查看版本历史。
      </div>
      {changes.map((change) => {
        const successful = change.status === 'completed'
        return (
          <button
            key={change.id}
            type="button"
            disabled={!successful || !workspaceRoot}
            onClick={() => {
              selectPath(change.path)
              setActivePath(change.path)
              openPreview('document')
            }}
            className="flex w-full min-w-0 items-start gap-3 border-b border-border-light px-4 py-3 text-left transition-colors enabled:hover:bg-surface-hover disabled:cursor-default"
          >
            {successful
              ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-success" />
              : <XCircle size={15} className="mt-0.5 shrink-0 text-error" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-text-primary">{change.path}</span>
              <span className="mt-1 block text-[11px] text-text-tertiary">
                {change.operation === 'generated' ? '已生成' : '已写入'}
                {change.bytesWritten !== undefined ? ` · ${formatBytes(change.bytesWritten)}` : ''}
                {` · ${change.toolName}`}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function PreviewView({ conversationId, kind }: { conversationId?: string; kind: PreviewPanelKind | null }) {
  if (kind === 'artifact') return <ArtifactPanel conversationId={conversationId} embedded />
  if (kind === 'document') return <DocumentViewer />
  return <InspectorEmpty icon={Eye} title="选择内容进行预览" detail="从交付物、文件或变更中选择一项" />
}

function FileSearchResults({ results, onSelect }: { results: WorkspaceSearchResult[]; onSelect: (path: string) => void }) {
  if (results.length === 0) return <p className="p-6 text-center text-xs text-text-tertiary">没有匹配文件</p>
  return (
    <div className="h-full overflow-auto py-1">
      {results.map((result, index) => (
        <button
          key={`${result.path}:${index}`}
          type="button"
          onClick={() => onSelect(result.path)}
          className="block w-full border-b border-border-light px-4 py-2.5 text-left hover:bg-surface-hover"
        >
          <p className="truncate text-xs font-medium text-text-primary">{result.path}</p>
          <p className="mt-0.5 line-clamp-2 text-[11px] text-text-tertiary">{result.text}</p>
        </button>
      ))}
    </div>
  )
}

function InspectorEmpty({ icon: Icon, title, detail }: { icon: typeof Boxes; title: string; detail: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div className="max-w-xs">
        <Icon size={24} className="mx-auto text-text-tertiary" strokeWidth={1.5} />
        <p className="mt-3 text-sm font-medium text-text-primary">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-text-tertiary">{detail}</p>
      </div>
    </div>
  )
}

function artifactKindLabel(kind: WorkspaceDeliverable['kind']): string {
  return kind === 'artifact' ? '会话交付物' : '工作区文件'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
