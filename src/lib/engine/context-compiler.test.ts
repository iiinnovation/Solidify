import { describe, expect, it } from 'vitest'
import { compileContext } from './context-compiler'
import type { QueryContext } from './types'
import { formatSkillIndex } from '../skills/registry'
import { compiledBuiltinSkills } from '../skills/generated/manifest'
import { formatInlineAttachments } from '../attachments/types'

function context(overrides: Partial<QueryContext> = {}): QueryContext {
  return {
    runId: 'run-compiler',
    conversationId: 'conversation-compiler',
    cwd: '/workspace',
    messages: [{ role: 'user', content: '完成任务' }],
    tools: [],
    memory: { store: async () => 'handle', retrieve: async () => null, search: async () => [], clear: async () => undefined },
    model: { provider: 'mock', model: 'mock-model', contextWindow: 10_000 },
    limits: { maxTurns: 3, maxTokens: 10_000, maxOutputTokens: 1_000, maxToolCalls: 3, toolTimeoutMs: 1_000 },
    signal: new AbortController().signal,
    providerRegistry: { get: () => undefined } as never,
    ...overrides,
  }
}

function skill(content: string): NonNullable<QueryContext['skill']> {
  return {
    metadata: { name: 'same-size', version: '1.0.0', description: 'test' },
    content,
    path: 'builtin://same-size/SKILL.md',
  }
}

describe('Context Compiler', () => {
  it('reports actual inline reduction without claiming full attachment text on a recovery turn', async () => {
    const attachment = { id: 'a', name: 'large.md', size: 80_000, text: '审计流程资料'.repeat(5000) }
    const ctx = context({ attachments: [attachment], attachmentMode: 'inline', model: { provider: 'mock', model: 'deepseek-flash', contextWindow: 128_000 },
      messages: [{ role: 'user', content: `绘制流程图${formatInlineAttachments([attachment])}` }] })
    const standard = await compileContext(ctx)
    const recovered = await compileContext({ ...ctx, inputMode: 'compact_recovery' })
    expect(standard.stats.inlineRecovery).toBeNull()
    expect(recovered.stats.inlineRecovery).toMatchObject({ budgetTokens: 6000, compactedEntries: 1 })
    expect(recovered.stats.slots.attachmentTokens).toBeLessThan(standard.stats.slots.attachmentTokens / 2)
    expect(recovered.stats.historyTrimmed).toBe(true)
    expect(recovered.stats.rawHistoryTokens).toBe(standard.stats.rawHistoryTokens)
    expect(recovered.system).not.toContain('The full text')
    expect(recovered.system).not.toContain('Emit the single next tool call')
    expect(recovered.system).toContain('incomplete')
  })
  it('produces a stable prefix fingerprint and separates equal-sized Skill contents', async () => {
    const first = await compileContext(context({ skill: skill('AAAA') }))
    const second = await compileContext(context({ skill: skill('BBBB') }))

    expect(first.stats.fixedPrefixFingerprint).toMatch(/^ctx-/)
    expect(first.stats.fixedPrefixFingerprint).not.toBe(second.stats.fixedPrefixFingerprint)
    expect(first.stats.cacheable.system).toBe(true)
  })

  it('enforces the production budget before a provider request can be built', async () => {
    await expect(compileContext(context({ cwd: `/${'x'.repeat(7_000)}` })))
      .rejects.toThrow(/system prompt exceeds/)
  })

  it('budgets the no-Skill metadata index separately from the fixed system prompt', async () => {
    const index = formatSkillIndex(
      compiledBuiltinSkills.map((item) => item.metadata),
      undefined,
      { includePaths: false },
    )
    const compiled = await compileContext(context({
      harnessContext: [
        'Environment: cwd=/workspace; platform=web',
        index,
      ],
    }))

    expect(compiled.stats.skillIndexTokens).toBeGreaterThan(0)
    expect(compiled.stats.skillIndexTokens).toBeLessThan(600)
    expect(compiled.stats.slots.fixedSystemTokens).toBeLessThanOrEqual(800)
    expect(compiled.stats.slots.systemTokens).toBeGreaterThan(compiled.stats.slots.fixedSystemTokens)
    expect(compiled.system.split(index)).toHaveLength(2)
  })

  it('counts nested inline attachment text exactly once and keeps slots exclusive', async () => {
    const compiled = await compileContext(context({
      messages: [{
        role: 'user',
        content: '生成架构图\n<attachments_inline><attachment_full_text id="a">完整附件内容</attachment_full_text></attachments_inline>',
      }],
    }))

    const slots = compiled.stats.slots
    expect(slots.attachmentTokens).toBeGreaterThan(0)
    expect(slots.currentTaskTokens).toBeGreaterThan(0)
    expect(slots.historyTokens + slots.currentTaskTokens + slots.attachmentTokens)
      .toBe(compiled.stats.finalHistoryTokens)
  })
})
