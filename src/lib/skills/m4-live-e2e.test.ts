/// <reference types="node" />
// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/tauri', () => ({
  isTauri: false,
  listenWorkspaceChanges: async () => () => undefined,
  appendWorkspaceRecord: async () => undefined,
  readWorkspaceFile: async () => { throw new Error('Unexpected workspace file read') },
  readWorkspaceBytes: async () => { throw new Error('Unexpected workspace byte read') },
}))

import { runQuery } from '@/lib/engine/query'
import type { QueryContext, QueryEvent } from '@/lib/engine/types'
import { InMemoryState } from '@/lib/memory'
import { OpenAIProvider, ProviderRegistry } from '@/lib/model'
import { providerBaseURL } from '@/lib/model/provider-url'
import { readFileTool } from '@/lib/tools/builtin/read-file'
import type { Tool } from '@/lib/tools/types'
import { SkillLoader } from './loader'
import { SkillRegistry } from './registry'

const LIVE = process.env.npm_lifecycle_event === 'test:m4-live'
  || process.env.M4_LIVE_E2E === 'true'

describe.skipIf(!LIVE)('M4 live progressive-disclosure Demo', () => {
  it('does not force the retired legacy reference before answering', async () => {
    const loader = new SkillLoader({
      fileSystem: {
        listDirectories: async () => [],
        readFile: async () => { throw new Error('Unexpected external Skill read') },
      },
    })
    const registry = new SkillRegistry(loader)
    await registry.reload()
    const skill = await registry.resolve('requirement-analysis')
    if (!skill) throw new Error('Bundled requirement-analysis Skill is unavailable')

    const providerRegistry = new ProviderRegistry()
    providerRegistry.register('live', new OpenAIProvider({
      apiKey: requireEnv('DEEPSEEK_API_KEY'),
      baseURL: providerBaseURL(process.env.M1_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com', 'openai'),
    }))
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 110_000)
    const context: QueryContext = {
      runId: 'm4-live-requirement-analysis',
      conversationId: 'm4-live-requirement-analysis',
      cwd: '/',
      messages: [{
        role: 'user',
        content: '请把以下访谈信息直接整理成一份简短需求规格：客户需要统一查看项目进度，项目经理可以更新状态，普通成员只能查看。',
      }],
      tools: [readFileTool as Tool],
      skill,
      skillResources: loader.createResourceResolver(skill),
      skillRegistry: registry,
      memory: new InMemoryState(),
      model: {
        provider: 'live',
        model: process.env.M1_DEEPSEEK_MODEL ?? 'deepseek-chat',
        temperature: 0,
      },
      limits: {
        maxTurns: 5,
        maxTokens: 30_000,
        maxOutputTokens: 3000,
        maxToolCalls: 6,
        toolTimeoutMs: 30_000,
      },
      signal: controller.signal,
      providerRegistry,
      platform: 'web',
    }

    const events: QueryEvent[] = []
    try {
      for await (const event of runQuery(context)) events.push(event)
    } finally {
      clearTimeout(timeout)
    }

    const requested = events.filter(
      (event): event is Extract<QueryEvent, { type: 'tool.requested' }> => event.type === 'tool.requested',
    )
    const paths = requested
      .filter((event) => event.call.name === 'read_file')
      .map((event) => event.call.input?.path)
    const completed = events.filter(
      (event): event is Extract<QueryEvent, { type: 'tool.completed' }> => event.type === 'tool.completed',
    )
    const finalMessage = [...events].reverse().find(
      (event): event is Extract<QueryEvent, { type: 'message.completed' }> => event.type === 'message.completed',
    )
    const terminal = events.at(-1)
    const diagnostic = JSON.stringify({
      paths,
      terminal: terminal?.type,
      error: terminal?.type === 'run.failed' ? redactDiagnostic(terminal.error.message) : undefined,
      completed: completed.map((event) => ({ success: event.result.success, error: event.result.error?.kind })),
    })

    expect(paths, diagnostic).not.toContain('.solidify/skills/requirement-analysis/reference/legacy-guidance.md')
    expect(completed.every((event) => event.result.success), diagnostic).toBe(true)
    expect(finalMessage?.content, diagnostic).toContain('功能需求')
    expect(terminal?.type, diagnostic).toBe('run.completed')
    if (terminal?.type === 'run.completed') {
      process.stdout.write(`${JSON.stringify({
        m4LiveEvidence: {
          model: context.model.model,
          referencePaths: paths,
          usage: terminal.usage,
        },
      })}\n`)
    }
  }, 120_000)
})

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`M4 live E2E requires ${name}`)
  return value
}

function redactDiagnostic(message: string): string {
  return message
    .replace(/(?:sk|key)-[A-Za-z0-9_-]+/gi, '[redacted]')
    .replace(/(authorization|api[-_ ]?key)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]')
}
