import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderTaskDetail } from '@/lib/folder-tasks/types'
import { projectFolderTaskChatStatus } from '@/lib/folder-tasks/chat-status'

const client = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@/lib/folder-tasks', () => ({ folderTaskClient: client }))

import { FolderTaskChatStatus } from './folder-task-chat-status'

function task(overrides: Partial<FolderTaskDetail> = {}): FolderTaskDetail {
  return {
    id: 'task-1',
    name: '合同抽取',
    goal: '抽取合同信息',
    rootPath: '/documents',
    status: 'running',
    recipe: 'structured-extraction',
    inventory: {
      files: 5,
      directories: 0,
      totalBytes: 100,
      readableFiles: 5,
      attentionFiles: 0,
      topLevelGroups: 1,
      extensionCounts: { pdf: 5 },
      fingerprint: 'inventory-1',
      truncated: false,
      truncationReasons: [],
      warnings: [],
    },
    progress: {
      pending: 2,
      processing: 1,
      completed: 2,
      skipped: 0,
      failed: 0,
      pendingDecision: 0,
      manualReview: 0,
      awaitingExternalParser: 0,
    },
    pendingDecisions: 0,
    createdAt: 1,
    updatedAt: 2,
    revision: 3,
    plan: {} as FolderTaskDetail['plan'],
    decisions: [],
    recentEvents: [],
    recentRuns: [],
    ...overrides,
  }
}

describe('folder task chat status', () => {
  beforeEach(() => vi.clearAllMocks())

  afterEach(() => {
    vi.useRealTimers()
  })

  it('projects conversational next actions for each interactive state', () => {
    expect(projectFolderTaskChatStatus(task({ status: 'awaiting_plan_confirmation' })).title)
      .toBe('AI 正在整理处理方案')
    expect(projectFolderTaskChatStatus(task({ status: 'awaiting_decision' })).detail)
      .toContain('直接回复上一个问题')
    expect(projectFolderTaskChatStatus(task({ status: 'reviewing' })).detail)
      .toContain('结果没问题，完成任务')
  })

  it('keeps output and technical file state distinct', () => {
    const view = projectFolderTaskChatStatus(task({
      status: 'completed',
      inventory: { ...task().inventory, attentionFiles: 1 },
      progress: { ...task().progress, pending: 0, processing: 0, completed: 4, skipped: 1 },
      latestOutput: {
        format: 'xlsx',
        relativePath: 'output/result.xlsx',
        contentHash: 'hash',
        itemCount: 4,
        createdAt: 10,
        resultRevision: 4,
        isCurrent: true,
      },
    }))

    expect(view.detail).toContain('output/result.xlsx')
    expect(view.technicalNote).toContain('不支持解析')
    expect(view.technicalNote).not.toContain('审核')
  })

  it('refreshes the persisted task state and opens details on demand', async () => {
    const onOpen = vi.fn()
    client.get.mockResolvedValue(task({ status: 'awaiting_decision' }))

    render(<FolderTaskChatStatus taskId="task-1" onOpen={onOpen} />)
    expect(await screen.findByText('等待你在对话中补充信息')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '打开文档任务详情' }))
    expect(client.get).toHaveBeenCalledWith('task-1')
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('stops polling after the chat status leaves the page', async () => {
    vi.useFakeTimers()
    client.get.mockResolvedValue(task())

    const view = render(<FolderTaskChatStatus taskId="task-1" onOpen={() => undefined} />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(client.get).toHaveBeenCalledOnce()

    view.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(client.get).toHaveBeenCalledOnce()
  })

  it('marks previously loaded status as stale when a refresh fails', async () => {
    vi.useFakeTimers()
    client.get.mockResolvedValueOnce(task()).mockRejectedValueOnce(new Error('database busy'))

    render(<FolderTaskChatStatus taskId="task-1" onOpen={() => undefined} />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(1_500)
    })

    expect(screen.getByText('任务状态同步中断')).not.toBeNull()
    expect(screen.getByText(/当前显示可能已过期/)).not.toBeNull()
  })
})
