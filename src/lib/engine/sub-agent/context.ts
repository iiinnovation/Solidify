import { createDispatchAgentTool } from '../../tools/builtin/dispatch-agent'
import type { Tool } from '../../tools/types'
import type { QueryContext } from '../types'
import { SharedTaskTreeBudget } from './budget'

/** Attach the root-only dispatch tool and a task-tree-wide budget/cancel signal. */
export function enableSubAgents(base: QueryContext): QueryContext {
  if (base.parentRunId || base.taskTree?.depth === 1) return base
  if (base.tools.some((tool) => tool.name === 'dispatch_agent')) return base

  const budget = new SharedTaskTreeBudget(base.limits.maxTokens, base.signal)
  const holder: { current?: QueryContext } = {}
  const dispatchTool = createDispatchAgentTool(() => {
    if (!holder.current) throw new Error('Sub-agent context is not initialized')
    return holder.current
  }) as Tool
  const context: QueryContext = {
    ...base,
    signal: budget.signal,
    taskTree: { rootRunId: base.runId, depth: 0, budget },
    tools: [...base.tools, dispatchTool],
  }
  holder.current = context
  return context
}
