import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '@/stores/chat-store'

type MockConversationRecord = {
  type: 'conversation.snapshot'
  ts: string
  conversation: {
    id: string
    title: string
    createdAt: number
    workspaceRoot?: string
    messages: Array<{ id: string; role: 'user' | 'assistant'; content: string }>
  }
  artifacts: unknown[]
}

const { appendWorkspaceRecord, listWorkspaceDir, readWorkspaceRecords } = vi.hoisted(() => ({
  appendWorkspaceRecord: vi.fn(async (_root: string, _category: string, _recordId: string, _record: unknown) => undefined),
  listWorkspaceDir: vi.fn(async () => [{ path: '.solidify/conversations/conv-1.chat.jsonl', name: 'conv-1.chat.jsonl', kind: 'file', size: 1 }]),
  readWorkspaceRecords: vi.fn(async (): Promise<MockConversationRecord[]> => [{
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
    expect(useChatStore.getState().conversations[0]?.workspaceRoot).toBe('/workspace')
  })

  it('rebinds a moved workspace snapshot to its current canonical root', async () => {
    readWorkspaceRecords.mockResolvedValueOnce([{
      type: 'conversation.snapshot',
      ts: '2026-08-14T00:00:00Z',
      conversation: {
        id: 'conv-moved', title: '已移动会话', createdAt: 1, workspaceRoot: '/old/location',
        messages: [{ id: 'msg-moved', role: 'user', content: 'hello' }],
      },
      artifacts: [],
    }])

    await restoreWorkspaceConversations('/new/location')

    expect(useChatStore.getState().conversations[0]).toMatchObject({
      id: 'conv-moved',
      workspaceRoot: '/new/location',
    })
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
    expect(useChatStore.getState().conversations[0].workspaceRoot).toBe('/empty-workspace')
    expect(useChatStore.getState().activeConversationId).toBe('previous')
  })

  it('does not expose another workspace task when the opened workspace owns none', async () => {
    useChatStore.setState({
      conversations: [{
        id: 'other', title: '其他工作区任务', createdAt: 1, workspaceRoot: '/other',
        messages: [{ id: 'other-message', role: 'assistant', content: 'private' }],
      }],
      artifacts: [{
        id: 'other-artifact', title: '其他工作区产物', type: 'document', content: 'private',
        messageId: 'other-message', version: 1,
      }],
      activeConversationId: 'other',
      activeArtifactId: 'other-artifact',
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
    useChatStore.setState({ conversations: [{ id: 'conv-2', title: '新会话', createdAt: 2, messages: [], workspaceRoot: '/workspace' }] })
    const stop = startWorkspaceConversationPersistence('/workspace')
    await vi.advanceTimersByTimeAsync(300)
    expect(appendWorkspaceRecord).toHaveBeenCalledOnce()
    useChatStore.setState({ activeConversationId: 'conv-2' })
    await vi.advanceTimersByTimeAsync(300)
    expect(appendWorkspaceRecord).toHaveBeenCalledOnce()
    await stop()
  })

  it('flushes a pending conversation before the workspace closes', async () => {
    useChatStore.setState({ conversations: [{ id: 'conv-3', title: '待刷盘', createdAt: 3, messages: [], workspaceRoot: '/workspace' }] })
    const stop = startWorkspaceConversationPersistence('/workspace')
    await stop()
    expect(appendWorkspaceRecord).toHaveBeenCalledOnce()
  })

  it('tombstones a deleted conversation so it does not reappear on reopen', async () => {
    useChatStore.setState({ conversations: [{ id: 'conv-4', title: '将被删除', createdAt: 4, messages: [], workspaceRoot: '/workspace' }] })
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

  it('tombstones a conversation deleted before the first scheduled snapshot', async () => {
    useChatStore.setState({ conversations: [{ id: 'conv-fast-delete', title: '立即删除', createdAt: 4, messages: [], workspaceRoot: '/workspace' }] })
    const stop = startWorkspaceConversationPersistence('/workspace')

    useChatStore.setState({ conversations: [] })
    await vi.advanceTimersByTimeAsync(300)
    await stop()

    const tombstone = appendWorkspaceRecord.mock.calls.find(
      ([, , , record]) => (record as { type?: string })?.type === 'conversation.deleted',
    )
    expect(tombstone).toBeDefined()
    expect((tombstone?.[3] as { id: string }).id).toBe('conv-fast-delete')
  })

  it('does not persist per-run event traces into the conversation record', async () => {
    useChatStore.setState({
      conversations: [{
        id: 'conv-5', title: '含事件流', createdAt: 5, workspaceRoot: '/workspace',
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

  it('does not duplicate completed raw agent output in workspace snapshots', async () => {
    useChatStore.setState({
      conversations: [{
        id: 'conv-6', title: '完成运行', createdAt: 6, workspaceRoot: '/workspace',
        messages: [{
          id: 'm6', role: 'assistant', content: 'clean result',
          agentRun: { runId: 'run-6', status: 'completed', text: 'x'.repeat(50_000), tools: [], startedAt: 1 },
        }],
      }],
    })
    const stop = startWorkspaceConversationPersistence('/workspace')
    await vi.advanceTimersByTimeAsync(300)
    await stop()

    const written = JSON.stringify(appendWorkspaceRecord.mock.calls.at(-1)?.[3])
    expect(written).toContain('"text":""')
    expect(written).not.toContain('x'.repeat(1_000))
  })

  it('never writes a conversation owned by another workspace', async () => {
    useChatStore.setState({
      conversations: [
        { id: 'current', title: '当前项目', createdAt: 1, messages: [], workspaceRoot: '/workspace' },
        { id: 'other', title: '其他项目', createdAt: 2, messages: [], workspaceRoot: '/other' },
      ],
    })

    const stop = startWorkspaceConversationPersistence('/workspace')
    await vi.advanceTimersByTimeAsync(300)
    await stop()

    const written = appendWorkspaceRecord.mock.calls
      .filter(([, , , record]) => (record as { type?: string })?.type === 'conversation.snapshot')
      .map(([, , , record]) => JSON.stringify(record))
    expect(written.some((record) => record.includes('当前项目'))).toBe(true)
    expect(written.some((record) => record.includes('其他项目'))).toBe(false)
  })
})
