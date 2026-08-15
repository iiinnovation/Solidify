import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RunControls } from './run-controls'
import { RunTimeline } from './run-timeline'
import { ConfirmDialog } from './confirm-dialog'
import type { RunState } from '@/lib/engine/run-state'
import { RunLedger } from '@/lib/harness/ledger'
import type { ApprovalRequest } from '@/lib/harness/approval'

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

  it('does not restart the elapsed timer for every streamed run object', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const running = { ...completedRun, status: 'running' as const, completedAt: undefined }
      const view = render(<RunTimeline run={running} />)
      for (let index = 0; index < 100; index++) {
        view.rerender(<RunTimeline run={{ ...running, text: `token-${index}` }} />)
      }

      expect(consoleError.mock.calls.flat().join(' ')).not.toContain('Maximum update depth exceeded')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('returns the selected answer from the approval dialog', async () => {
    const onAnswer = vi.fn()
    const request: ApprovalRequest = {
      requestId: 'approval-1',
      runId: 'run-1',
      callId: 'call-1',
      toolName: 'write_file',
      grantKey: 'write_file',
      reason: '写入文件需要确认。',
      prompt: {
        title: '确认写入文件',
        detail: '将写入 03-交付物/需求规格.md',
        options: [
          { label: '拒绝', decision: 'deny' },
          { label: '允许', decision: 'allow' },
        ],
      },
      signal: new AbortController().signal,
    }

    render(<ConfirmDialog request={request} onAnswer={onAnswer} />)
    expect(screen.getByRole('dialog', { name: '确认写入文件' })).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(onAnswer).toHaveBeenCalledWith('approval-1', 'deny')
  })

  it('shows the persisted ledger facts for a completed run', async () => {
    const ledger = new RunLedger(completedRun.runId)
    ledger.clear()
    ledger.append('run.started', { conversationId: 'conversation-1' })
    ledger.append('tool.requested', { callId: 'call-1', name: 'read_file', input: { path: 'notes.md' } })
    ledger.append('tool.completed', { callId: 'call-1', success: true, content: 'file contents' })
    ledger.append('run.completed', completedRun.usage)

    render(<RunTimeline run={completedRun} />)
    await userEvent.click(screen.getByRole('button', { name: /运行账本/ }))
    expect(screen.getByText('run.started')).not.toBeNull()
    expect(screen.getByText('tool.requested')).not.toBeNull()
    expect(screen.getByText('run.completed')).not.toBeNull()
    ledger.clear()
  })
})
