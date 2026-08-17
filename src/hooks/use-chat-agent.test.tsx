import { StrictMode, type PropsWithChildren } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChat } from './use-chat'
import { useChatStore } from '@/stores/chat-store'
import { useModelStore } from '@/stores/model-store'
import { useKnowledgeEnhancementStore } from '@/stores/knowledge-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

const mocks = vi.hoisted(() => ({
  agentLoop: true,
  fetchChatStream: vi.fn(),
  runQuery: vi.fn(),
}))

vi.mock('@/lib/harness/flags', () => ({
  isEnabled: (flag: string) => flag === 'agentLoop' ? mocks.agentLoop : false,
  getFlags: () => ({
    agentLoop: mocks.agentLoop,
    toolCalling: false,
    harness: false,
    localWorkspace: false,
    skillV2: false,
    pptdEngine: false,
    subAgents: false,
  }),
}))

vi.mock('@/lib/engine/query', () => ({ runQuery: mocks.runQuery }))

vi.mock('@/lib/chat-api', () => ({
  compressMessages: (messages: unknown[]) => messages,
  fetchChatStream: mocks.fetchChatStream,
  getSystemPrompt: (skill?: string) => ['base prompt', skill].filter(Boolean).join('\n'),
}))

function wrapper({ children }: PropsWithChildren) {
  return <MemoryRouter>{children}</MemoryRouter>
}

function strictWrapper({ children }: PropsWithChildren) {
  return <StrictMode><MemoryRouter>{children}</MemoryRouter></StrictMode>
}

