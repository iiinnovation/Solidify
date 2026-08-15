import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, LoaderCircle, Play, Square, TimerReset } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { RunState } from '@/lib/engine/run-state'
import { ToolCallCard } from './tool-call-card'
import { LedgerPanel } from './ledger-panel'

export function RunTimeline({ run, onStop }: { run: RunState | null; onStop?: () => void }) {
  const [elapsed, setElapsed] = useState(() => run && !run.completedAt
    ? Math.max(0, Date.now() - run.startedAt)
    : 0)

  useEffect(() => {
    if (!run || run.completedAt) return
    const startedAt = run.startedAt
    const timer = window.setInterval(() => {
      setElapsed(Math.max(0, Date.now() - startedAt))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [run?.runId, run?.startedAt, run?.completedAt])

  if (!run) return null
  const duration = run.completedAt ? run.completedAt - run.startedAt : elapsed
  const active = run.status === 'running'
  const statusLabel = run.status === 'running' ? '运行中' : run.status === 'completed' ? '已完成' : run.status === 'aborted' ? '已停止' : run.status === 'exhausted' ? '已达上限' : run.status === 'failed' ? '失败' : '准备中'

  return (
    <section className="mb-4 border-y border-border-light bg-background-secondary/70" aria-label="Agent 运行过程">
      <div className="py-2.5 flex flex-wrap items-center gap-2">
        {active ? <LoaderCircle size={14} className="text-accent animate-spin" /> : run.status === 'completed' ? <CircleCheck size={14} className="text-success" /> : run.status === 'aborted' ? <Square size={12} className="text-warning" /> : run.status === 'failed' ? <CircleAlert size={14} className="text-error" /> : <Play size={14} className="text-text-tertiary" />}
        <span className="text-xs font-medium text-text-primary">{statusLabel}</span>
        <span className="text-[11px] text-text-tertiary font-mono">{run.tools.length} 次工具调用</span>
        {run.usage && (
          <span className="text-[11px] text-text-tertiary tabular-nums">
            {run.usage.totalTokens.toLocaleString()} tokens
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-text-tertiary tabular-nums"><TimerReset size={12} />{duration}ms</span>
        {active && onStop && (
          <button type="button" onClick={onStop} className="ml-2 inline-flex items-center gap-1 px-2 py-1 rounded-sm text-[11px] text-error hover:bg-error-light" title="停止运行">
            <Square size={11} fill="currentColor" />停止
          </button>
        )}
      </div>
      {(run.tools.length > 0 || run.error) && (
        <div className="pb-3 space-y-2">
          {run.tools.map((item) => <ToolCallCard key={item.call.id} item={item} />)}
          {run.error && <div className={cn('text-xs px-3 py-2 rounded-sm', run.status === 'failed' ? 'text-error bg-error-light' : 'text-text-secondary bg-surface')}>{run.error}</div>}
        </div>
      )}
      <div className="pb-2"><LedgerPanel runId={run.runId} /></div>
    </section>
  )
}
