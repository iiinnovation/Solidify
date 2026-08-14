import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '@/stores/chat-store'

const { appendWorkspaceRecord, listWorkspaceDir, readWorkspaceRecords } = vi.hoisted(() => ({
  appendWorkspaceRecord: vi.fn(async (_root: string, _category: string, _recordId: string, _record: unknown) => undefined),
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

  it('carries existing conversations over into a workspace that owns none', async () => {
    // The chat store is persisted to localStorage, so replacing it with an empty
    // set here would irreversibly destroy history accumulated in cloud mode.
    // An empty workspace adopts what is already open instead of clearing it.
    useChatStore.setState({
      conversations: [{ id: 'previous', title: '其他项目', createdAt: 1, messages: [] }],
      activeConversationId: 'previous',
    })
    listWorkspaceDir.mockResolvedValueOnce([])
    await restoreWorkspaceConversations('/empty-workspace')
    expect(useChatStore.getState().conversations).toHaveLength(1)
    expect(useChatStore.getState().conversations[0].id).toBe('previous')
    expect(useChatStore.getState().activeConversationId).toBe('previous')
  })

  it('adopts the workspace conversations when the workspace owns some', async () => {
    useChatStore.setState({
      conversations: [{ id: 'previous', title: '其他项目', createdAt: 1, messages: [] }],
      activeConversationId: 'previous',
    })
    await restoreWorkspaceConversations('/workspace')
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(['conv-1'])
    expect(useChatStore.getState().activeConversationId).toBe('conv-1')
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

  it('tombstones a deleted conversation so it does not reappear on reopen', async () => {
    useChatStore.setState({ conversations: [{ id: 'conv-4', title: '将被删除', createdAt: 4, messages: [] }] })
    const stop = startWorkspaceConversationPersistence('/workspace')
    await vi.advanceTimersByTimeAsync(300)
    appendWorkspaceRecord.mockClear()

    useChatStore.setState({ conversations: [] })
    await vi.advanceTimersByTimeAsync(300)
    await stop()

    const tombstone = appendWorkspaceRecord.mock.calls.find(
      ([, , , record]) => (record as { type?: string })?.type === 'conversation.deleted',
    )
    expect(tombstone).toBeDefined()
    expect((tombstone?.[3] as { id: string }).id).toBe('conv-4')
  })

  it('does not persist per-run event traces into the conversation record', async () => {
    useChatStore.setState({
      conversations: [{
        id: 'conv-5', title: '含事件流', createdAt: 5,
        messages: [{ id: 'm1', role: 'assistant', content: 'hi', runEvents: [{ type: 'run.started', runId: 'r1' }] }],
      }],
    })
    const stop = startWorkspaceConversationPersistence('/workspace')
    await vi.advanceTimersByTimeAsync(300)
    await stop()

    const written = JSON.stringify(appendWorkspaceRecord.mock.calls.at(-1)?.[3])
    expect(written).not.toContain('runEvents')
    expect(written).toContain('含事件流')
  })
})
