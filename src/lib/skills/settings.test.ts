import { beforeEach, describe, expect, it } from 'vitest'
import { getDisabledSkillNames, isSkillEnabled, setSkillEnabled } from './settings'

describe('Skill enabled settings', () => {
  beforeEach(() => localStorage.removeItem('solidify-disabled-skills'))

  it('persists disabled names without affecting other Skills', () => {
    setSkillEnabled('pptd-deck', false)
    expect(isSkillEnabled('pptd-deck')).toBe(false)
    expect(isSkillEnabled('requirement-analysis')).toBe(true)
    expect([...getDisabledSkillNames()]).toEqual(['pptd-deck'])
    setSkillEnabled('pptd-deck', true)
    expect(isSkillEnabled('pptd-deck')).toBe(true)
  })
})
