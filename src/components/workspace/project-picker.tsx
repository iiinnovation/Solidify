import { useState } from 'react'
import { FolderOpen, FolderPlus, LoaderCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useNavigate } from 'react-router-dom'

export function ProjectPicker({ compact = false }: { compact?: boolean }) {
  const { project, workspaceRoot, status, error, open, create, close } = useWorkspaceStore()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const busy = status === 'opening' || status === 'indexing'

  if (compact && workspaceRoot) {
    return (
      <button type="button" onClick={() => navigate('/workspace')} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-hover" title={workspaceRoot}>
        <FolderOpen size={16} className="shrink-0 text-text-tertiary" />
        <span className="min-w-0 flex-1 truncate text-text-primary">{project?.name ?? '本地工作区'}</span>
        {busy && <LoaderCircle size={13} className="animate-spin text-accent" />}
      </button>
    )
  }

  return (
    <div className="border-b border-border-light bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <FolderOpen size={16} />
            <span className="truncate">{project?.name ?? '未打开工作区'}</span>
          </div>
          {workspaceRoot && <p className="mt-0.5 max-w-xl truncate text-xs text-text-tertiary" title={workspaceRoot}>{workspaceRoot}</p>}
        </div>
        {creating ? (
          <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); const value = name.trim(); if (!value) return; void create(value).then(() => { setName(''); setCreating(false) }) }}>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="项目名称" className="h-8 w-48 rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-border-focus" />
            <Button size="sm" type="submit" disabled={!name.trim() || busy}>创建</Button>
            <Button size="icon" variant="ghost" type="button" onClick={() => setCreating(false)} aria-label="取消创建"><X size={16} /></Button>
          </form>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={() => setCreating(true)} disabled={busy}><FolderPlus size={15} />新建</Button>
            <Button size="sm" onClick={() => void open()} disabled={busy}><FolderOpen size={15} />打开</Button>
            {workspaceRoot && <Button size="sm" variant="ghost" onClick={() => void close()} disabled={busy}>关闭</Button>}
          </>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-error">{error}</p>}
    </div>
  )
}
