import { type PropsWithChildren } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChat } from './use-chat'
import { useChatStore } from '@/stores/chat-store'
import { useModelStore } from '@/stores/model-store'
import { useKnowledgeEnhancementStore } from '@/stores/knowledge-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDocumentStore } from '@/stores/document-store'

const mocks = vi.hoisted(() => ({ runQuery: vi.fn() }))

const FILE_DOCUMENT_FLAGS = ['agentLoop', 'workbenchV2', 'localWorkspace']

vi.mock('@/lib/harness/flags', () => ({
  isEnabled: (flag: string) => FILE_DOCUMENT_FLAGS.includes(flag),
  getFlags: () => ({
    agentLoop: true, toolCalling: false, harness: false, localWorkspace: true,
    workbenchV2: true, skillV2: false, pptdEngine: false, subAgents: false,
  }),
}))

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauri: true,
  sendNotification: vi.fn(),
}))

vi.mock('@/lib/engine/query', () => ({ runQuery: mocks.runQuery }))

vi.mock('@/lib/chat-api', () => ({
  createModelProviderFetch: () => undefined,
  getSystemPrompt: () => 'base prompt',
}))

function wrapper({ children }: PropsWithChildren) {
  return <MemoryRouter>{children}</MemoryRouter>
}

/**
 * A deck streams in as an unclosed <solidify-artifact> until its final chunk.
 * Renderers show raw text while `streaming` is set and only parse the deck once
 * it clears, so a run that dies before the closing tag must still settle the
 * document — otherwise the artifact is stuck displaying its own source.
 */
describe('documents settle when a run ends without the closing tag', () => {
  const OPENING = '<solidify-artifact title="季度汇报" type="slides" path="03-交付物/deck.pptd">{"slides":[{"layout":"title",'

  beforeEach(() => {
    mocks.runQuery.mockReset()
    localStorage.clear()
    useChatStore.setState({ conversations: [], artifacts: [], activeArtifactId: null })
    useDocumentStore.setState({ documents: {}, activePath: null })
    useWorkspaceStore.setState({ workspaceRoot: '/workspace', entries: [] })
    useKnowledgeEnhancementStore.setState({ enabled: false })
    useModelStore.setState({
      activeProviderId: 'provider-1',
      providers: [{
        id: 'provider-1', name: 'Test', apiUrl: 'https://example.com/v1/chat/completions',
        apiKey: 'test-key', modelId: 'test-model', format: 'openai', enabled: true,
      }],
    })
  })

  async function runWith(final: Record<string, unknown>) {
    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'run-deck' }
      yield { type: 'message.delta', text: OPENING }
      yield final
    })
    const { result } = renderHook(() => useChat(), { wrapper })
    await act(async () => result.current.sendMessage('做一份季度汇报'))
    await waitFor(() => expect(result.current.isStreaming).toBe(false))
    return useDocumentStore.getState().documents['03-交付物/deck.pptd']
  }

  it('clears streaming when the output ceiling cuts the deck short', async () => {
    const document = await runWith({
      type: 'run.exhausted',
      reason: 'max_tokens',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, toolCalls: 0 },
    })
    expect(document).toBeDefined()
    expect(document?.streaming).toBe(false)
    expect(document?.content).toContain('"layout":"title"')
  })

  it('clears streaming when the run fails part way through', async () => {
    const document = await runWith({
      type: 'run.failed',
      error: { kind: 'network', message: 'connection reset' },
    })
    expect(document?.streaming).toBe(false)
  })

  it('publishes PPTD tool previews into the file document store and preserves the latest valid deck on failure', async () => {
    const firstDeck = `version: v2\ntitle: Preview deck\nsize: [960, 540]\ntheme: {colors: {bg: '#fff'}, textStyles: {}}\npages:\n  - elements: []\n`
    const secondDeck = firstDeck.replace('elements: []', 'pageType: content\n    elements: []')
    let releaseRun: (() => void) | undefined
    const runGate = new Promise<void>((resolve) => { releaseRun = resolve })
    mocks.runQuery.mockImplementation(async function* () {
      yield { type: 'run.started', runId: 'run-pptd-file-preview' }
      yield { type: 'tool.requested', call: { id: 'generate-deck', name: 'generate_pptd', input: { brief: 'deck' } } }
      for (const [current, content] of [[1, firstDeck], [2, secondDeck]] as const) {
        yield {
          type: 'tool.progress',
          callId: 'generate-deck',
          progress: {
            phase: 'pptd_page', current, total: 2, message: `已完成 ${current}/2 页`,
            detail: {
              stage: 'page', current, total: 2, message: `已完成 ${current}/2 页`,
              preview: {
                title: 'Preview deck', type: 'slides', path: '03-交付物/deck.pptd',
                content, pageCount: 2,
              },
            },
          },
        }
      }
      await runGate
      yield { type: 'run.failed', error: { kind: 'network', message: 'connection reset' } }
    })
    const { result } = renderHook(() => useChat(), { wrapper })

    let sendPromise: Promise<void> | undefined
    await act(async () => {
      sendPromise = result.current.sendMessage('生成 PPT')
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => expect(useDocumentStore.getState().documents['03-交付物/deck.pptd']?.content).toBe(secondDeck))
    expect(useDocumentStore.getState().documents['03-交付物/deck.pptd']).toMatchObject({
      title: 'Preview deck', type: 'slides', streaming: true, version: 1,
    })
    expect(useChatStore.getState().artifacts).toHaveLength(0)

    releaseRun?.()
    await act(async () => { await sendPromise })
    expect(useDocumentStore.getState().documents['03-交付物/deck.pptd']).toMatchObject({
      content: secondDeck, streaming: false,
    })
  })
})
