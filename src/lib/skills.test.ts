import { describe, it, expect } from 'vitest'
import { builtinSkills, getSkillById } from './skills'

describe('builtinSkills', () => {
  it('should have 10 builtin skills', () => {
    expect(builtinSkills).toHaveLength(10)
  })

  it('should have unique skill IDs', () => {
    const ids = builtinSkills.map((s) => s.id)
    const uniqueIds = new Set(ids)

    expect(uniqueIds.size).toBe(ids.length)
  })

  it('should have all required fields', () => {
    builtinSkills.forEach((skill) => {
      expect(skill.id).toBeTruthy()
      expect(skill.name).toBeTruthy()
      expect(skill.description).toBeTruthy()
      expect(skill.icon).toBeTruthy()
      expect(skill.placeholder).toBeTruthy()
      expect(skill.systemPrompt).toBeTruthy()
      expect(typeof skill.skipConfirmation).toBe('boolean')
    })
  })

  it('should have valid skill IDs', () => {
    const expectedIds = [
      'requirement-analysis',
      'solution-design',
      'demo-code',
      'gap-analysis',
      'test-plan',
      'meeting-notes',
      'report-outline',
      'glossary',
      'presentation',
      'drawio-diagram',
    ]

    const actualIds = builtinSkills.map((s) => s.id)

    expect(actualIds).toEqual(expectedIds)
  })

  it('should have presentation skill with recommended models', () => {
    const presentation = builtinSkills.find((s) => s.id === 'presentation')

    expect(presentation?.recommendedModels).toEqual(['Claude', 'GPT-4'])
  })

  it('should have report-outline with skipConfirmation false', () => {
    const reportOutline = builtinSkills.find((s) => s.id === 'report-outline')

    expect(reportOutline?.skipConfirmation).toBe(false)
  })

  it('should have all other skills with skipConfirmation true', () => {
    const otherSkills = builtinSkills.filter((s) => s.id !== 'report-outline')

    otherSkills.forEach((skill) => {
      expect(skill.skipConfirmation).toBe(true)
    })
  })
})

describe('getSkillById', () => {
  it('should return skill by ID', () => {
    const skill = getSkillById('requirement-analysis')

    expect(skill).toBeDefined()
    expect(skill?.name).toBe('需求分析')
  })

  it('should return undefined for non-existent ID', () => {
    const skill = getSkillById('non-existent')

    expect(skill).toBeUndefined()
  })

  it('should return correct skill for each ID', () => {
    builtinSkills.forEach((expectedSkill) => {
      const skill = getSkillById(expectedSkill.id)

      expect(skill).toEqual(expectedSkill)
    })
  })
})
