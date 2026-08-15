import { describe, expect, it } from 'vitest'
import { buildMessages } from './messages'
import type { QueryContext } from './types'

function context(overrides: Partial<QueryContext> = {}): QueryContext {
  return {
    runId: 'run-1',
    conversationId: 'conversation-1',
    cwd: '/workspace',
    messages: [{ role: 'user', content: '请完成任务' }],
    tools: [],
    memory: { store: async () => 'handle', retrieve: async () => null, search: async () => [], clear: async () => undefined },
    model: { provider: 'anthropic', model: 'claude', contextWindow: 10_000 },
    limits: { maxTurns: 5, maxTokens: 10_000, maxOutputTokens: 1_000, maxToolCalls: 5, toolTimeoutMs: 1_000 },
    signal: new AbortController().signal,
    providerRegistry: { get: () => undefined } as never,
    ...overrides,
  }
}

describe('Skill progressive disclosure context', () => {
  it('does not inject a Skill body when no Skill is selected', async () => {
    const result = await buildMessages(context({
      harnessContext: ['可用的 Skill（需要详情时，用 read_file 读取对应的 SKILL.md）：\n- demo: 一个 demo'],
    }))

    expect(result.skillTokens.bodyTokens).toBe(0)
    expect(result.system).not.toContain('# Active Skill:')
    expect(result.system).not.toContain('先读取 reference')
  })

  it('reports layer-0 and layer-1 token usage and injects virtual resource guidance', async () => {
    const result = await buildMessages(context({
      harnessContext: ['可用的 Skill（需要详情时，用 read_file 读取对应的 SKILL.md）：\n- pptd-deck: 制作演示文稿（详情：.solidify/skills/pptd-deck/SKILL.md）'],
      skill: {
        metadata: { name: 'pptd-deck', version: '1.0.0', description: '制作演示文稿' },
        content: '先读取 reference/pptd.md。',
        path: '/workspace/.solidify/skills/pptd-deck/SKILL.md',
        virtualRoot: '.solidify/skills/pptd-deck',
      },
    }))

    expect(result.skillTokens.indexTokens).toBeGreaterThan(0)
    expect(result.skillTokens.bodyTokens).toBeGreaterThan(0)
    expect(result.system).toContain('Skill resource root: .solidify/skills/pptd-deck')
    expect(result.system).toContain('read_file')
  })

  it('rejects an oversized layer-0 index instead of silently exceeding the budget', async () => {
    await expect(buildMessages(context({ harnessContext: [`可用的 Skill\n${'x'.repeat(4000)}`] })))
      .rejects.toThrow(/600-token budget/)
  })
})
