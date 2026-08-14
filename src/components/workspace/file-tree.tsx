import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight, File, FileCode2, FileText, Folder, FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceEntry } from '@/lib/workspace'

export function FileTree({ entries, selectedPath, onSelect }: { entries: WorkspaceEntry[]; selectedPath: string | null; onSelect: (path: string) => void }) {
  const viewport = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useState(() => new Set<string>())
  const visible = useMemo(() => entries.filter((entry) => !hasCollapsedParent(entry.path, collapsed)), [entries, collapsed])
  // TanStack Virtual intentionally exposes mutable measurement functions.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({ count: visible.length, getScrollElement: () => viewport.current, estimateSize: () => 30, overscan: 12 })

  return (
    <div ref={viewport} className="h-full overflow-auto" role="tree" aria-label="工作区文件">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const entry = visible[row.index]
          const depth = entry.path.split('/').length - 1
          const isDirectory = entry.kind === 'directory'
          const isCollapsed = collapsed.has(entry.path)
          const Icon = isDirectory ? (isCollapsed ? Folder : FolderOpen) : fileIcon(entry.name)
          return (
            <button
              key={entry.path}
              type="button"
              role="treeitem"
              aria-selected={selectedPath === entry.path}
              aria-expanded={isDirectory ? !isCollapsed : undefined}
              onClick={() => {
                if (isDirectory) setCollapsed((current) => toggleSet(current, entry.path))
                else onSelect(entry.path)
              }}
              className={cn('absolute left-0 top-0 flex h-[30px] w-full items-center gap-1.5 pr-2 text-left text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary', selectedPath === entry.path && 'bg-accent-light text-text-primary')}
              style={{ transform: `translateY(${row.start}px)`, paddingLeft: 8 + depth * 16 }}
              title={entry.path}
            >
              {isDirectory ? (isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />) : <span className="w-[13px]" />}
              <Icon size={15} className="shrink-0 text-text-tertiary" />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function hasCollapsedParent(path: string, collapsed: Set<string>): boolean {
  const parts = path.split('/')
  for (let index = 1; index < parts.length; index++) {
    if (collapsed.has(parts.slice(0, index).join('/'))) return true
  }
  return false
}

function toggleSet(current: Set<string>, value: string): Set<string> {
  const next = new Set(current)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

function fileIcon(name: string) {
  const extension = name.split('.').pop()?.toLowerCase()
  if (extension && ['ts', 'tsx', 'js', 'jsx', 'rs', 'py', 'go', 'java'].includes(extension)) return FileCode2
  if (extension && ['md', 'txt', 'doc', 'docx', 'pdf', 'csv'].includes(extension)) return FileText
  return File
}
