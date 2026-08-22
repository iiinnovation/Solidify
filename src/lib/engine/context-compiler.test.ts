import { describe, expect, it } from 'vitest'
import { compileContext } from './context-compiler'
import type { QueryContext } from './types'

function context(overrides: Partial<QueryContext> = {}): QueryContext {
  return {
    runId: 'run-compiler',
    conversationId: 'conversation-compiler',
    cwd: '/workspace',
    messages: [{ role: 'user', content: '完成任务' }],
    tools: [],
    memory: { store: async () => 'handle', retrieve: async () => null, search: async () => [], clear: async () => undefined },
    model: { provider: 'mock', model: 'mock-model', contextWindow: 10_000 },
    limits: { maxTurns: 3, maxTokens: 10_000, maxOutputTokens: 1_000, maxToolCalls: 3, toolTimeoutMs: 1_000 },
    signal: new AbortController().signal,
    providerRegistry: { get: () => undefined } as never,
    ...overrides,
  }
}

function skill(content: string): NonNullable<QueryContext['skill']> {
  return {
    metadata: { name: 'same-size', version: '1.0.0', description: 'test' },
    content,
    path: 'builtin://same-size/SKILL.md',
  }
}

describe('Context Compiler', () => {
  it('produces a stable prefix fingerprint and separates equal-sized Skill contents', async () => {
    const first = await compileContext(context({ skill: skill('AAAA') }))
    const second = await compileContext(context({ skill: skill('BBBB') }))

    expect(first.stats.fixedPrefixFingerprint).toMatch(/^ctx-/)
    expect(first.stats.fixedPrefixFingerprint).not.toBe(second.stats.fixedPrefixFingerprint)
    expect(first.stats.cacheable.system).toBe(true)
  })

  it('enforces the production budget before a provider request can be built', async () => {
    await expect(compileContext(context({ cwd: `/${'x'.repeat(7_000)}` })))
      .rejects.toThrow(/system prompt exceeds/)
  })
})
