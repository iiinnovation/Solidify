import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, LoaderCircle, Play, Square, TimerReset } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { RunState } from '@/lib/engine/run-state'
import { ToolCallCard } from './tool-call-card'
import { LedgerPanel } from './ledger-panel'
import { ParallelTimeline } from './parallel-timeline'
import { TaskTree } from './task-tree'
import { BudgetMeter } from './budget-meter'

function ElapsedTime({ startedAt, completedAt }: { startedAt: number; completedAt?: number }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (completedAt) return
    const refresh = window.setTimeout(() => setNow(Date.now()), 0)
    const timer = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now())
    }, 1000)
    return () => {
      window.clearTimeout(refresh)
      window.clearInterval(timer)
    }
  }, [startedAt, completedAt])

  return <>{completedAt ? completedAt - startedAt : Math.max(0, now - startedAt)}ms</>
}

export function RunTimeline({ run, onStop }: { run: RunState | null; onStop?: () => void }) {
  if (!run) return null
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
        <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-text-tertiary tabular-nums"><TimerReset size={12} /><ElapsedTime startedAt={run.startedAt} completedAt={run.completedAt} /></span>
        {active && onStop && (
          <button type="button" onClick={onStop} className="ml-2 inline-flex items-center gap-1 px-2 py-1 rounded-sm text-[11px] text-error hover:bg-error-light" title="停止运行">
            <Square size={11} fill="currentColor" />停止
          </button>
        )}
      </div>
      {(run.subAgents?.length ?? 0) > 0 && (
        <div className="border-t border-border-light py-3">
          <div className="flex flex-col gap-4 lg:flex-row">
            <ParallelTimeline agents={run.subAgents ?? []} />
            <TaskTree rootRunId={run.runId} agents={run.subAgents ?? []} />
          </div>
          <BudgetMeter budget={run.taskBudget} />
        </div>
      )}
      {(run.tools.length > 0 || run.error) && (
        <div className="pb-3 space-y-2">
          {run.tools.map((item) => <ToolCallCard key={item.call.id} item={item} />)}
          {run.error && <div className={cn('text-xs px-3 py-2 rounded-sm', run.status === 'failed' ? 'text-error bg-error-light' : 'text-text-secondary bg-surface')}>{run.error}</div>}
        </div>
      )}
      <div className="pb-2"><LedgerPanel runId={run.runId} revision={run.tools.reduce((count, tool) => count + (tool.completedAt ? 2 : 1), 0) + (run.completedAt ? 1 : 0)} /></div>
    </section>
  )
}
