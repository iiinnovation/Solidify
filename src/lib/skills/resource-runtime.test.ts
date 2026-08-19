import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModelProvider } from '@/stores/model-store'
import { clearChatSkillRuntimeCache, createChatQueryContext, loadChatSkillRuntime } from '@/lib/engine/chat-context'
import { buildMessages } from '@/lib/engine/messages'
import { buildToolUseContext } from '@/lib/engine/tool-context'
import { createHarnessRuntime, hardGuard, permissionGate } from '@/lib/harness/builtin-hooks'
import { clearFlagOverrides, setFlagOverride } from '@/lib/harness/flags'
import type { RunLogger } from '@/lib/harness/types'
import { readFileTool } from '@/lib/tools/builtin/read-file'
import type { Tool } from '@/lib/tools/types'
import { formatSkillIndex } from './registry'

const provider: ModelProvider = {
  id: 'test-provider',
  name: 'Test',
  apiUrl: 'https://example.com/v1/chat/completions',
  apiKey: 'test-key',
  modelId: 'test-model',
  format: 'openai',
  enabled: true,
}

const logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as RunLogger

describe('bundled Skill resource runtime', () => {
  beforeEach(() => {
    localStorage.clear()
    clearChatSkillRuntimeCache()
    setFlagOverride('toolCalling', true)
    setFlagOverride('skillV2', true)
  })

  afterEach(() => clearFlagOverrides())

  it('reuses one loaded registry for nearby chat runs in the same workspace', async () => {
    const [first, second] = await Promise.all([
      loadChatSkillRuntime({ skillName: 'requirement-analysis' }),
      loadChatSkillRuntime({ skillName: 'pptd-deck' }),
    ])

    expect(second.registry).toBe(first.registry)
    expect(second.loader).toBe(first.loader)
    expect(first.skill?.metadata.name).toBe('requirement-analysis')
    expect(second.skill?.metadata.name).toBe('pptd-deck')
  })

  it('reads the indexed SKILL.md and its reference through the real read_file tool on Web', async () => {
    const runtime = await loadChatSkillRuntime({ skillName: 'requirement-analysis' })
    expect(runtime.skill).toBeDefined()
    expect(runtime.resources).toBeDefined()

    const index = formatSkillIndex(await runtime.registry.list())
    const indexedPath = index.match(/requirement-analysis:.*?（详情：([^）]+)）/)?.[1]
    expect(indexedPath).toBe('.solidify/skills/requirement-analysis/SKILL.md')
    if (!indexedPath) throw new Error('Skill index did not contain the requirement-analysis entry path')

    const context = createChatQueryContext({
      runId: 'skill-runtime',
      conversationId: 'skill-runtime',
      messages: [{ role: 'user', content: '请整理需求' }],
      provider,
      signal: new AbortController().signal,
      loadedSkill: runtime.skill,
      skillResources: runtime.resources,
      skillRegistry: runtime.registry,
    })
    const tool = context.tools.find((item) => item.name === 'read_file')
    expect(tool).toBe(readFileTool)

    const call = { id: 'read-skill-entry', name: 'read_file', input: { path: indexedPath } }
    const runtimeTool = readFileTool as Tool
    expect(hardGuard(context, runtimeTool, call)).toEqual({ kind: 'abstain' })
    await expect(permissionGate(createHarnessRuntime(context), context, runtimeTool, call))
      .resolves.toMatchObject({ kind: 'allow' })

    const toolContext = buildToolUseContext(context, logger)
    const entry = await readFileTool.execute(call.input, toolContext, context.signal)
    expect(entry).toMatchObject({ success: true })
    expect(entry.content).toContain('name: requirement-analysis')
    expect(entry.content).toContain('reference/output-format.md')

    const reference = await readFileTool.execute({
      path: '.solidify/skills/requirement-analysis/reference/output-format.md',
    }, toolContext, context.signal)
    expect(reference).toMatchObject({ success: true })
    expect(reference.content).toContain('需求规格文档')

    const directory = await readFileTool.execute({
      path: '.solidify/skills/requirement-analysis/examples/',
    }, toolContext, context.signal)
    expect(directory).toMatchObject({
      success: false,
      error: { kind: 'invalid_input', recoverable: true },
    })
    expect(directory.content).toContain('必须指向具体文件')
  })

  it('keeps the active Skill empty when skillV2 is enabled without a selection', async () => {
    const context = createChatQueryContext({
      runId: 'no-skill-runtime',
      conversationId: 'no-skill-runtime',
      messages: [{ role: 'user', content: '普通问题' }],
      provider,
      signal: new AbortController().signal,
    })

    expect(context.skill).toBeUndefined()
    const built = await buildMessages(context)
    expect(built.skillTokens.bodyTokens).toBe(0)
    expect(built.system).not.toContain('# Active Skill:')
  })

  it('migrates the legacy presentation identifier to the canonical pptd-deck Skill', async () => {
    const runtime = await loadChatSkillRuntime({ skillName: 'presentation' })

    expect(runtime.skill?.metadata.name).toBe('pptd-deck')
    expect(runtime.skill?.metadata.allowedTools).toContain('generate_pptd')
    expect(runtime.skill?.metadata.allowedTools).not.toContain('capture_preview')
    expect((await runtime.registry.list()).some((skill) => skill.name === 'presentation')).toBe(false)
  })

  it('exposes PPTD Skill resource reads without a selected workspace', async () => {
    const runtime = await loadChatSkillRuntime({ skillName: 'pptd-deck' })
    const context = createChatQueryContext({
      runId: 'pptd-resource-runtime',
      conversationId: 'pptd-resource-runtime',
      messages: [{ role: 'user', content: '生成管理汇报 PPT' }],
      provider,
      signal: new AbortController().signal,
      loadedSkill: runtime.skill,
      skillResources: runtime.resources,
      skillRegistry: runtime.registry,
    })

    expect(context.workspace).toBeUndefined()
    expect(context.tools.map((tool) => tool.name)).toEqual(['read_file', 'read_handle', 'generate_pptd'])

    const readFile = context.tools.find((tool) => tool.name === 'read_file')
    const result = await readFile?.execute({
      path: '.solidify/skills/pptd-deck/reference/slide-categories/management-report.md',
    }, buildToolUseContext(context, logger), context.signal)

    expect(result).toMatchObject({ success: true })
    expect(result?.content).toContain('Management Reporting')
  })

  it('never applies the read-only Skill resource exemption to a write tool', async () => {
    const runtime = await loadChatSkillRuntime({ skillName: 'requirement-analysis' })
    const context = createChatQueryContext({
      runId: 'skill-write-boundary',
      conversationId: 'skill-write-boundary',
      messages: [{ role: 'user', content: '修改 Skill' }],
      provider,
      signal: new AbortController().signal,
      loadedSkill: runtime.skill,
      skillResources: runtime.resources,
      skillRegistry: runtime.registry,
    })
    const writeLikeTool: Tool = {
      ...readFileTool as Tool,
      name: 'write_skill_resource',
      readOnly: false,
    }
    const call = {
      id: 'write-skill-entry',
      name: writeLikeTool.name,
      input: { path: '.solidify/skills/requirement-analysis/SKILL.md' },
    }

    expect(hardGuard(context, writeLikeTool, call)).toMatchObject({ kind: 'deny' })
    await expect(permissionGate(createHarnessRuntime(context), context, writeLikeTool, call))
      .resolves.toMatchObject({ kind: 'deny' })
  })

  it('rejects traversal, absolute paths and other Skill roots at every resolver entry point', async () => {
    const runtime = await loadChatSkillRuntime({ skillName: 'requirement-analysis' })
    const resolver = runtime.resources!
    const invalidPaths = [
      '.solidify/skills/solution-design/SKILL.md',
      '.solidify/skills/requirement-analysis/../solution-design/SKILL.md',
      '.solidify\\skills\\requirement-analysis\\..\\solution-design\\SKILL.md',
      '/.solidify/skills/requirement-analysis/SKILL.md',
      'C:\\.solidify\\skills\\requirement-analysis\\SKILL.md',
      '.solidify/skills/requirement-analysis//SKILL.md',
      '.solidify/skills/requirement-analysis/./SKILL.md',
    ]

    for (const path of invalidPaths) {
      expect(resolver.canRead(path), path).toBe(false)
      await expect(resolver.read(path), path).rejects.toThrow(/不在当前 Skill 范围内/)
    }
  })
})
