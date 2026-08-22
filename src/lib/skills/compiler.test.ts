import { describe, expect, it } from 'vitest'
import { compileSkill, compileSkillIndex } from './compiler'
import { compiledBuiltinSkills } from './generated/manifest'
import type { LoadedSkill } from './types'

const skill: LoadedSkill = {
  metadata: { name: 'demo-code', version: '1.0.0', description: 'demo', allowedTools: ['read_file'] },
  content: '核心规则。需要特殊语法时读取 `reference/output-format.md`。',
  path: 'builtin://demo-code/SKILL.md',
}

describe('Skill compiler', () => {
  it('extracts stable core, reference routes, tools, and fingerprint', () => {
    const compiled = compileSkill(skill)
    expect(compiled.coreInstructions).toContain('核心规则')
    expect(compiled.referenceRoutes).toEqual(['reference/output-format.md'])
    expect(compiled.allowedTools).toEqual(['read_file'])
    expect(compiled.fingerprint).toMatch(/^skill-[0-9a-f]{8}$/)
    expect(compiled.estimatedTokens).toBeGreaterThan(0)
  })

  it('does not publish template placeholder paths as runtime routes', () => {
    const compiled = compileSkill({
      ...skill,
      content: '按场景读取 `reference/design-system/<family>/<name>/design.md`。',
    })
    expect(compiled.referenceRoutes).toEqual([])
  })

  it('sorts the static index deterministically', () => {
    const other = { ...skill, metadata: { ...skill.metadata, name: 'alpha' } }
    expect(compileSkillIndex([skill, other]).map((item) => item.metadata.name)).toEqual(['alpha', 'demo-code'])
  })

  it('ships a generated builtin manifest without the retired legacy resource', () => {
    expect(compiledBuiltinSkills).toHaveLength(10)
    expect(compiledBuiltinSkills.map((item) => item.metadata.name)).toEqual([...compiledBuiltinSkills].map((item) => item.metadata.name).sort())
    expect(compiledBuiltinSkills.every((item) => !item.coreInstructions.includes('reference/legacy-guidance.md'))).toBe(true)
    expect(compiledBuiltinSkills.every((item) => item.fingerprint.startsWith('skill-'))).toBe(true)
  })
})
