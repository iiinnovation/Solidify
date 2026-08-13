import type { QueryEvent, UsageStats } from './types'
import type { ToolCall, ToolResult } from '../tools/types'

export interface RunToolItem {
  call: ToolCall
  result?: ToolResult
  progress?: string
  status: 'requested' | 'running' | 'completed'
  startedAt: number
  completedAt?: number
}

export interface RunState {
  runId: string
  status: 'idle' | 'running' | 'completed' | 'aborted' | 'failed' | 'exhausted'
  text: string
  tools: RunToolItem[]
  usage?: UsageStats
  error?: string
  startedAt: number
  completedAt?: number
}

export function createRunState(runId: string): RunState {
  return { runId, status: 'running', text: '', tools: [], startedAt: Date.now() }
}

export function applyRunEvent(state: RunState, event: QueryEvent): RunState {
  switch (event.type) {
    case 'message.delta':
      return { ...state, text: state.text + event.text }
    case 'message.completed':
      return state.text ? state : { ...state, text: event.content }
    case 'tool.requested':
      return {
        ...state,
        tools: [...state.tools, { call: event.call, status: 'requested', startedAt: Date.now() }],
      }
    case 'tool.progress':
      return {
        ...state,
        tools: state.tools.map((item) => item.call.id === event.callId
          ? { ...item, status: 'running', progress: event.progress.message ?? event.progress.phase }
          : item),
      }
    case 'tool.completed':
      return {
        ...state,
        tools: state.tools.map((item) => item.call.id === event.callId
          ? { ...item, status: 'completed', result: event.result, completedAt: Date.now() }
          : item),
      }
    case 'run.completed':
      return { ...state, status: 'completed', usage: event.usage, completedAt: Date.now() }
    case 'run.failed':
      return { ...state, status: event.error.kind === 'aborted' ? 'aborted' : 'failed', error: event.error.message, completedAt: Date.now() }
    case 'run.exhausted':
      return { ...state, status: 'exhausted', error: exhaustedLabel(event.reason), completedAt: Date.now() }
    default:
      return state
  }
}

function exhaustedLabel(reason: Extract<QueryEvent, { type: 'run.exhausted' }>['reason']): string {
  if (reason === 'max_turns') return '已达到最大运行轮数'
  if (reason === 'max_tokens') return '已达到 token 上限'
  return '已达到工具调用上限'
}
