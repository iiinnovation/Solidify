import type { PropsWithChildren } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  finishRun: vi.fn(),
  runQuery: vi.fn(),
}))

vi.mock('@/lib/harness/flags', () => ({
  isEnabled: (flag: string) => ['agentLoop', 'toolCalling', 'harness', 'localWorkspace', 'skillV2'].includes(flag),
  getFlags: () => ({
    agentLoop: true,
    toolCalling: true,
    harness: true,
    localWorkspace: true,
    workbenchV2: true,
    skillV2: true,
    pptdEngine: false,
    subAgents: false,
    stagedRuntime: true,
  }),
}))

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/tauri')>(),
  isTauri: true,
  sendNotification: vi.fn(),
}))

vi.mock('@/lib/folder-tasks', () => ({
  folderTaskClient: {
    get: mocks.getTask,
    finishRun: mocks.finishRun,
  },
  shouldAutoContinueFolderTask: (task: { status: string; progress: { pending: number; processing: number } }) =>
    ['awaiting_plan_confirmation', 'running'].includes(task.status)
      && task.progress.pending + task.progress.processing > 0,
}))

vi.mock('@/lib/engine/query', () => ({ runQuery: mocks.runQuery }))

vi.mock('@/lib/chat-api', () => ({
  createModelProviderFetch: () => undefined,
  getSystemPrompt: () => 'base prompt',
}))

import { useChat } from './use-chat'
import { finishChatRun, getActiveChatRun, resetChatRunsForTests, startChatRun } from '@/lib/chat-run-registry'
import { useChatStore } from '@/stores/chat-store'
import { useDocumentStore } from '@/stores/document-store'
import { useKnowledgeEnhancementStore } from '@/stores/knowledge-store'
import { useModelStore } from '@/stores/model-store'
import { useUIStore } from '@/stores/ui-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

function wrapper({ children }: PropsWithChildren) {
  return <MemoryRouter>{children}</MemoryRouter>
}

