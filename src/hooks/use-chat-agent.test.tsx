import type { PropsWithChildren } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChat } from './use-chat'
import { useChatStore } from '@/stores/chat-store'
import { useModelStore } from '@/stores/model-store'
import { useKnowledgeEnhancementStore } from '@/stores/knowledge-store'

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
    expect(assistant?.runEvents).toHaveLength(4)
    expect(assistant?.agentRun?.usage?.totalTokens).toBe(5)
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
})
