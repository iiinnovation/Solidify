import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProvider } from '@/stores/model-store'

const featureFlags = vi.hoisted(() => ({ agentLoop: true, toolCalling: true, subAgents: false, skillV2: false }))

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
    isEnabled: (flag: string) => featureFlags[flag as keyof typeof featureFlags] ?? false,
    getFlags: () => ({
      agentLoop: featureFlags.agentLoop,
      toolCalling: featureFlags.toolCalling,
      harness: false,
      localWorkspace: false,
      skillV2: featureFlags.skillV2,
      pptdEngine: false,
      subAgents: featureFlags.subAgents,
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
  beforeEach(() => {
    localStorage.clear()
    featureFlags.agentLoop = true
    featureFlags.toolCalling = true
    featureFlags.subAgents = false
    featureFlags.skillV2 = false
  })

  it('keeps plain chat tool-free when subordinate tool flags are enabled independently', () => {
    featureFlags.agentLoop = false
    featureFlags.subAgents = true
    const context = createChatQueryContext({
      runId: 'run-plain',
      conversationId: 'conversation-plain',
      messages: [{ role: 'user', content: 'hello' }],
      provider,
      signal: new AbortController().signal,
      loadedSkill: {
        metadata: {
          name: 'pptd-deck', version: '1.0.0', description: 'deck', allowedTools: ['generate_pptd'],
        },
        content: 'Generate a deck.',
        path: 'builtin://pptd-deck/SKILL.md',
      },
    })

    expect(context.tools).toEqual([])
    expect(context.taskTree).toBeUndefined()
  })

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

  it('passes uploaded PPTD media through the per-run QueryContext', () => {
    const media = { 'media/attachment-01-chart.png': 'data:image/png;base64,iVBORw0KGgo=' }
    const context = createChatQueryContext({
      runId: 'run-media',
      conversationId: 'conversation-media',
      messages: [{ role: 'user', content: 'make a deck' }],
      provider,
      signal: new AbortController().signal,
      pptdMedia: media,
    })

    expect(context.pptdMedia).toBe(media)
  })

  it('exposes attachment readers to a Skill whose allowed-tools omits them', () => {
    // Reproduces the drawio-diagram run: no workspace, one attached document,
    // and a Skill that only declares [read_file, write_file].
    const context = createChatQueryContext({
      runId: 'run-attachment', conversationId: 'conversation', messages: [{ role: 'user', content: '根据文档绘制架构图' }],
      provider, signal: new AbortController().signal,
      loadedSkill: {
        metadata: { name: 'drawio-diagram', version: '1.0.0', description: '绘制流程图', allowedTools: ['read_file', 'write_file'] },
        content: '根据材料绘制流程图。',
        path: 'builtin://drawio-diagram/SKILL.md',
      },
      attachments: [{ id: 'att-1', name: '技术服务项目.docx', size: 77_600, text: '总体技术架构……' }],
    })

    expect(context.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'search_attachments', 'read_attachment',
    ]))
  })

  it('hides attachment readers when the run has no attachments', () => {
    const context = createChatQueryContext({
      runId: 'run-no-attachment', conversationId: 'conversation', messages: [{ role: 'user', content: 'hello' }],
      provider, signal: new AbortController().signal,
      loadedSkill: {
        metadata: { name: 'drawio-diagram', version: '1.0.0', description: '绘制流程图', allowedTools: ['read_file', 'write_file'] },
        content: '根据材料绘制流程图。',
        path: 'builtin://drawio-diagram/SKILL.md',
      },
    })

    const names = context.tools.map((tool) => tool.name)
    expect(names).not.toContain('search_attachments')
    expect(names).not.toContain('read_attachment')
  })

  it('treats unknown custom models as non-vision unless explicitly enabled', () => {
    const unknown = createChatQueryContext({
      runId: 'run-custom', conversationId: 'conversation', messages: [{ role: 'user', content: 'hello' }],
      provider: { ...provider, modelId: 'custom-text-model' }, signal: new AbortController().signal,
    })
    expect(unknown.providerRegistry.get('openai').metadata.supportsVision).toBe(false)

    const enabled = createChatQueryContext({
      runId: 'run-custom-vision', conversationId: 'conversation', messages: [{ role: 'user', content: 'hello' }],
      provider: { ...provider, modelId: 'custom-text-model', supportsVision: true }, signal: new AbortController().signal,
    })
    expect(enabled.providerRegistry.get('openai').metadata.supportsVision).toBe(true)
  })

  it('uses explicit provider context and output capabilities before model-name inference', () => {
    const context = createChatQueryContext({
      runId: 'run-explicit-limits', conversationId: 'conversation', messages: [{ role: 'user', content: 'hello' }],
      provider: { ...provider, modelId: 'unknown-proxy-model', contextWindow: 24_000, maxOutputTokens: 3_000 },
      signal: new AbortController().signal,
    })

    expect(context.model.contextWindow).toBe(24_000)
    expect(context.limits.maxOutputTokens).toBe(3_000)
    expect(context.model.maxTokens).toBe(3_000)
  })

  /**
   * A Skill contributes tools, not just prompt text. This pair is the reason
   * routing has to resolve before the context is built: a model that reads
   * SKILL.md mid-run could never obtain the tool the Skill depends on.
   */
  describe('Skill-gated tooling', () => {
    // Production ships skillV2 on; the legacy inline-prompt fallback would
    // otherwise synthesize a chat-skill and hide what routing actually changes.
    beforeEach(() => { featureFlags.skillV2 = true })

    const pptdSkill = {
      metadata: {
        name: 'pptd-deck', version: '2.0.0', description: 'deck', allowedTools: ['generate_pptd'],
      },
      content: 'Generate a deck.',
      path: 'builtin://pptd-deck/SKILL.md',
      virtualRoot: '.solidify/skills/pptd-deck',
    }

    it('attaches generate_pptd once a Skill is resolved for the run', () => {
      const context = createChatQueryContext({
        runId: 'run-routed',
        conversationId: 'conversation-routed',
        messages: [{ role: 'user', content: '做一份季度汇报' }],
        provider,
        signal: new AbortController().signal,
        loadedSkill: pptdSkill,
      })

      expect(context.tools.map((tool) => tool.name)).toContain('generate_pptd')
      expect(context.skill?.metadata.name).toBe('pptd-deck')
    })

    it('leaves generate_pptd unavailable when no Skill was selected or routed', () => {
      const context = createChatQueryContext({
        runId: 'run-unrouted',
        conversationId: 'conversation-unrouted',
        messages: [{ role: 'user', content: '做一份季度汇报' }],
        provider,
        signal: new AbortController().signal,
      })

      expect(context.tools.map((tool) => tool.name)).not.toContain('generate_pptd')
      expect(context.skill).toBeUndefined()
      // Without a resolved Skill there is no resource resolver either, so the
      // layer-0 index's "read the SKILL.md" instruction has nothing to read.
      expect(context.skillResources).toBeUndefined()
    })
  })
})
