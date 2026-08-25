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
import { createRunPlan } from './run-plan'
import { resolveCapabilityLease } from './capability-policy'

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

  it('ignores retired inline Skill prompts even when an old conversation carries one', () => {
    featureFlags.skillV2 = false
    const context = createChatQueryContext({
      runId: 'run-retired-inline',
      conversationId: 'conversation-retired-inline',
      messages: [{ role: 'user', content: 'hello' }],
      provider,
      signal: new AbortController().signal,
      skillSystemPrompt: 'RETIRED INLINE INSTRUCTIONS',
      skillSkipConfirmation: true,
    })

    expect(context.skill).toBeUndefined()
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

  it('keeps ordinary chat tool-free without an active capability', () => {
    const context = create()
    expect(context.cwd).toBe('/')
    expect(context.tools).toEqual([])
    expect(context.workspace).toBeUndefined()
  })

  it('does not inject discovery tools into an unselected canonical run', () => {
    featureFlags.skillV2 = true
    const context = createChatQueryContext({
      runId: 'run-discovery',
      conversationId: 'conversation-discovery',
      messages: [{ role: 'user', content: 'hello' }],
      provider,
      signal: new AbortController().signal,
      workspaceRoot: '/Users/test/workspace/',
      skillRegistry: { list: async () => [], resolve: async () => null } as never,
    })
    const names = context.tools.map((tool) => tool.name)
    expect(names).toEqual([])
  })

  it("binds a selected Skill's tools, snapshots and path checks to the selected root", () => {
    const context = createChatQueryContext({
      runId: 'run-workspace-skill',
      conversationId: 'conversation-workspace-skill',
      messages: [{ role: 'user', content: 'write a solution' }],
      provider,
      signal: new AbortController().signal,
      workspaceRoot: '/Users/test/workspace/',
      loadedSkill: {
        metadata: {
          name: 'solution-design', version: '1.0.0', description: 'solution',
          allowedTools: ['list_dir', 'read_file', 'write_file', 'search_files'],
        },
        content: 'Create a solution.',
        path: 'builtin://solution-design/SKILL.md',
      },
    })
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
      loadedSkill: {
        metadata: { name: 'solution-design', version: '1.0.0', description: 'solution', allowedTools: ['read_file'] },
        content: 'Create a solution.',
        path: 'builtin://solution-design/SKILL.md',
      },
    })

    expect(context.providerRegistry.get('openai').metadata.supportsTools).toBe(false)
    expect(context.tools).toEqual([])
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

  it('plans staged generation with zero tools for full-inline Draw.io', () => {
    const context = createChatQueryContext({
      runId: 'run-attachment', conversationId: 'conversation', messages: [{ role: 'user', content: '根据文档绘制架构图' }],
      provider, signal: new AbortController().signal,
      loadedSkill: {
        metadata: { name: 'drawio-diagram', version: '1.0.0', description: '绘制流程图', allowedTools: ['read_file', 'write_file'], deliverableContract: 'drawio' },
        content: '根据材料绘制流程图。',
        path: 'builtin://drawio-diagram/SKILL.md',
      },
      attachments: [{ id: 'att-1', name: '技术服务项目.docx', size: 77_600, text: '总体技术架构……' }],
      attachmentMode: 'inline',
    })

    expect(context.attachmentMode).toBe('inline')
    const plan = createRunPlan(context)
    expect(plan.mode).toBe('staged-delivery')
    expect(plan.initialPhase).toBe('generating')
    const lease = resolveCapabilityLease({ plan, phase: plan.initialPhase }, context.tools)
    expect(lease.tools).toEqual([])
    expect(lease.toolChoice).toBe('none')
  })

  it('hides attachment readers when the run has no attachments', () => {
    const context = createChatQueryContext({
      runId: 'run-no-attachment', conversationId: 'conversation', messages: [{ role: 'user', content: 'hello' }],
      provider, signal: new AbortController().signal,
      loadedSkill: {
        metadata: { name: 'drawio-diagram', version: '1.0.0', description: '绘制流程图', allowedTools: ['read_file', 'write_file'], deliverableContract: 'drawio' },
        content: '根据材料绘制流程图。',
        path: 'builtin://drawio-diagram/SKILL.md',
      },
    })

    const names = context.tools.map((tool) => tool.name)
    expect(names).not.toContain('search_attachments')
    expect(names).not.toContain('read_attachment')
    expect(names).not.toContain('prepare_attachment_evidence')
  })

  it('does not expose attachment readers when text extraction produced no readable body', () => {
    const context = createChatQueryContext({
      runId: 'run-unreadable-drawio', conversationId: 'conversation',
      messages: [{ role: 'user', content: '根据附件绘制架构图' }], provider,
      signal: new AbortController().signal,
      loadedSkill: {
        metadata: { name: 'drawio-diagram', version: '1.0.0', description: '绘制流程图', allowedTools: [], deliverableContract: 'drawio' },
        content: '根据材料绘制流程图。',
        path: 'builtin://drawio-diagram/SKILL.md',
      },
      attachments: [{ id: 'att-binary', name: 'scan.pdf', size: 77_600 }],
      attachmentMode: 'retrieval',
    })

    const names = context.tools.map((tool) => tool.name)
    expect(names).not.toContain('search_attachments')
    expect(names).not.toContain('read_attachment')
    expect(names).not.toContain('prepare_attachment_evidence')
  })

  it('keeps runtime Skill activation out of an unselected chat', () => {
    featureFlags.skillV2 = true
    const context = createChatQueryContext({
      runId: 'run-skill-activation', conversationId: 'conversation',
      messages: [{ role: 'user', content: '请选择合适的 Skill' }], provider,
      signal: new AbortController().signal,
      skillRegistry: { load: async () => { throw new Error('not used') }, list: async () => [], resolve: async () => null },
    })
    expect(context.tools).toEqual([])
  })

  it('limits an unskilled retrieval attachment run to attachment readers', () => {
    featureFlags.skillV2 = true
    featureFlags.subAgents = true
    const context = createChatQueryContext({
      runId: 'run-attachment-only', conversationId: 'conversation',
      messages: [{ role: 'user', content: '总结这个附件' }], provider,
      signal: new AbortController().signal,
      workspaceRoot: '/Users/test/workspace',
      attachments: [{ id: 'att-1', name: 'brief.md', size: 9_000, text: '正文' }],
      attachmentMode: 'retrieval',
    })

    expect(context.tools.map((tool) => tool.name).sort()).toEqual([
      'prepare_attachment_evidence',
      'read_attachment',
      'read_handle',
      'search_attachments',
    ])
  })

  it('sizes attachment read budgets from the total readable document length', () => {
    const text = '数'.repeat(70_000)
    const context = createChatQueryContext({
      runId: 'run-large-attachment', conversationId: 'conversation',
      messages: [{ role: 'user', content: '完整阅读附件' }], provider,
      signal: new AbortController().signal,
      attachments: [{ id: 'att-large', name: 'large.md', size: text.length, text }],
      attachmentMode: 'retrieval',
    })

    expect(context.limits.toolLoopBudgets?.['attachment-retrieval:read']?.maxCalls).toBe(9)
    expect(context.limits.toolLoopBudgets?.['attachment-retrieval']?.maxCalls).toBeGreaterThanOrEqual(13)
  })

  it('hides attachment readers when full text is already inline', () => {
    const context = createChatQueryContext({
      runId: 'run-inline-attachment', conversationId: 'conversation',
      messages: [{ role: 'user', content: '请完整阅读附件\n<attachments_inline>正文</attachments_inline>' }],
      provider, signal: new AbortController().signal,
      attachments: [{ id: 'att-1', name: 'brief.md', size: 6, text: '正文' }],
      attachmentMode: 'inline',
    })

    const names = context.tools.map((tool) => tool.name)
    expect(context.attachmentMode).toBe('inline')
    expect(names).not.toContain('search_attachments')
    expect(names).not.toContain('read_attachment')
    expect(names).not.toContain('prepare_attachment_evidence')
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
