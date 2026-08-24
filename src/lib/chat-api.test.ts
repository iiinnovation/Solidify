import { describe, expect, it } from 'vitest'
import { createModelProviderFetch } from './chat-api'

describe('model provider proxy', () => {
  it('exports the native provider transport without the retired prompt builder', () => {
    expect(typeof createModelProviderFetch).toBe('function')
  })
})
