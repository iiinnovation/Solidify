import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProvider } from '@/stores/model-store'

vi.mock('@/lib/tauri', () => ({
  isTauri: true,
  appendWorkspaceSnapshot: vi.fn(async () => {}),
  clearWorkspaceSnapshot: vi.fn(async () => {}),
  readWorkspaceSnapshot: vi.fn(async () => null),
}))

vi.mock('@/lib/harness/flags', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/harness/flags')>()
  return {
    ...original,
    isEnabled: (flag: string) => flag === 'toolCalling',
    getFlags: () => ({
      agentLoop: true,
      toolCalling: true,
      harness: false,
      localWorkspace: false,
      skillV2: false,
      pptdEngine: false,
      subAgents: false,
    }),
  }
})

import { createChatQueryContext } from './chat-context'

const provider: ModelProvider = {
  id: 'test-provider',
  name: 'Test',
  apiUrl: 'https://example.com/v1/chat/completions',
  apiKey: 'test-key',
  modelId: 'test-model',
  format: 'openai',
  enabled: true,
}

function create(workspaceRoot?: string | null) {
  return createChatQueryContext({
    runId: 'run-1',
    conversationId: 'conversation-1',
    messages: [{ role: 'user', content: 'hello' }],
    provider,
    signal: new AbortController().signal,
    workspaceRoot,
  })
}

describe('chat Agent workspace context', () => {
  beforeEach(() => localStorage.clear())

  it('does not expose desktop file tools without an explicitly selected root', () => {
    const context = create()
    expect(context.cwd).toBe('/')
    expect(context.tools.map((tool) => tool.name)).toEqual(['capture_preview', 'read_handle'])
    expect(context.workspace).toBeUndefined()
  })

  it('binds desktop tools, snapshots and path checks to the selected root', () => {
    const context = create('/Users/test/workspace/')
    const names = context.tools.map((tool) => tool.name)

    expect(context.cwd).toBe('/Users/test/workspace')
    expect(names).toEqual(expect.arrayContaining([
      'list_dir', 'read_file', 'write_file', 'search_files', 'read_handle',
    ]))
    expect(context.workspace?.resolve('docs/readme.md'))
      .toBe('/Users/test/workspace/docs/readme.md')
    expect(context.workspace?.contains('../outside')).toBe(false)
    expect(context.workspace?.contains('/Users/test/workspace/docs/readme.md')).toBe(false)
    expect(context.settings?.workspaceRoot).toBe('/Users/test/workspace')
    expect(context.snapshots?.constructor.name).toBe('FileSnapshotStore')
  })

  it('passes the persisted tools capability to the model provider', () => {
    const context = createChatQueryContext({
      runId: 'run-text-only',
      conversationId: 'conversation-text-only',
      messages: [{ role: 'user', content: 'hello' }],
      provider: { ...provider, supportsTools: false },
      signal: new AbortController().signal,
      workspaceRoot: '/Users/test/workspace',
    })

    expect(context.providerRegistry.get('openai').metadata.supportsTools).toBe(false)
    expect(context.tools.length).toBeGreaterThan(0)
  })
})
