/// <reference types="node" />
// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { InMemoryState } from '../../memory'
import { OpenAIProvider, ProviderRegistry } from '../../model'
import { providerBaseURL } from '../../model/provider-url'
import type { QueryContext } from '../types'
import type { Tool } from '../../tools/types'
import { dispatchSubAgents } from '../sub-agent/spawn'

vi.mock('@/lib/tauri', () => ({
  readWorkspaceFile: async (path: string) => ({ content: files[path as keyof typeof files] ?? '', binary: false, bytes: 0, truncated: false }),
}))

const LIVE = process.env.npm_lifecycle_event === 'test:m6-live' || process.env.M6_LIVE_E2E === 'true'
const files = {
  'interview-a.md': 'Customer needs exportable reports and predictable delivery times.',
  'interview-b.md': 'Customer needs local-first storage and transparent approval prompts.',
  'interview-c.md': 'Customer needs searchable project memory and reversible revisions.',
}

describe.skipIf(!LIVE)('M6 live multi-agent demo', () => {
  it('executes independent research tasks against a real model with bounded fan-out', async () => {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    if (!apiKey) throw new Error('M6 live E2E requires DEEPSEEK_API_KEY')
    const provider = new OpenAIProvider({
      apiKey,
      baseURL: providerBaseURL(process.env.M1_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1', 'openai'),
    })
    const registry = new ProviderRegistry()
    registry.register('live', provider)
    const base: QueryContext = {
      runId: 'm6-live-root',
      conversationId: 'm6-live-conversation',
      cwd: '/m6-live',
      messages: [{ role: 'user', content: 'M6 live parent context.' }],
      tools: [readInterviewTool as Tool],
      memory: new InMemoryState(),
      model: { provider: 'live', model: process.env.M6_DEEPSEEK_MODEL ?? process.env.M1_DEEPSEEK_MODEL ?? 'deepseek-chat', temperature: 0 },
      limits: { maxTurns: 6, maxTokens: 20_000, maxOutputTokens: 1_200, maxToolCalls: 8, toolTimeoutMs: 30_000 },
      signal: new AbortController().signal,
      providerRegistry: registry,
      workspace: { root: '/m6-live', name: 'm6-live', resolve: (path) => `/m6-live/${path}`, contains: () => true },
      platform: 'web',
    }
    const results = await dispatchSubAgents(base, [
      { id: 'interview-a', role: 'researcher', task: 'Read interview-a.md and extract the single customer need with evidence.', allowedTools: ['read_file'] },
      { id: 'interview-b', role: 'researcher', task: 'Read interview-b.md and extract the single customer need with evidence.', allowedTools: ['read_file'] },
      { id: 'interview-c', role: 'researcher', task: 'Read interview-c.md and extract the single customer need with evidence.', allowedTools: ['read_file'] },
    ], { concurrency: 3 })
    expect(results).toHaveLength(3)
    expect(results.every((item) => item.status === 'completed')).toBe(true)
    expect(results.every((item) => item.content.length > 0)).toBe(true)
  }, 180_000)
})

const readInterviewTool: Tool<{ path: string }> = {
  name: 'read_file',
  description: 'Read one interview file from the workspace.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } },
  readOnly: true,
  concurrencySafe: true,
  destructive: false,
  requiresConfirmation: false,
  availability: 'always',
  permissions: [],
  execute: async (input) => {
    const path = typeof input.path === 'string' ? input.path : ''
    const content = files[path as keyof typeof files]
    return content
      ? { success: true, content }
      : { success: false, content: '', error: { kind: 'not_found', message: `Unknown interview: ${path}`, recoverable: true } }
  },
  renderCall: (input) => `读取 ${String(input.path)}`,
}