describe('useChat agent loop switch', () => {
  beforeEach(() => {
    mocks.agentLoop = true
    mocks.fetchChatStream.mockReset()
    mocks.runQuery.mockReset()
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
      }],
    })
    useKnowledgeEnhancementStore.setState({ enabled: false })
    useWorkspaceStore.setState({ workspaceRoot: null })
  })

  it('consumes runQuery events and saves them on the assistant message', async () => {
    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'run-test' }
      yield { type: 'message.delta', text: 'Agent reply' }
      yield { type: 'message.completed', content: 'Agent reply' }
      yield {
        type: 'run.completed',
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, turns: 1, toolCalls: 0 },
      }
    })
    const { result } = renderHook(() => useChat(), { wrapper })

    await act(async () => result.current.sendMessage('hello'))

    await waitFor(() => expect(result.current.isStreaming).toBe(false))
    expect(mocks.runQuery).toHaveBeenCalledOnce()
    expect(mocks.fetchChatStream).not.toHaveBeenCalled()
    const assistant = result.current.messages.find((message) => message.role === 'assistant')
    expect(assistant?.content).toBe('Agent reply')
    // Deltas are transient UI signal and are deliberately not persisted onto the
    // message — run.started / message.completed / run.completed are the run facts.
    expect(assistant?.runEvents).toHaveLength(3)
    expect(assistant?.runEvents?.some((event) => event.type === 'message.delta')).toBe(false)
    expect(assistant?.agentRun?.usage?.totalTokens).toBe(5)
  })

  it('flushes a trailing delta and materializes an artifact once', async () => {
    const artifact = '<solidify-artifact title="交付物" type="document">内容</solidify-artifact>'
    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'run-artifact' }
      yield { type: 'message.delta', text: artifact.slice(0, 35) }
      yield { type: 'message.delta', text: artifact.slice(35) }
      yield {
        type: 'run.completed',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, toolCalls: 0 },
      }
    })
    const { result } = renderHook(() => useChat(), { wrapper })

    await act(async () => result.current.sendMessage('create it'))
    await waitFor(() => expect(result.current.isStreaming).toBe(false))

    expect(result.current.messages.find((message) => message.role === 'assistant')?.content).toBe('')
    expect(useChatStore.getState().artifacts.filter((item) => item.title === '交付物')).toHaveLength(1)
  })

  it('flushes streamed deltas while the run is still open', async () => {
    vi.useFakeTimers()
    try {
      let releaseRun: (() => void) | undefined
      const runGate = new Promise<void>((resolve) => { releaseRun = resolve })
      mocks.runQuery.mockImplementation(async function* () {
        yield { type: 'run.started', runId: 'run-frame' }
        yield { type: 'message.delta', text: 'hello' }
        yield { type: 'message.delta', text: ' ' }
        yield { type: 'message.delta', text: 'world' }
        await runGate
        yield {
          type: 'run.completed',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, toolCalls: 0 },
        }
      })
      const { result } = renderHook(() => useChat(), { wrapper })

      let sendPromise: Promise<void>
      await act(async () => {
        sendPromise = result.current.sendMessage('stream')
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(result.current.messages.find((message) => message.role === 'assistant')?.content).toBe('')
      await act(async () => { await vi.advanceTimersByTimeAsync(59) })
      expect(result.current.messages.find((message) => message.role === 'assistant')?.content).toBe('')
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(result.current.messages.find((message) => message.role === 'assistant')?.content).toBe('hello world')

      releaseRun?.()
      await act(async () => { await sendPromise })
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts only one run when send is triggered twice before React rerenders', async () => {
    let finishRun: (() => void) | undefined
    const runGate = new Promise<void>((resolve) => { finishRun = resolve })
    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'run-once' }
      await runGate
      yield { type: 'message.completed', content: 'one reply' }
      yield {
        type: 'run.completed',
        usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4, turns: 1, toolCalls: 0 },
      }
    })
    const { result } = renderHook(() => useChat(), { wrapper })

    let firstSend: Promise<void> | undefined
    await act(async () => {
      firstSend = result.current.sendMessage('hello')
      await result.current.sendMessage('hello')
    })
    expect(mocks.runQuery).toHaveBeenCalledOnce()

    finishRun?.()
    await act(async () => { await firstSend })
    expect(result.current.messages).toHaveLength(2)
  })

  it('detaches a running stream when switching to a different conversation', async () => {
    useChatStore.setState({
      conversations: [
        { id: 'conv-a', title: 'A', createdAt: 1, messages: [] },
        { id: 'conv-b', title: 'B', createdAt: 2, messages: [] },
      ],
      artifacts: [],
      activeArtifactId: null,
    })
    let releaseRun: (() => void) | undefined
    const runGate = new Promise<void>((resolve) => { releaseRun = resolve })
    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'run-switch' }
      await runGate
      yield { type: 'message.delta', text: 'late old reply' }
      yield { type: 'message.completed', content: 'late old reply' }
      yield {
        type: 'run.completed',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, toolCalls: 0 },
      }
    })

    const { result, rerender } = renderHook(({ id }: { id: string }) => useChat(id), {
      initialProps: { id: 'conv-a' },
      wrapper,
    })
    let sendPromise: Promise<void> | undefined
    await act(async () => { sendPromise = result.current.sendMessage('start old run'); await Promise.resolve() })
    await waitFor(() => expect(result.current.isStreaming).toBe(true))

    rerender({ id: 'conv-b' })
    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false)
      expect(result.current.messages).toEqual([])
    })
    releaseRun?.()
    await act(async () => { await sendPromise })

    expect(result.current.messages).toEqual([])
    expect(useChatStore.getState().conversations.find((conversation) => conversation.id === 'conv-b')?.messages).toEqual([])
    expect(useChatStore.getState().conversations.find((conversation) => conversation.id === 'conv-a')?.messages.at(-1)?.agentRun)
      .toMatchObject({ status: 'aborted', error: '已切换到其他对话' })
  })

  it('keeps using the legacy stream when the switch is off', async () => {
    mocks.agentLoop = false
    mocks.fetchChatStream.mockResolvedValue(new Response('data: [DONE]\n\n', { status: 200 }))
    const { result } = renderHook(() => useChat(), { wrapper })

    await act(async () => result.current.sendMessage('hello'))

    await waitFor(() => expect(result.current.isStreaming).toBe(false))
    expect(mocks.fetchChatStream).toHaveBeenCalledOnce()
    expect(mocks.runQuery).not.toHaveBeenCalled()
  })

  it('resumes one persisted running Agent without duplicating messages', async () => {
    const startedAt = Date.now() - 1000
    useChatStore.setState({
      conversations: [{
        id: 'conv-resume',
        title: 'Resume',
        createdAt: startedAt,
        messages: [
          { id: 'user-1', role: 'user', content: 'inspect files' },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'partial text',
            agentRun: {
              runId: 'run-resume',
              status: 'running',
              text: 'partial text',
              tools: [],
              startedAt,
            },
            runEvents: [{ type: 'run.started', runId: 'run-resume' }],
            agentContext: {
              providerId: 'provider-1',
              workspaceRoot: '/saved/workspace',
              skillSystemPrompt: 'saved skill',
            },
          },
        ],
      }],
      artifacts: [],
      activeArtifactId: null,
    })
    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'run-resume' }
      yield { type: 'message.delta', text: 'resumed reply' }
      yield { type: 'message.completed', content: 'resumed reply' }
      yield {
        type: 'run.completed',
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, turns: 2, toolCalls: 1 },
      }
    })

    const { result, rerender } = renderHook(() => useChat('conv-resume'), { wrapper })

    await waitFor(() => expect(mocks.runQuery).toHaveBeenCalledOnce())
    await waitFor(() => expect(result.current.isStreaming).toBe(false))
    rerender()

    const context = mocks.runQuery.mock.calls[0][0]
    expect(context).toMatchObject({
      runId: 'run-resume',
      conversationId: 'conv-resume',
      restoreSnapshot: true,
      cwd: '/',
    })
    expect(context.messages).toEqual([
      { role: 'user', content: 'inspect files' },
    ])
    expect(context.settings.workspaceRoot).toBe('/')
    expect(mocks.runQuery).toHaveBeenCalledOnce()
    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[1]).toMatchObject({
      id: 'assistant-1',
      content: 'resumed reply',
      agentRun: { status: 'completed', text: 'resumed reply' },
    })
  })

  it('does not start duplicate recovery runs in React StrictMode', async () => {
    const startedAt = Date.now() - 1000
    useChatStore.setState({
      conversations: [{
        id: 'conv-strict-resume',
        title: 'Strict resume',
        createdAt: startedAt,
        messages: [
          { id: 'strict-user', role: 'user', content: 'continue once' },
          {
            id: 'strict-assistant',
            role: 'assistant',
            content: 'partial',
            agentRun: {
              runId: 'run-strict-resume',
              status: 'running',
              text: 'partial',
              tools: [],
              startedAt,
            },
            agentContext: { providerId: 'provider-1' },
          },
        ],
      }],
      artifacts: [],
      activeArtifactId: null,
    })
    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'run-strict-resume' }
      yield { type: 'message.completed', content: 'continued once' }
      yield {
        type: 'run.completed',
        usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4, turns: 1, toolCalls: 0 },
      }
    })

    const { result } = renderHook(() => useChat('conv-strict-resume'), {
      wrapper: strictWrapper,
    })

    await waitFor(() => expect(result.current.isStreaming).toBe(false))
    await waitFor(() => expect(mocks.runQuery).toHaveBeenCalledOnce())
    expect(result.current.messages).toHaveLength(2)
  })

  it('marks a persisted run failed when its Provider no longer exists', async () => {
    const startedAt = Date.now() - 1000
    useChatStore.setState({
      conversations: [{
        id: 'conv-missing-provider',
        title: 'Missing provider',
        createdAt: startedAt,
        messages: [
          { id: 'user-before-recovery', role: 'user', content: 'retry this task' },
          {
            id: 'assistant-missing-provider',
            role: 'assistant',
            content: 'partial',
            agentRun: {
              runId: 'run-missing-provider',
              status: 'running',
              text: 'partial',
              tools: [],
              startedAt,
            },
            agentContext: { providerId: 'deleted-provider' },
          },
        ],
      }],
      artifacts: [],
      activeArtifactId: null,
    })

    const { result } = renderHook(() => useChat('conv-missing-provider'), { wrapper })

    await waitFor(() => {
      expect(result.current.messages[1]?.agentRun).toMatchObject({
        status: 'failed',
        error: '无法恢复 Agent：原 Provider 已被删除',
      })
    })
    expect(result.current.error?.message).toBe('无法恢复 Agent：原 Provider 已被删除')
    expect(mocks.runQuery).not.toHaveBeenCalled()
    expect(useChatStore.getState().conversations[0].messages[1].agentRun?.status)
      .toBe('failed')
    expect(useChatStore.getState().conversations[0].messages[1].runEvents?.at(-1))
      .toMatchObject({ type: 'run.failed', error: { kind: 'internal' } })

    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'run-retry' }
      yield { type: 'message.completed', content: 'retry completed' }
      yield {
        type: 'run.completed',
        usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4, turns: 1, toolCalls: 0 },
      }
    })
    act(() => result.current.retry())

    await waitFor(() => expect(mocks.runQuery).toHaveBeenCalledOnce())
    await waitFor(() => expect(result.current.isStreaming).toBe(false))
    expect(mocks.runQuery.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: 'retry this task' },
    ])
    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[0]).toMatchObject({ role: 'user', content: 'retry this task' })
    expect(result.current.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'retry completed',
      agentRun: { status: 'completed' },
    })
  })
})
