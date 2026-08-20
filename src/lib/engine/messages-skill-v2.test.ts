import { describe, expect, it } from 'vitest'
import { buildMessages } from './messages'
import { readAttachmentTool, searchAttachmentsTool } from '@/lib/tools/builtin/attachments'
import type { Tool } from '@/lib/tools/types'
import type { QueryContext } from './types'

function attachmentTools(): Tool[] {
  return [searchAttachmentsTool as Tool, readAttachmentTool as Tool]
}

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
    expect(result.system).toContain('already loads the bundled PPTD reference guides')
    expect(result.system).not.toContain('Available Skill resource files')
    expect(result.system).toContain('read_file')
  })

  it('lists only the resource files actually bundled with the selected Skill', async () => {
    const result = await buildMessages(context({
      skill: {
        metadata: { name: 'test-plan', version: '2.1.0', description: '生成测试方案' },
        content: '先读取 reference/legacy-guidance.md。',
        path: 'builtin://test-plan/SKILL.md',
        virtualRoot: '.solidify/skills/test-plan',
        resourceFiles: {
          'SKILL.md': 'document',
          'reference/legacy-guidance.md': 'guidance',
        },
      },
    }))

    expect(result.system).toContain('.solidify/skills/test-plan/reference/legacy-guidance.md')
    expect(result.system).not.toContain('.solidify/skills/test-plan/examples/')
  })

  it('distinguishes bundled Skill resources from user attachments without a workspace', async () => {
    const result = await buildMessages(context({
      skill: {
        metadata: { name: 'pptd-deck', version: '1.2.0', description: '制作演示文稿' },
        content: '读取必要参考并生成 deck。',
        path: 'builtin://pptd-deck/SKILL.md',
        virtualRoot: '.solidify/skills/pptd-deck',
        resourceFiles: { 'reference/slide-categories/management-report.md': 'guidance' },
      },
      tools: attachmentTools(),
      workspace: undefined,
    }))

    expect(result.system).toContain('bundled PPTD resources are already loaded')
    expect(result.system).toContain('Do not call read_file or read_handle for attachment filenames')
  })

  it('points a non-PPTD Skill at the attachment readers when they are resolved', async () => {
    const result = await buildMessages(context({
      skill: {
        metadata: { name: 'drawio-diagram', version: '1.0.0', description: '绘制流程图' },
        content: '根据材料绘制流程图。',
        path: 'builtin://drawio-diagram/SKILL.md',
        virtualRoot: '.solidify/skills/drawio-diagram',
      },
      tools: attachmentTools(),
      workspace: undefined,
    }))

    expect(result.system).toContain('use search_attachments/read_attachment when needed')
  })

  it('never names the attachment readers when they were filtered out of the run', async () => {
    const result = await buildMessages(context({
      skill: {
        metadata: { name: 'pptd-deck', version: '1.2.0', description: '制作演示文稿' },
        content: '读取必要参考并生成 deck。',
        path: 'builtin://pptd-deck/SKILL.md',
        virtualRoot: '.solidify/skills/pptd-deck',
      },
      tools: [],
      workspace: undefined,
    }))

    // Advertising an unresolved tool is what produced "Tool 'search_attachments'
    // does not exist" mid-run, so the prompt must stay silent about them.
    expect(result.system).not.toContain('search_attachments')
    expect(result.system).not.toContain('read_attachment')
    expect(result.system).toContain('bundled PPTD resources are already loaded')
  })

  it('rejects an oversized layer-0 index instead of silently exceeding the budget', async () => {
    await expect(buildMessages(context({ harnessContext: [`可用的 Skill\n${'x'.repeat(4000)}`] })))
      .rejects.toThrow(/600-token budget/)
  })

  it('injects only bounded Skill core rules and points to the full guide', async () => {
    const result = await buildMessages(context({
      skill: {
        metadata: { name: 'large-skill', version: '1.0.0', description: '大型技能' },
        content: '核心规则\n'.repeat(3_000),
        path: 'builtin://large-skill/SKILL.md',
        virtualRoot: '.solidify/skills/large-skill',
        resourceFiles: { 'SKILL.md': 'full document' },
      },
    }))

    expect(result.skillTokens.bodyTokens).toBeLessThanOrEqual(2_000)
    expect(result.system).toContain('Read .solidify/skills/large-skill/SKILL.md')
  })
})
