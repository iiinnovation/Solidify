import { LoaderCircle, Square } from 'lucide-react'
import type { RunState } from '@/lib/engine/run-state'

export function RunControls({ run, onStop }: { run: RunState | null; onStop: () => void }) {
  if (!run || run.status !== 'running') return null
  return (
    <button type="button" onClick={onStop} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-sm text-xs text-error hover:bg-error-light" title="停止 Agent 运行">
      <LoaderCircle size={13} className="animate-spin" />
      <Square size={10} fill="currentColor" />
      停止
    </button>
  )
}
