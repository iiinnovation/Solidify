import { memo, useState } from 'react'
import { Check, ChevronDown, CircleAlert, Clock3, LoaderCircle, Wrench } from 'lucide-react'
import { cn, formatDuration } from '@/lib/utils'
import type { RunToolItem } from '@/lib/engine/run-state'

export const ToolCallCard = memo(function ToolCallCard({ item }: { item: RunToolItem }) {
  const [expanded, setExpanded] = useState(false)
  const duration = item.completedAt ? Math.max(0, item.completedAt - item.startedAt) : undefined
  const failed = item.result && !item.result.success
  const Icon = item.status === 'completed' ? (failed ? CircleAlert : Check) : item.status === 'running' ? LoaderCircle : Clock3

  return (
    <div className={cn('border rounded-md bg-surface overflow-hidden', failed ? 'border-error/30' : 'border-border')}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="w-full min-h-10 px-3 py-2 flex items-center gap-2 text-left hover:bg-surface-hover transition-colors"
        aria-expanded={expanded}
      >
        <Wrench size={14} className="text-text-tertiary shrink-0" strokeWidth={1.75} />
        <span className="font-mono text-xs text-text-primary truncate flex-1">{item.call.name}</span>
        <Icon size={14} className={cn(
          item.status === 'running' && 'animate-spin text-accent',
          item.status === 'requested' && 'text-text-tertiary',
          item.status === 'completed' && (failed ? 'text-error' : 'text-success'),
        )} strokeWidth={1.9} />
        {duration !== undefined && <span className="text-[11px] text-text-tertiary tabular-nums">{formatDuration(duration)}</span>}
        <ChevronDown size={14} className={cn('text-text-tertiary transition-transform', expanded && 'rotate-180')} />
      </button>

      {item.status === 'running' && item.progress && (
        <div className="px-3 pb-2 text-[11px] text-text-tertiary truncate">{item.progress}</div>
      )}
      {expanded && (
        <div className="border-t border-border-light px-3 py-2 space-y-2 text-xs">
          <div>
            <div className="text-[11px] text-text-tertiary mb-1">参数</div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-text-secondary">{JSON.stringify(item.call.input, null, 2)}</pre>
          </div>
          {item.result && (
            <div>
              <div className="text-[11px] text-text-tertiary mb-1">结果</div>
              <pre className={cn('max-h-40 overflow-auto whitespace-pre-wrap break-words', failed ? 'text-error' : 'text-text-secondary')}>{item.result.content}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
})
