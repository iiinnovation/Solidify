import type { ToolCall, ToolResult } from '../tools/types'

export type HookType =
  | 'before_query'
  | 'before_model_call'
  | 'after_model_call'
  | 'before_tool_call'
  | 'execute_tool'
  | 'after_tool_call'
  | 'on_permission'
  | 'on_error'
  | 'on_run_completed'
  | 'on_settings_change'

export type HookMode = 'observe' | 'waterfall' | 'around'
export type ObserveHookType = Exclude<HookType, 'before_query' | 'before_model_call' | 'before_tool_call' | 'execute_tool'>
export type WaterfallHookType = 'before_query' | 'before_model_call' | 'before_tool_call'

export interface HookContext<T extends HookType = HookType> {
  type: T
  runId?: string
  callId?: string
  signal?: AbortSignal
  onHookError?: (hookId: string, error: unknown) => void
  [key: string]: unknown
}

export type HookValue<T extends WaterfallHookType> = T extends 'before_tool_call'
  ? ToolCall
  : T extends 'before_query'
    ? unknown
    : T extends 'before_model_call'
      ? unknown
      : never

export type HookOutcome<T> =
  | { action: 'continue'; value: T }
  | { action: 'short_circuit'; result: ToolResult }
  | { action: 'abort'; reason: string }

export type HookHandler<T extends HookType, M extends HookMode> =
  M extends 'observe'
    ? (ctx: HookContext<T>) => void | Promise<void>
    : M extends 'waterfall'
      ? (value: HookValue<Extract<T, WaterfallHookType>>, ctx: HookContext<T>) => HookOutcome<HookValue<Extract<T, WaterfallHookType>>> | Promise<HookOutcome<HookValue<Extract<T, WaterfallHookType>>>>
      : (ctx: HookContext<T>, next: () => Promise<unknown>) => Promise<unknown>

export interface Hook<T extends HookType = HookType, M extends HookMode = HookMode> {
  id: string
  type: T
  mode: M
  priority: number
  handler: HookHandler<T, M>
}

export type GuardDecision =
  | { kind: 'abstain' }
  | { kind: 'deny'; reason: string; source: string }

export interface ExecuteToolContext extends HookContext<'execute_tool'> {
  call: ToolCall
}

export class HookManager {
  private readonly hooks: Hook[] = []

  register(hook: Hook): () => void {
    if (!hook.id || !hook.type || !hook.mode || !Number.isFinite(hook.priority)) {
      throw new Error('Invalid hook registration')
    }
    const expectedMode = hook.type === 'execute_tool'
      ? 'around'
      : hook.type === 'before_query' || hook.type === 'before_model_call' || hook.type === 'before_tool_call'
        ? 'waterfall'
        : 'observe'
    if (hook.mode !== expectedMode) throw new Error(`Hook '${hook.id}' must use ${expectedMode} mode for ${hook.type}`)
    this.hooks.push(hook)
    this.hooks.sort((a, b) => a.priority - b.priority)
    return () => {
      const index = this.hooks.indexOf(hook)
      if (index >= 0) this.hooks.splice(index, 1)
    }
  }

  clear(): void { this.hooks.length = 0 }

  async observe<T extends ObserveHookType>(type: T, ctx: HookContext<T>): Promise<void> {
    const listeners = this.hooks.filter((hook) => hook.type === type && hook.mode === 'observe')
    await Promise.all(listeners.map(async (hook) => {
      try { await (hook.handler as (ctx: HookContext<T>) => void | Promise<void>)(ctx) }
      catch (error) { ctx.onHookError?.(hook.id, error) }
    }))
  }

  async waterfall<T extends WaterfallHookType>(type: T, value: HookValue<T>, ctx: HookContext<T>): Promise<HookOutcome<HookValue<T>>> {
    let current = value
    const listeners = this.hooks.filter((hook) => hook.type === type && hook.mode === 'waterfall')
    for (const hook of listeners) {
      try {
        const outcome = await (hook.handler as (value: HookValue<T>, ctx: HookContext<T>) => Promise<HookOutcome<HookValue<T>>>)(current, ctx)
        if (outcome.action !== 'continue') return outcome
        current = outcome.value
      } catch (error) {
        ctx.onHookError?.(hook.id, error)
        return { action: 'abort', reason: `Hook '${hook.id}' failed` }
      }
    }
    return { action: 'continue', value: current }
  }

  async around<T>(type: 'execute_tool', ctx: ExecuteToolContext, terminal: () => Promise<T>): Promise<T> {
    const listeners = this.hooks.filter((hook) => hook.type === type && hook.mode === 'around')
    let next = terminal
    for (const hook of [...listeners].reverse()) {
      const downstream = next
      next = () => (hook.handler as (ctx: ExecuteToolContext, next: () => Promise<unknown>) => Promise<unknown>)(ctx, downstream) as Promise<T>
    }
    return next()
  }
}
