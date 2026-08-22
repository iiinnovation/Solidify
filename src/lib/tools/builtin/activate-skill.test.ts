import { describe, expect, it } from 'vitest'
import { activateSkillTool } from './activate-skill'

describe('activate_skill tool', () => {
  it('only advertises activation for explicit specialized workflows', () => {
    expect(activateSkillTool.description).toContain('Do not activate for definitions')
  })

  it('resolves only trusted enabled registry entries', async () => {
    const result = await activateSkillTool.execute({ skillName: 'demo-code' }, {
      skillRegistry: {
        load: async () => { throw new Error('not used') },
        list: async () => [],
        resolve: async (name: string) => name === 'demo-code'
          ? { metadata: { name, version: '1.2.0', description: 'demo' }, content: 'rules', path: 'builtin://demo-code/SKILL.md' }
          : null,
      },
    } as never, new AbortController().signal)

    expect(result).toMatchObject({ success: true, data: { skillName: 'demo-code' } })
  })

  it('fails closed when no registry is attached', async () => {
    const result = await activateSkillTool.execute({ skillName: 'demo-code' }, {} as never, new AbortController().signal)
    expect(result).toMatchObject({ success: false, error: { kind: 'runtime', recoverable: false } })
  })
})
