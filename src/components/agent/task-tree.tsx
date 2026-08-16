import { ChevronRight, GitBranch } from 'lucide-react'
import type { RunSubAgentItem } from '@/lib/engine/run-state'

export function TaskTree({ rootRunId, agents }: { rootRunId: string; agents: readonly RunSubAgentItem[] }) {
  if (agents.length === 0) return null
  return (
    <div className="w-full min-w-48 border-l border-border pl-4 lg:max-w-56" aria-label="任务树">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-primary"><GitBranch size={13} />任务树</div>
      <div className="flex items-center gap-1 text-[11px] text-text-secondary"><span className="font-mono truncate" title={rootRunId}>{rootRunId}</span></div>
      <div className="mt-1 space-y-1">
        {agents.map((agent) => <div key={agent.agentId} className="flex min-w-0 items-center gap-1.5 pl-2 text-[11px] text-text-tertiary"><ChevronRight size={11} className="shrink-0" /><span className="truncate" title={agent.task}>{agent.agentId} · {agent.role}</span></div>)}
      </div>
    </div>
  )
}
