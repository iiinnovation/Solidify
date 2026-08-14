import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '@/stores/chat-store'

const { appendWorkspaceRecord, listWorkspaceDir, readWorkspaceRecords } = vi.hoisted(() => ({
  appendWorkspaceRecord: vi.fn(async () => undefined),
  listWorkspaceDir: vi.fn(async () => [{ path: '.solidify/conversations/conv-1.chat.jsonl', name: 'conv-1.chat.jsonl', kind: 'file', size: 1 }]),
  readWorkspaceRecords: vi.fn(async () => [{
    type: 'conversation.snapshot',
    ts: '2026-08-14T00:00:00Z',
    conversation: { id: 'conv-1', title: '本地会话', createdAt: 1, messages: [{ id: 'msg-1', role: 'user', content: 'hello' }] },
    artifacts: [],
  }]),
}))

vi.mock('@/lib/tauri', () => ({
  appendWorkspaceRecord,
  listWorkspaceDir,
  readWorkspaceRecords,
}))

import { restoreWorkspaceConversations, startWorkspaceConversationPersistence } from './persistence'

describe('M3 workspace conversation persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    appendWorkspaceRecord.mockClear()
    listWorkspaceDir.mockClear()
    listWorkspaceDir.mockResolvedValue([{ path: '.solidify/conversations/conv-1.chat.jsonl', name: 'conv-1.chat.jsonl', kind: 'file', size: 1 }])
    useChatStore.setState({ conversations: [], artifacts: [], activeConversationId: null, activeArtifactId: null })
  })

  afterEach(() => vi.useRealTimers())

  it('restores the latest local JSONL projection', async () => {
    await restoreWorkspaceConversations('/workspace')
    expect(useChatStore.getState().conversations[0]?.title).toBe('本地会话')
  })

  it('clears conversations when opening an empty workspace', async () => {
    useChatStore.setState({
      conversations: [{ id: 'previous', title: '其他项目', createdAt: 1, messages: [] }],
      activeConversationId: 'previous',
    })
    listWorkspaceDir.mockResolvedValueOnce([])
    await restoreWorkspaceConversations('/empty-workspace')
    expect(useChatStore.getState()).toMatchObject({
      conversations: [],
      artifacts: [],
      activeConversationId: null,
      activeArtifactId: null,
    })
  })

  it('appends changed conversations without rewriting unchanged state', async () => {
    useChatStore.setState({ conversations: [{ id: 'conv-2', title: '新会话', createdAt: 2, messages: [] }] })
    const stop = startWorkspaceConversationPersistence('/workspace')
    await vi.advanceTimersByTimeAsync(300)
    expect(appendWorkspaceRecord).toHaveBeenCalledOnce()
    useChatStore.setState({ activeConversationId: 'conv-2' })
    await vi.advanceTimersByTimeAsync(300)
    expect(appendWorkspaceRecord).toHaveBeenCalledOnce()
    await stop()
  })

  it('flushes a pending conversation before the workspace closes', async () => {
    useChatStore.setState({ conversations: [{ id: 'conv-3', title: '待刷盘', createdAt: 3, messages: [] }] })
    const stop = startWorkspaceConversationPersistence('/workspace')
    await stop()
    expect(appendWorkspaceRecord).toHaveBeenCalledOnce()
  })
})
