import { useEffect, useMemo, useState } from 'react'
import { Check, GitCompareArrows, History, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { listWorkspaceDocumentVersions, type DocumentVersion } from '@/lib/tauri'
import { rollbackArtifact } from '@/lib/workspace/materialize'
import { toast } from '@/stores/toast-store'
import { cn } from '@/lib/utils'
import { lineDiff } from './diff'

interface VersionHistoryProps {
  path: string
  workspaceRoot: string
  currentContent: string
  messageId?: string
  onPreview: (content: string | null, label?: string) => void
  onClose: () => void
}

export function VersionHistory({ path, workspaceRoot, currentContent, messageId, onPreview, onClose }: VersionHistoryProps) {
  const [versions, setVersions] = useState<DocumentVersion[]>([])
  const [selected, setSelected] = useState<DocumentVersion | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    void listWorkspaceDocumentVersions(path, workspaceRoot)
      .then((items) => { if (active) setVersions(items.sort((a, b) => b.n - a.n)) })
      .catch((error) => toast.error(error instanceof Error ? error.message : '无法读取版本历史'))
    return () => { active = false }
  }, [path, workspaceRoot])

  const diff = useMemo(
    () => selected && showDiff ? lineDiff(selected.content, currentContent) : [],
    [currentContent, selected, showDiff],
  )

  const choose = (version: DocumentVersion | null) => {
    setSelected(version)
    setShowDiff(false)
    onPreview(version?.content ?? null, version ? `v${version.n}` : undefined)
  }

  const rollback = async () => {
    if (!selected) return
    setBusy(true)
    try {
      await rollbackArtifact(path, selected.n, messageId ?? `version-${selected.n}`)
      toast.success(`已回滚到 v${selected.n}，回滚前内容已保存为新版本`)
      onPreview(null)
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '回滚失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="flex h-full w-[min(42%,360px)] min-w-[260px] shrink-0 flex-col border-l border-border-light bg-background-secondary">
      <div className="flex h-11 items-center gap-2 border-b border-border-light px-3">
        <History size={15} className="text-text-tertiary" />
        <span className="flex-1 text-sm font-medium">版本历史</span>
        <button type="button" onClick={onClose} aria-label="关闭版本历史" className="p-1 text-text-tertiary hover:text-text-primary"><X size={16} /></button>
      </div>
      <div className="border-b border-border-light p-2">
        <button type="button" onClick={() => choose(null)} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-surface-hover', !selected && 'bg-surface text-text-primary')}>
          <Check size={14} className="text-success" /><span className="flex-1">当前版本</span>
        </button>
        {versions.map((version) => (
          <button key={version.n} type="button" onClick={() => choose(version)} className={cn('mt-0.5 block w-full rounded-md px-2 py-2 text-left hover:bg-surface-hover', selected?.n === version.n && 'bg-surface')}>
            <span className="block text-xs font-medium text-text-primary">v{version.n}</span>
            <span className="block truncate text-[11px] text-text-tertiary">{formatTimestamp(version.ts)}</span>
          </button>
        ))}
        {versions.length === 0 && <p className="px-2 py-6 text-center text-xs text-text-tertiary">还没有历史版本</p>}
      </div>
      {selected && (
        <div className="flex items-center gap-2 border-b border-border-light p-2">
          <Button size="sm" variant="outline" className="flex-1" onClick={() => setShowDiff((value) => !value)}><GitCompareArrows size={14} />{showDiff ? '查看版本' : '对比当前'}</Button>
          <Button size="sm" className="flex-1" onClick={() => void rollback()} disabled={busy}><RotateCcw size={14} />回滚</Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-5">
        {showDiff ? diff.map((line, index) => (
          <div key={`${index}:${line.text}`} className={cn('whitespace-pre-wrap break-words px-1', line.kind === 'add' && 'bg-success-light text-success', line.kind === 'remove' && 'bg-error-light text-error')}>
            {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '} {line.text || ' '}
          </div>
        )) : selected ? <pre className="whitespace-pre-wrap break-words text-text-secondary">{selected.content}</pre> : <p className="font-sans text-text-tertiary">选择历史版本后可预览、对比或回滚。</p>}
      </div>
    </aside>
  )
}

function formatTimestamp(value: string): string {
  const numeric = Number(value)
  const date = new Date(Number.isFinite(numeric) ? numeric : value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}
