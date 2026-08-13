import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RunControls } from './run-controls'
import { RunTimeline } from './run-timeline'
import type { RunState } from '@/lib/engine/run-state'

const completedRun: RunState = {
  runId: 'run-1',
  status: 'completed',
  text: 'done',
  startedAt: 100,
  completedAt: 145,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, turns: 1, toolCalls: 1 },
  tools: [{
    call: { id: 'call-1', name: 'read_file', input: { path: 'notes.md' } },
    status: 'completed',
    startedAt: 110,
    completedAt: 130,
    result: { success: true, content: 'file contents' },
  }],
}

describe('agent run UI', () => {
  it('shows usage and expands tool details', async () => {
    render(<RunTimeline run={completedRun} />)
    expect(screen.getByText('15 tokens')).not.toBeNull()
    expect(screen.getByText('45ms')).not.toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /read_file/ }))
    expect(screen.getByText('file contents')).not.toBeNull()
    expect(screen.getByText(/notes.md/)).not.toBeNull()
  })

  it('only exposes stop control for a running run', async () => {
    const onStop = vi.fn()
    const { rerender } = render(
      <RunControls run={{ ...completedRun, status: 'running', completedAt: undefined }} onStop={onStop} />,
    )
    await userEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(onStop).toHaveBeenCalledOnce()

    rerender(<RunControls run={completedRun} onStop={onStop} />)
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull()
  })
})
