import { describe, expect, it, vi } from 'vitest'
import { applyRunEvent, createRunState } from './run-state'

describe('run state reducer', () => {
  it('reduces text, tool progress, result, usage and completion', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(110).mockReturnValueOnce(125).mockReturnValueOnce(140)
    let state = createRunState('run-1')
    state = applyRunEvent(state, { type: 'message.delta', text: 'hello' })
    state = applyRunEvent(state, {
      type: 'tool.requested',
      call: { id: 'call-1', name: 'read_file', input: { path: 'a.md' } },
    })
    state = applyRunEvent(state, {
      type: 'tool.progress',
      callId: 'call-1',
      progress: { phase: 'reading', current: 1, message: '读取中' },
    })
    state = applyRunEvent(state, {
      type: 'tool.completed',
      callId: 'call-1',
      result: { success: true, content: 'done' },
    })
    state = applyRunEvent(state, {
      type: 'run.completed',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, turns: 1, toolCalls: 1 },
    })

    expect(state.text).toBe('hello')
    expect(state.status).toBe('completed')
    expect(state.tools[0]).toMatchObject({ status: 'completed', progress: '读取中' })
    expect(state.usage?.totalTokens).toBe(15)
  })

  it('maps abort and exhaustion to terminal states', () => {
    const running = createRunState('run-2')
    expect(applyRunEvent(running, {
      type: 'run.failed',
      error: { kind: 'aborted', message: 'stopped' },
    }).status).toBe('aborted')
    expect(applyRunEvent(running, {
      type: 'run.exhausted',
      reason: 'max_tool_calls',
    }).error).toBe('已达到工具调用上限')
  })

  it('records TTFT only after non-empty assistant output arrives', () => {
    let state = createRunState('run-ttft')
    state = applyRunEvent(state, { type: 'message.delta', text: '' })
    expect(state.firstTokenAt).toBeUndefined()

    state = applyRunEvent(state, { type: 'message.completed', content: 'complete response' })
    expect(state.firstTokenAt).toEqual(expect.any(Number))
  })
})