describe('useChat FolderTask automatic turns', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetChatRunsForTests()
    localStorage.clear()
    useChatStore.setState({ conversations: [], artifacts: [], activeArtifactId: null })
    useModelStore.setState({
      activeProviderId: 'provider-1',
      providers: [{
        id: 'provider-1',
        name: 'Test',
        apiUrl: 'https://example.com/v1/chat/completions',
        apiKey: 'test-key',
        modelId: 'test-model',
        format: 'openai',
        enabled: true,
        supportsTools: true,
      }],
    })
    useKnowledgeEnhancementStore.setState({ enabled: false })
    useWorkspaceStore.setState({ workspaceRoot: '/tmp/folder-task-root', project: null })
    useDocumentStore.setState({ documents: {}, activePath: null })
    useUIStore.setState({ composerDrafts: {}, pendingInput: null })
  })

  it('still dispatches the initial turn when empty-conversation hydration rerenders the hook', async () => {
    let resolveTask!: (task: unknown) => void
    const taskRead = new Promise((resolve) => { resolveTask = resolve })
    const runnableTask = {
      id: 'task-1',
      goal: '整理文档',
      status: 'awaiting_plan_confirmation',
      progress: { pending: 1, processing: 0 },
    }
    mocks.getTask.mockReturnValue(taskRead)
    mocks.finishRun.mockResolvedValue({
      ...runnableTask,
      status: 'reviewing',
      progress: { pending: 0, processing: 0 },
    })
    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'run-folder-task' }
      yield { type: 'message.completed', content: '已处理' }
      yield {
        type: 'run.completed',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, toolCalls: 0 },
      }
    })
    useChatStore.setState({
      conversations: [{
        id: 'conv-folder-task',
        title: '文档任务',
        createdAt: 1,
        messages: [],
        folderTaskId: 'task-1',
        folderTaskAutoRun: true,
        workspaceRoot: '/tmp/folder-task-root',
      }],
      artifacts: [],
      activeArtifactId: null,
    })

    renderHook(() => useChat('conv-folder-task'), { wrapper })

    // The first status read is cancelled by the hydration rerender. A second
    // effect must remain eligible instead of treating the turn as dispatched.
    await waitFor(() => expect(mocks.getTask.mock.calls.length).toBeGreaterThanOrEqual(2))
    await act(async () => { resolveTask(runnableTask) })

    await waitFor(() => expect(mocks.runQuery).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(useChatStore.getState().conversations[0].messages).toEqual([
      expect.objectContaining({ role: 'user', transcriptHidden: true }),
      expect.objectContaining({ role: 'assistant', content: '已处理' }),
    ]))
  })

  it('prepares the plan again when restarting a conversation with a failed prior turn', async () => {
    const task = { id: 'task-1', goal: '提取金额', status: 'awaiting_plan_confirmation', progress: { pending: 1, processing: 0 } }
    mocks.getTask.mockResolvedValue(task)
    mocks.finishRun.mockResolvedValue({ ...task, status: 'reviewing', progress: { pending: 0, processing: 0 } })
    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'restart-plan' }
      yield { type: 'message.completed', content: '已处理' }
      yield { type: 'run.completed', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, toolCalls: 0 } }
    })
    useChatStore.setState({ conversations: [{
      id: 'conv-restart', title: '文档任务', createdAt: 1,
      folderTaskId: 'task-1', folderTaskAutoRun: true, workspaceRoot: '/tmp/folder-task-root',
      messages: [{ id: 'failed-turn', role: 'assistant', content: '', agentRun: {
        runId: 'failed-run', status: 'failed', text: '', tools: [], startedAt: 1, error: 'Stream stalled',
      } }],
    }] })
    renderHook(() => useChat('conv-restart'), { wrapper })
    await waitFor(() => expect(mocks.runQuery).toHaveBeenCalledTimes(1))
    const messages = mocks.runQuery.mock.calls[0][0].messages as Array<{ role: string; content: unknown }>
    expect(messages.some((message) => message.role === 'user' && String(message.content).includes('prepare_folder_task_plan'))).toBe(true)
    await waitFor(() => expect(useChatStore.getState().conversations[0].messages.at(-1)?.agentRun?.status).toBe('completed'))
  })

  it('keeps an asynchronous automatic turn bound to its captured task conversation', async () => {
    mocks.finishRun.mockResolvedValue({
      id: 'task-1', goal: '整理文档', status: 'reviewing',
      progress: { pending: 0, processing: 0 },
    })
    mocks.runQuery.mockImplementation(async function* (context: { runId: string }) {
      expect(getActiveChatRun('conv-folder-task')?.workspaceRoot).toBe('/tmp/task-owned-root')
      yield { type: 'run.started', runId: context.runId }
      yield { type: 'message.completed', content: '已处理' }
      yield {
        type: 'run.completed',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, toolCalls: 0 },
      }
    })
    useChatStore.setState({
      conversations: [{
        id: 'conv-folder-task', title: '文档任务', createdAt: 1, messages: [],
        folderTaskId: 'task-1', workspaceRoot: '/tmp/task-owned-root',
      }],
      artifacts: [],
      activeArtifactId: null,
    })
    const { result } = renderHook(() => useChat(undefined), { wrapper })

    await act(async () => {
      await result.current.sendMessage(
        '继续当前文档任务',
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        { transcriptHidden: true, conversationId: 'conv-folder-task' },
      )
    })

    expect(useChatStore.getState().conversations).toHaveLength(1)
    expect(mocks.runQuery).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv-folder-task',
      folderTaskId: 'task-1',
      cwd: '/tmp/task-owned-root',
    }))
  })

  it('projects a backend run downgrade into the assistant terminal state', async () => {
    mocks.finishRun.mockImplementation(async (_taskId: string, runId: string) => ({
      id: 'task-1', goal: '整理文档', status: 'failed',
      progress: { pending: 1, processing: 0 },
      recentRuns: [{
        runId, taskId: 'task-1', status: 'failed',
        error: 'Agent run ended before checkpointing its active batch',
        startedAt: 1, updatedAt: 2, completedAt: 2,
      }],
    }))
    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'run-backend-failed' }
      yield { type: 'message.completed', content: '已处理' }
      yield {
        type: 'run.completed',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, toolCalls: 0 },
      }
    })
    useChatStore.setState({
      conversations: [{
        id: 'conv-folder-task', title: '文档任务', createdAt: 1, messages: [],
        folderTaskId: 'task-1', workspaceRoot: '/tmp/folder-task-root',
      }],
      artifacts: [],
      activeArtifactId: null,
    })
    const { result } = renderHook(() => useChat('conv-folder-task'), { wrapper })

    await act(async () => { await result.current.sendMessage('处理任务') })

    const assistant = useChatStore.getState().conversations[0].messages.at(-1)
    expect(assistant?.agentRun).toMatchObject({
      status: 'failed',
      error: 'Agent run ended before checkpointing its active batch',
    })
    expect(assistant?.runEvents?.at(-1)?.type).toBe('run.failed')
  })

  it('shows the durable terminal frame after a background-owned run leaves the registry', async () => {
    const runningMessage = {
      id: 'assistant-1', role: 'assistant' as const, content: '',
      agentRun: {
        runId: 'run-1', status: 'running' as const, text: '', tools: [], startedAt: 1,
        activity: { phase: 'generating' as const, label: '正在生成交付物…' },
      },
    }
    useChatStore.setState({
      conversations: [{
        id: 'conv-folder-task', title: '文档任务', createdAt: 1,
        messages: [runningMessage], folderTaskId: 'task-1', workspaceRoot: '/tmp/folder-task-root',
      }],
      artifacts: [],
      activeArtifactId: null,
    })
    const token = startChatRun({
      conversationId: 'conv-folder-task',
      workspaceRoot: '/tmp/folder-task-root',
      controller: new AbortController(),
      messages: [runningMessage],
    })!
    const { result } = renderHook(() => useChat('conv-folder-task'), { wrapper })
    expect(result.current.messages[0].agentRun?.status).toBe('running')

    act(() => {
      useChatStore.getState().patchMessageInConversation('conv-folder-task', 'assistant-1', {
        content: '已完成',
        agentRun: { ...runningMessage.agentRun, status: 'completed', activity: undefined, completedAt: 2 },
      })
      finishChatRun('conv-folder-task', token)
    })

    await waitFor(() => expect(result.current.messages[0]).toMatchObject({
      content: '已完成',
      agentRun: { status: 'completed' },
    }))
  })

  it('recovers an orphaned internal continuation prompt instead of waiting for user input', async () => {
    const runnableTask = {
      id: 'task-1',
      goal: '整理文档',
      status: 'running',
      progress: { pending: 1, processing: 0 },
    }
    mocks.getTask.mockResolvedValue(runnableTask)
    mocks.finishRun.mockResolvedValue({
      ...runnableTask,
      status: 'reviewing',
      progress: { pending: 0, processing: 0 },
    })
    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'run-recovered' }
      yield { type: 'message.completed', content: '续跑完成' }
      yield {
        type: 'run.completed',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, toolCalls: 0 },
      }
    })
    useChatStore.setState({
      conversations: [{
        id: 'conv-folder-task',
        title: '文档任务',
        createdAt: 1,
        messages: [{
          id: 'orphaned-continuation',
          role: 'user',
          content: '继续当前文档任务。',
          transcriptHidden: true,
        }],
        folderTaskId: 'task-1',
        folderTaskAutoRun: true,
        workspaceRoot: '/tmp/folder-task-root',
      }],
      artifacts: [],
      activeArtifactId: null,
    })

    renderHook(() => useChat('conv-folder-task'), { wrapper })

    await waitFor(() => expect(mocks.runQuery).toHaveBeenCalledTimes(1))
    const persisted = useChatStore.getState().conversations[0].messages
    expect(persisted.some((message) => message.id === 'orphaned-continuation')).toBe(false)
    expect(persisted).toEqual([
      expect.objectContaining({ role: 'user', transcriptHidden: true }),
      expect.objectContaining({ role: 'assistant', content: '续跑完成' }),
    ])
  })
})
