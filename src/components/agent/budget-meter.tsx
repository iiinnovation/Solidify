import { Gauge } from 'lucide-react'
import type { TaskTreeBudgetSnapshot } from '@/lib/engine/sub-agent/types'

export function BudgetMeter({ budget }: { budget?: TaskTreeBudgetSnapshot }) {
  if (!budget) return null
  const percentage = Math.min(100, budget.limit > 0 ? (budget.used / budget.limit) * 100 : 0)
  return (
    <div className="mt-3 flex items-center gap-2" aria-label="任务树 token 预算">
      <Gauge size={13} className="shrink-0 text-text-tertiary" />
      <div className="h-1.5 min-w-20 flex-1 overflow-hidden rounded-full bg-border-light" role="progressbar" aria-valuemin={0} aria-valuemax={budget.limit} aria-valuenow={Math.min(budget.limit, budget.used)}>
        <div className={`h-full rounded-full transition-all ${percentage >= 90 ? 'bg-error' : percentage >= 70 ? 'bg-warning' : 'bg-accent'}`} style={{ width: `${percentage}%` }} />
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-text-tertiary">{budget.used.toLocaleString()} / {budget.limit.toLocaleString()}</span>
    </div>
  )
}
