import { useEffect, useState } from 'react'
import { ArrowLeft, Search } from 'lucide-react'
import { ProjectPicker } from '@/components/workspace/project-picker'
import { FileTree } from '@/components/workspace/file-tree'
import { FilePreview } from '@/components/workspace/file-preview'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { WorkspaceSearchResult } from '@/lib/workspace'

export function WorkspacePage() {
  const { workspaceRoot, entries, selectedPath, selectPath, indexStats, status, search } = useWorkspaceStore()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WorkspaceSearchResult[]>([])

  useEffect(() => {
    if (!query.trim()) return
    let active = true
    const timer = window.setTimeout(() => {
      void search(query, 30).then((matches) => { if (active) setResults(matches) })
    }, 200)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [query, search])

  return (
    <div className="flex h-full flex-col bg-background">
      <ProjectPicker />
      {!workspaceRoot ? <div className="flex flex-1 items-center justify-center text-sm text-text-tertiary">打开或新建本地工作区</div> : (
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(220px,28%)_minmax(0,1fr)]">
          <aside className={selectedPath ? 'hidden min-h-0 flex-col border-r border-border-light bg-background-secondary md:flex' : 'flex min-h-0 flex-col border-r border-border-light bg-background-secondary'}>
            <div className="border-b border-border-light p-2">
              <div className="relative"><Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索工作区" className="h-8 w-full rounded-md border border-border bg-surface pl-8 pr-2 text-sm outline-none focus:border-border-focus" /></div>
              <div className="mt-1.5 flex justify-between px-1 text-[11px] text-text-tertiary"><span>{status === 'indexing' ? '正在建立索引' : `${entries.filter((entry) => entry.kind === 'file').length} 个文件`}</span><span>{indexStats ? `${indexStats.indexedDocuments} 已索引` : ''}</span></div>
            </div>
            <div className="min-h-0 flex-1">
              {query.trim() ? <SearchResults results={results} onSelect={(path) => { selectPath(path); setQuery('') }} /> : <FileTree entries={entries} selectedPath={selectedPath} onSelect={selectPath} />}
            </div>
          </aside>
          <main className={selectedPath ? 'relative min-w-0' : 'hidden min-w-0 md:block'}>
            {selectedPath && (
              <button type="button" onClick={() => selectPath(null)} aria-label="返回文件列表" className="absolute left-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface shadow-sm md:hidden">
                <ArrowLeft size={16} />
              </button>
            )}
            <FilePreview workspaceRoot={workspaceRoot} path={selectedPath} />
          </main>
        </div>
      )}
    </div>
  )
}

function SearchResults({ results, onSelect }: { results: WorkspaceSearchResult[]; onSelect: (path: string) => void }) {
  return <div className="h-full overflow-auto py-1">{results.map((result) => <button key={`${result.path}:${result.text}`} type="button" onClick={() => onSelect(result.path)} className="block w-full border-b border-border-light px-3 py-2 text-left hover:bg-surface-hover"><p className="truncate text-xs font-medium text-text-primary">{result.path}</p><p className="mt-0.5 line-clamp-2 text-[11px] text-text-tertiary">{result.text}</p></button>)}{results.length === 0 && <p className="p-4 text-center text-xs text-text-tertiary">没有匹配文件</p>}</div>
}
