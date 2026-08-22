import { describe, expect, it } from 'vitest'
import { assertContextBudgetSnapshot, validateContextBudgetSnapshot } from './context-budget-gate'

const base = {
  systemTokens: 700,
  skillTokens: 500,
  toolsTokens: 300,
  historyTokens: 100,
  attachmentTokens: 0,
  currentTaskTokens: 50,
  skillIndexTokens: 250,
}

describe('context budget gate', () => {
  it('accepts a bounded request snapshot', () => {
    expect(validateContextBudgetSnapshot(base)).toEqual([])
    expect(() => assertContextBudgetSnapshot(base)).not.toThrow()
  })

  it('reports each independent budget violation', () => {
    const failures = validateContextBudgetSnapshot({
      ...base,
      systemTokens: 3_001,
      fixedSystemTokens: 801,
      skillTokens: 2_001,
      skillIndexTokens: 601,
      inlineAttachmentPreviewTokens: 1,
    })
    expect(failures).toHaveLength(5)
    expect(() => assertContextBudgetSnapshot({ ...base, systemTokens: 3_001 })).toThrow(/system prompt/)
  })

  it('accepts a valid Skill plus the fixed system prompt', () => {
    expect(validateContextBudgetSnapshot({
      ...base,
      systemTokens: 1_734,
      fixedSystemTokens: 462,
      skillTokens: 1_272,
    })).toEqual([])
  })
})
