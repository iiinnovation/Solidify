import { StrictMode, type PropsWithChildren } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChat } from './use-chat'
import { useChatStore } from '@/stores/chat-store'
import { useModelStore } from '@/stores/model-store'
import { useKnowledgeEnhancementStore } from '@/stores/knowledge-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDocumentStore } from '@/stores/document-store'
import { composerDraftKey, useUIStore } from '@/stores/ui-store'
import { saveAttachmentMedia } from '@/lib/attachment-media'

const mocks = vi.hoisted(() => ({
  agentLoop: true,
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
  createModelProviderFetch: () => undefined,
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
    useDocumentStore.setState({ documents: {}, activePath: null })
    useUIStore.setState({ composerDrafts: {}, pendingInput: null })
  })

  it('publishes a new turn synchronously before asynchronous preparation finishes', async () => {
    let releaseRun: (() => void) | undefined
    const runGate = new Promise<void>((resolve) => { releaseRun = resolve })
    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'run-optimistic' }
      await runGate
      yield { type: 'message.delta', text: 'ready' }
      yield { type: 'message.completed', content: 'ready' }
      yield {
        type: 'run.completed',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, toolCalls: 0 },
      }
    })
    const { result, rerender } = renderHook(({ id }: { id?: string }) => useChat(id), {
      initialProps: { id: undefined as string | undefined },
      wrapper,
    })
    let request: Promise<void> | undefined
    let createdId = ''

    act(() => {
      request = result.current.sendMessage('立即显示这条消息')
      const created = useChatStore.getState().conversations[0]
      createdId = created.id
      expect(created.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
      expect(created.messages[0].content).toBe('立即显示这条消息')
    })
    expect(result.current.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    rerender({ id: createdId })
    await waitFor(() => expect(result.current.isStreaming).toBe(true))
    expect(result.current.messages.map((message) => message.role)).toEqual(['user', 'assistant'])

    releaseRun?.()
    await act(async () => { await request })
    expect(result.current.messages.at(-1)?.content).toBe('ready')
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

  it('publishes a PPTD preview during tool execution and finalizes the same artifact', async () => {
    const deck = `version: v2\ntitle: Preview deck\nsize: [960, 540]\ntheme: {colors: {bg: '#fff', text: '#111'}, textStyles: {}}\npages:\n  - elements: []\n`
    const envelope = `<solidify-artifact title="Preview deck" type="slides" path="03-交付物/deck.pptd">${deck}</solidify-artifact>`
    let finishRun: (() => void) | undefined
    const runGate = new Promise<void>((resolve) => { finishRun = resolve })
    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'run-pptd-preview' }
      yield { type: 'tool.requested', call: { id: 'generate-deck', name: 'generate_pptd', input: { brief: 'deck' } } }
      yield {
        type: 'tool.progress',
        callId: 'generate-deck',
        progress: {
          phase: 'pptd_assemble',
          current: 1,
          total: 1,
          message: '已装配 PPTD 工程，正在校验和修复',
          detail: {
            stage: 'assemble',
            current: 1,
            total: 1,
            message: '已装配 PPTD 工程，正在校验和修复',
            preview: {
              title: 'Preview deck',
              type: 'slides',
              path: '03-交付物/deck.pptd',
              content: deck,
              pageCount: 1,
            },
          },
        },
      }
      await runGate
      yield { type: 'tool.completed', callId: 'generate-deck', result: { success: true, content: 'generated' } }
      yield { type: 'message.delta', text: envelope }
      yield { type: 'message.completed', content: envelope }
      yield {
        type: 'run.completed',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, turns: 1, toolCalls: 1 },
      }
    })
    const { result } = renderHook(() => useChat(), { wrapper })

    let sendPromise: Promise<void> | undefined
    await act(async () => {
      sendPromise = result.current.sendMessage('create deck')
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => expect(useChatStore.getState().artifacts).toHaveLength(1))
    const preview = useChatStore.getState().artifacts[0]
    expect(preview).toMatchObject({ title: 'Preview deck', type: 'slides', content: deck, streaming: true })
    expect(result.current.messages.find((message) => message.role === 'assistant')?.agentRun?.tools[0].progressDetail)
      .not.toHaveProperty('preview')

    finishRun?.()
    await act(async () => { await sendPromise })

    expect(useChatStore.getState().artifacts).toHaveLength(1)
    expect(useChatStore.getState().artifacts[0]).toMatchObject({
      id: preview.id,
      title: 'Preview deck',
      content: deck.trim(),
      streaming: false,
    })
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

  it('removes an empty aborted assistant before starting the next request', async () => {
    useChatStore.setState({
      conversations: [{ id: 'conv-stop', title: 'Stop', createdAt: 1, messages: [] }],
      artifacts: [],
      activeArtifactId: null,
    })
    let callCount = 0
    let releaseSecondRun: (() => void) | undefined
    const secondRunGate = new Promise<void>((resolve) => { releaseSecondRun = resolve })
    mocks.runQuery.mockImplementation(async function* (context: { signal: AbortSignal }) {
      callCount++
      yield { type: 'run.started', runId: `run-${callCount}` }
      if (callCount === 1) {
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve()
          else context.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        yield { type: 'run.failed', error: { kind: 'aborted', message: 'Run was aborted by user' } }
        return
      }
      await secondRunGate
      yield { type: 'message.delta', text: 'second reply' }
      yield { type: 'message.completed', content: 'second reply' }
      yield {
        type: 'run.completed',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, toolCalls: 0 },
      }
    })

    const { result } = renderHook(() => useChat('conv-stop'), { wrapper })
    let firstRequest: Promise<void> | undefined
    await act(async () => {
      firstRequest = result.current.sendMessage('first prompt')
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.isStreaming).toBe(true))
    act(() => result.current.stopStreaming())
    await act(async () => { await firstRequest })
    await waitFor(() => expect(result.current.isStreaming).toBe(false))

    expect(result.current.messages.map((message) => message.role)).toEqual(['user'])
    expect(useChatStore.getState().conversations[0].messages.map((message) => message.role)).toEqual(['user'])

    let secondRequest: Promise<void> | undefined
    await act(async () => {
      secondRequest = result.current.sendMessage('second prompt')
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.isStreaming).toBe(true))
    expect(result.current.messages.map((message) => message.role)).toEqual(['user', 'user', 'assistant'])
    expect(result.current.messages.filter((message) => message.role === 'assistant' && !message.content)).toHaveLength(1)

    releaseSecondRun?.()
    await act(async () => { await secondRequest })
    await waitFor(() => expect(result.current.isStreaming).toBe(false))
    expect(result.current.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'second reply' })
  })

  it('keeps using the unified query runtime when Agent tools are switched off', async () => {
    mocks.agentLoop = false
    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'message.delta', text: 'plain reply' }
      yield { type: 'message.completed', content: 'plain reply' }
      yield { type: 'run.completed', usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4, turns: 1, toolCalls: 0 } }
    })
    const { result } = renderHook(() => useChat(), { wrapper })

    await act(async () => result.current.sendMessage('hello'))
    await waitFor(() => expect(result.current.isStreaming).toBe(false))
    expect(mocks.runQuery).toHaveBeenCalledOnce()
    expect(result.current.messages.at(-1)?.content).toBe('plain reply')
  })

  it('invalidates a running request and cleans related state when recalling a message', async () => {
    useChatStore.setState({
      conversations: [{
        id: 'conv-recall', title: 'Recall', createdAt: 1,
        messages: [
          { id: 'keep-user', role: 'user', content: 'keep' },
          { id: 'keep-assistant', role: 'assistant', content: 'keep response' },
        ],
      }],
      artifacts: [],
      activeArtifactId: null,
    })
    let releaseLateChunk: (() => void) | undefined
    const lateChunkGate = new Promise<void>((resolve) => { releaseLateChunk = resolve })
    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'run-recall' }
      await lateChunkGate
      yield { type: 'message.delta', text: '<solidify-artifact title="Late" type="document">late</solidify-artifact>' }
      yield { type: 'run.failed', error: { kind: 'aborted', message: 'aborted' } }
    })
    const { result } = renderHook(() => useChat('conv-recall'), { wrapper })

    let request: Promise<void> | undefined
    await act(async () => {
      request = result.current.sendMessage('recall this')
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.isStreaming).toBe(true))
    const userMessage = useChatStore.getState().conversations[0].messages.at(-2)
    const assistantMessage = useChatStore.getState().conversations[0].messages.at(-1)
    expect(userMessage?.role).toBe('user')
    expect(assistantMessage?.role).toBe('assistant')

    useChatStore.setState((state) => ({
      artifacts: [{ id: 'generated', title: 'Generated', type: 'document', content: 'content', messageId: assistantMessage!.id, version: 1 }],
      activeArtifactId: 'generated',
      conversations: state.conversations,
    }))
    useDocumentStore.setState({
      documents: { 'draft.md': { path: 'draft.md', title: 'Draft', type: 'document', content: 'content', streaming: true, messageId: assistantMessage!.id, version: 1 } },
      activePath: 'draft.md',
    })

    act(() => result.current.recallMessage(userMessage!.id))
    releaseLateChunk?.()
    await act(async () => { await request })

    expect(result.current.messages.map((message) => message.id)).toEqual(['keep-user', 'keep-assistant'])
    expect(useChatStore.getState().artifacts).toHaveLength(0)
    expect(useChatStore.getState().activeArtifactId).toBeNull()
    expect(useDocumentStore.getState().documents).toEqual({})
    expect(useUIStore.getState().composerDrafts[composerDraftKey('conv-recall')].input).toBe('recall this')
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

  it('persists attachment extracted text and restores it to composer draft on recall', async () => {
    useChatStore.setState({
      conversations: [{ id: 'conv-att-recall', title: 'Att recall', createdAt: 1, messages: [] }],
      artifacts: [],
      activeArtifactId: null,
    })

    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'run-att' }
      yield { type: 'message.completed', content: 'received attachment' }
      yield {
        type: 'run.completed',
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, turns: 1, toolCalls: 0 },
      }
    })

    const { result } = renderHook(() => useChat('conv-att-recall'), { wrapper })

    const testFile = new File(['# Document Heading\n\nDocument body content'], 'report.md', { type: 'text/markdown' })
    await act(async () => {
      await result.current.sendMessage('Please analyze this report', [{
        name: 'report.md',
        size: testFile.size,
        file: testFile,
      }])
    })

    const userMsg = useChatStore.getState().conversations[0].messages.find((m) => m.role === 'user')
    expect(userMsg).toBeDefined()
    expect(userMsg?.attachments).toHaveLength(1)
    expect(userMsg?.attachments?.[0]).toMatchObject({
      name: 'report.md',
      extractedText: '# Document Heading\n\nDocument body content',
      recoverable: true,
    })

    // Recall message
    act(() => {
      result.current.recallMessage(userMsg!.id)
    })

    const draft = useUIStore.getState().composerDrafts[composerDraftKey('conv-att-recall')]
    expect(draft).toBeDefined()
    expect(draft.input).toBe('Please analyze this report')
    expect(draft.attachments).toEqual([expect.objectContaining({
      name: 'report.md',
      size: testFile.size,
      extractedText: '# Document Heading\n\nDocument body content',
      mediaUrl: undefined,
      recoverable: true,
    })])
  })

  it('reuses recalled attachment extractedText and mediaUrl when re-sending', async () => {
    useChatStore.setState({
      conversations: [{ id: 'conv-att-resend', title: 'Att resend', createdAt: 1, messages: [] }],
      artifacts: [],
      activeArtifactId: null,
    })

    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'run-att-resend' }
      yield { type: 'message.completed', content: 'analysis done' }
      yield {
        type: 'run.completed',
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, turns: 1, toolCalls: 0 },
      }
    })

    const { result } = renderHook(() => useChat('conv-att-resend'), { wrapper })

    // Simulate sending with recalled attachment (no File object, only extractedText and mediaUrl)
    await act(async () => {
      await result.current.sendMessage('Re-analyzing with recalled attachment', [{
        name: 'recalled-image.png',
        size: 1024,
        extractedText: '[图片文件: recalled-image.png，需要 AI 视觉分析]',
        mediaUrl: 'data:image/png;base64,fakeimagedata',
      }])
    })

    expect(mocks.runQuery).toHaveBeenCalledOnce()
    const queryContext = mocks.runQuery.mock.calls[0][0]
    expect(queryContext.messages[0].content).toContain('<attachments>')
    expect(queryContext.messages[0].content).toContain('id: ')
    expect(queryContext.messages[0].content).not.toContain('## 附件内容')
    expect(queryContext.messages[0].content).toContain('[图片文件: recalled-image.png，需要 AI 视觉分析]')
    expect(Object.entries(queryContext.pptdMedia ?? {})).toEqual([
      [expect.stringMatching(/^media\/attachment-media-.*-recalled-image\.png$/), 'data:image/png;base64,fakeimagedata'],
    ])

    const savedUserMsg = useChatStore.getState().conversations[0].messages.find((m) => m.role === 'user')
    expect(savedUserMsg?.attachments?.[0]).toMatchObject({
      name: 'recalled-image.png',
      size: 1024,
      extractedText: '[图片文件: recalled-image.png，需要 AI 视觉分析]',
      mediaUrl: 'data:image/png;base64,fakeimagedata',
      recoverable: true,
      mediaId: expect.any(String),
    })
  })

  it('restores persisted image media by mediaId when re-sending', async () => {
    useChatStore.setState({
      conversations: [{ id: 'conv-media-id', title: 'Media id', createdAt: 1, messages: [] }],
      artifacts: [],
      activeArtifactId: null,
    })
    const mediaUrl = 'data:image/png;base64,persisted-image'
    const mediaId = await saveAttachmentMedia(mediaUrl)
    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'run-media-id' }
      yield { type: 'message.completed', content: 'done' }
      yield {
        type: 'run.completed',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, toolCalls: 0 },
      }
    })
    const { result } = renderHook(() => useChat('conv-media-id'), { wrapper })

    await act(async () => {
      await result.current.sendMessage('Reuse image', [{
        name: 'persisted.png',
        size: 1024,
        extractedText: '[图片文件: persisted.png，需要 AI 视觉分析]',
        mediaId,
        recoverable: true,
      }])
    })

    expect(Object.entries(mocks.runQuery.mock.calls[0][0].pptdMedia ?? {})).toEqual([
      [expect.stringMatching(/^media\/attachment-media-.*-persisted\.png$/), mediaUrl],
    ])
  })

  it('rejects an attachment whose original content is no longer recoverable', async () => {
    useChatStore.setState({
      conversations: [{ id: 'conv-unrecoverable', title: 'Unavailable', createdAt: 1, messages: [] }],
      artifacts: [],
      activeArtifactId: null,
    })
    const { result } = renderHook(() => useChat('conv-unrecoverable'), { wrapper })

    await act(async () => {
      await result.current.sendMessage('Analyze the old file', [{
        name: 'legacy.pdf',
        size: 2048,
        recoverable: false,
      }])
    })

    expect(result.current.error?.message).toContain('legacy.pdf')
    expect(mocks.runQuery).not.toHaveBeenCalled()
    expect(useChatStore.getState().conversations[0].messages).toEqual([])
  })

  it('regenerates once with the original assistant skill context', async () => {
    useChatStore.setState({
      conversations: [{
        id: 'conv-regenerate-skill',
        title: 'Regenerate skill',
        createdAt: 1,
        messages: [
          { id: 'user-skill', role: 'user', content: 'create a report', skill: { id: 'report', name: 'Report' } },
          {
            id: 'assistant-skill',
            role: 'assistant',
            content: 'first answer',
            agentContext: {
              providerId: 'provider-1',
              skillId: 'report',
              skillSystemPrompt: 'ORIGINAL REPORT INSTRUCTIONS',
              skillSkipConfirmation: true,
            },
          },
        ],
      }],
      artifacts: [],
      activeArtifactId: null,
    })
    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'run-regenerate-skill' }
      yield { type: 'message.completed', content: 'regenerated' }
      yield {
        type: 'run.completed',
        usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4, turns: 1, toolCalls: 0 },
      }
    })
    const { result } = renderHook(() => useChat('conv-regenerate-skill'), { wrapper })

    act(() => result.current.regenerate())

    await waitFor(() => expect(mocks.runQuery).toHaveBeenCalledOnce())
    await waitFor(() => expect(result.current.isStreaming).toBe(false))
    expect(mocks.runQuery.mock.calls[0][0].skill?.content).toContain('ORIGINAL REPORT INSTRUCTIONS')
  })
})
