import { Check, CircleAlert, LoaderCircle, Square } from 'lucide-react'
import type { RunSubAgentItem } from '@/lib/engine/run-state'
import { cn } from '@/lib/utils'

const statusText: Record<RunSubAgentItem['status'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  aborted: '已停止',
  exhausted: '预算耗尽',
}

export function ParallelTimeline({ agents }: { agents: readonly RunSubAgentItem[] }) {
  if (agents.length === 0) return null
  return (
    <div className="min-w-0 flex-1" aria-label="并行执行线">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-medium text-text-primary">并行执行</h3>
        <span className="text-[11px] tabular-nums text-text-tertiary">{agents.filter((agent) => agent.status === 'completed').length}/{agents.length} 完成</span>
      </div>
      <div className="space-y-1.5">
        {agents.map((agent) => {
          const Icon = agent.status === 'completed' ? Check : agent.status === 'failed' || agent.status === 'exhausted' ? CircleAlert : agent.status === 'aborted' ? Square : LoaderCircle
          return (
            <div key={agent.agentId} className="flex min-w-0 items-center gap-2 border-b border-border-light py-1.5 last:border-0">
              <Icon size={13} className={cn('shrink-0', agent.status === 'running' && 'animate-spin text-accent', agent.status === 'completed' && 'text-success', (agent.status === 'failed' || agent.status === 'exhausted') && 'text-error', agent.status === 'aborted' && 'text-warning')} />
              <span className="w-24 shrink-0 truncate text-xs font-medium text-text-primary" title={agent.role}>{agent.role}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-text-secondary" title={agent.task}>{agent.task}</span>
              {agent.usage && <span className="shrink-0 text-[11px] tabular-nums text-text-tertiary">{agent.usage.totalTokens.toLocaleString()}</span>}
              <span className="w-14 shrink-0 text-right text-[11px] text-text-tertiary">{statusText[agent.status]}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
