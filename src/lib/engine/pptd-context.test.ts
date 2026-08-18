import { describe, expect, it } from 'vitest'
import { ProviderRegistry } from '../model'
import { InMemoryState } from '../memory'
import type { Tool } from '../tools/types'
import type { QueryContext } from './types'
import { enablePptdPipeline } from './pptd-context'

function toolNamed(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    readOnly: true,
    concurrencySafe: true,
    destructive: false,
    requiresConfirmation: false,
    availability: 'always',
    permissions: [],
    async execute() { return { success: true, content: '' } },
    renderCall: () => name,
  }
}

function context(skillName = 'pptd-deck', allowedTools: string[] | undefined = ['generate_pptd']): QueryContext {
  return {
    runId: 'run',
    conversationId: 'conversation',
    cwd: '/',
    messages: [{ role: 'user', content: '生成 deck' }],
    tools: [],
    skill: {
      metadata: { name: skillName, version: '1.0.0', description: 'test', allowedTools },
      content: '',
      path: `builtin://${skillName}`,
    },
    memory: new InMemoryState(),
    model: { provider: 'mock', model: 'mock' },
    limits: { maxTurns: 5, maxTokens: 10_000, maxOutputTokens: 1_000, maxToolCalls: 5, toolTimeoutMs: 1_000 },
    signal: new AbortController().signal,
    providerRegistry: new ProviderRegistry(),
  }
}

describe('PPTD pipeline context', () => {
  it('attaches one dynamic generator to the pptd-deck Skill', () => {
    const enabled = enablePptdPipeline(context())
    expect(enabled.tools.map((tool) => tool.name)).toEqual(['generate_pptd'])
    expect(enabled.taskTree).toBeUndefined()
    expect(enablePptdPipeline(enabled)).toBe(enabled)
  })

  it('leaves unrelated Skills unchanged', () => {
    const original = context('requirement-analysis')
    expect(enablePptdPipeline(original)).toBe(original)
  })

  it('upgrades the legacy presentation Skill to the validated PPTD pipeline', () => {
    const enabled = enablePptdPipeline(context('presentation', ['read_file', 'write_file', 'capture_preview']))

    expect(enabled.tools.map((tool) => tool.name)).toEqual(['generate_pptd'])
    expect(enabled.skill?.metadata.allowedTools).toContain('generate_pptd')
    expect(enabled.skill?.metadata.allowedTools).not.toContain('capture_preview')
    expect(enabled.skill?.content).toContain('Solidify PPTD compatibility override')
    expect(enabled.skill?.content).toContain('call generate_pptd exactly once')
  })

  it('hides workspace read tools when attachments are used without a selected workspace', () => {
    const original: QueryContext = {
      ...context('pptd-deck', ['read_file', 'list_dir', 'search_files', 'capture_preview', 'generate_pptd']),
      tools: ['read_file', 'list_dir', 'search_files', 'capture_preview'].map(toolNamed),
    }

    const enabled = enablePptdPipeline(original)

    expect(enabled.tools.map((tool) => tool.name)).toEqual(['generate_pptd'])
    expect(enabled.skill?.metadata.allowedTools).not.toContain('capture_preview')
  })

  it('keeps read_file for bundled Skill resources without exposing workspace search tools', () => {
    const original: QueryContext = {
      ...context('pptd-deck', ['read_file', 'list_dir', 'search_files', 'generate_pptd']),
      skillResources: {
        virtualRoot: '.solidify/skills/pptd-deck',
        canRead: (path) => path.startsWith('.solidify/skills/pptd-deck/'),
        read: async () => ({ content: 'reference', bytes: 9, truncated: false }),
      },
      tools: ['read_file', 'list_dir', 'search_files'].map(toolNamed),
    }

    const enabled = enablePptdPipeline(original)

    expect(enabled.tools.map((tool) => tool.name)).toEqual(['read_file', 'generate_pptd'])
  })

  it('hides capture_preview during initial generation even with a workspace or pre-attached generator', () => {
    const generator = toolNamed('generate_pptd')
    const original: QueryContext = {
      ...context('pptd-deck', ['capture_preview', 'generate_pptd']),
      workspace: { root: '/workspace', name: 'workspace', resolve: (path) => path, contains: () => true },
      tools: [toolNamed('capture_preview'), generator],
    }

    const enabled = enablePptdPipeline(original)

    expect(enabled).not.toBe(original)
    expect(enabled.tools).toEqual([generator])
    expect(enabled.skill?.metadata.allowedTools).toEqual(['generate_pptd'])
    expect(enablePptdPipeline(enabled)).toBe(enabled)
  })

  it('does not inject generate_pptd when the Skill omits it from allowed-tools', () => {
    const original = context('pptd-deck', ['read_file'])
    expect(enablePptdPipeline(original)).toBe(original)
    expect(original.tools).toEqual([])
  })
})
