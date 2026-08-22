import { describe, expect, it } from 'vitest'
import { buildMessages } from './messages'
import type { QueryContext } from './types'

describe('skill prompt assembly', () => {
  it('adds selected skill content to the model system prompt', async () => {
    const ctx = {
      messages: [{ role: 'user', content: 'Create an outline' }],
      tools: [],
      skill: {
        metadata: { name: 'outline', version: '1', description: 'Outline skill' },
        content: 'Use the selected outline workflow.',
        path: 'chat://skill',
      },
      limits: { maxTokens: 10_000 },
    } as unknown as QueryContext

    const result = await buildMessages(ctx)
    expect(result.system).toContain('Use the selected outline workflow.')
    expect(result.messages).toEqual([{ role: 'user', content: 'Create an outline' }])
  })

  it('does not describe unavailable slide tooling in the base prompt', async () => {
    const ctx = {
      messages: [{ role: 'user', content: 'Create slides' }],
      tools: [],
      limits: { maxTokens: 10_000 },
    } as unknown as QueryContext

    const result = await buildMessages(ctx)
    expect(result.system).not.toContain('For type="slides"')
    expect(result.system).not.toContain('generate_pptd')
  })
})
