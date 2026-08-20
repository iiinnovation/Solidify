import { describe, expect, it } from 'vitest'
import { getSystemPrompt } from './chat-api'

describe('base system prompt', () => {
  it('injects the selected skill instructions', () => {
    expect(getSystemPrompt('SKILL RULES', true)).toContain('SKILL RULES')
    expect(getSystemPrompt('SKILL RULES', true)).toContain('不需要先分析再确认')
  })

  it('keeps the confirmation workflow without an active skill', () => {
    expect(getSystemPrompt()).toContain('先分析，后生成')
  })
})
