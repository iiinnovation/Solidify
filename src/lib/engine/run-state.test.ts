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

  it('records TTFT when tool is requested without preceding text', () => {
    let state = createRunState('run-ttft-tool')
    expect(state.firstTokenAt).toBeUndefined()

    state = applyRunEvent(state, {
      type: 'tool.requested',
      call: { id: 'call-1', name: 'read_file', input: {} },
    })
    expect(state.firstTokenAt).toEqual(expect.any(Number))
  })

  it('charges concurrent tools once instead of once per call', () => {
    // Three read-only tools run in parallel for 1s inside a 2s run. Summing
    // their durations would subtract 3s from the 2s window, clamp it to zero
    // and drop the rate entirely; merging the overlap leaves 1s of generation.
    const now = 10_000
    vi.spyOn(Date, 'now').mockReturnValue(now + 2_000)
    const state = {
      runId: 'run-parallel',
      status: 'running' as const,
      text: '',
      startedAt: now,
      firstTokenAt: now,
      subAgents: [],
      tools: ['a', 'b', 'c'].map((name) => ({
        call: { id: `call-${name}`, name, input: {} },
        status: 'completed' as const,
        startedAt: now,
        completedAt: now + 1_000,
      })),
    }

    const completed = applyRunEvent(state, {
      type: 'run.completed',
      usage: { inputTokens: 10, outputTokens: 100, totalTokens: 110, turns: 1, toolCalls: 3 },
    })

    // 2s window - 1s of merged tool time = 1s of generation for 100 tokens.
    expect(completed.metrics?.tokensPerSecond).toBe(100)
    vi.restoreAllMocks()
  })
})
