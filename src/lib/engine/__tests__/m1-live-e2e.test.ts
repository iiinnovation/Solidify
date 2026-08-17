/// <reference types="node" />
// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { runQuery } from '../query'
import { InMemoryState } from '../../memory'
import { ProviderRegistry, AnthropicProvider, OpenAIProvider } from '../../model'
import { providerBaseURL } from '../../model/provider-url'
import type { QueryContext, QueryEvent } from '../types'
import type { ModelProvider } from '../../model'
import type { Tool, ToolUseContext } from '../../tools/types'

vi.mock('@/lib/tauri', () => ({
  listWorkspaceDir: async (path: string, root: string) => {
    const directory = safePath(root, path)
    const names = await readdir(directory)
    const entries = await Promise.all(names.map(async (name) => {
      const info = await stat(join(directory, name))
      return {
        path: relative(root, join(directory, name)) || '.',
        name,
        kind: info.isDirectory() ? 'directory' as const : 'file' as const,
        size: info.size,
      }
    }))
    return entries.sort((left, right) => left.path.localeCompare(right.path))
  },
  readWorkspaceFile: async (path: string, root: string, offset?: number, limit?: number) => {
    const data = await readFile(safePath(root, path))
    const bytes = data.byteLength
    const content = data.toString('utf8')
    const characters = Array.from(content)
    const start = offset ?? 0
    const selected = characters.slice(start, limit === undefined ? undefined : start + limit).join('')
    return {
      content: selected,
      binary: false,
      bytes,
      truncated: start + Array.from(selected).length < characters.length,
    }
  },
}))

import { listDirTool } from '../../tools/builtin/list-dir'
import { readFileTool } from '../../tools/builtin/read-file'

const LIVE = process.env.npm_lifecycle_event === 'test:m1-live'
  || process.env.M1_LIVE_E2E === 'true'
const SUMMARY_MARKER = 'SOLIDIFY_M1_LARGEST_MARKER'

interface LiveModel {
  name: 'Claude' | 'GPT' | 'DeepSeek'
  model: string
  provider: () => ModelProvider
}

let workspaceRoot = ''

beforeAll(async () => {
  if (!LIVE) return
  workspaceRoot = await mkdtemp(join(tmpdir(), 'solidify-m1-live-'))
  await writeFile(join(workspaceRoot, 'small.txt'), 'small fixture\n')
  await writeFile(
    join(workspaceRoot, 'largest.md'),
    `# Largest fixture\n\n${SUMMARY_MARKER}\n\n${'M1 live content. '.repeat(300)}`,
  )
})

afterAll(async () => {
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true })
})

describe.skipIf(!LIVE)('M1-29 live three-model workspace Demo', () => {
  const models = liveModels()

  it.each(models)('$name completes list_dir -> read_file -> summary', async (model) => {
    const events = await runLiveDemo(model)
    const requested = events
      .filter((event): event is Extract<QueryEvent, { type: 'tool.requested' }> =>
        event.type === 'tool.requested')
    const requestedNames = requested.map((event) => event.call.name)
    const completed = events.filter(
      (event): event is Extract<QueryEvent, { type: 'tool.completed' }> =>
        event.type === 'tool.completed',
    )
    const finalMessage = [...events].reverse().find(
      (event): event is Extract<QueryEvent, { type: 'message.completed' }> =>
        event.type === 'message.completed',
    )
    const terminal = events.at(-1)
    const diagnostic = JSON.stringify({
      provider: model.name,
      model: model.model,
      requestedTools: requestedNames,
      terminal: terminal?.type,
      error: terminal?.type === 'run.failed'
        ? { kind: terminal.error.kind, message: redactDiagnostic(terminal.error.message) }
        : undefined,
    })

    expect(requestedNames.indexOf('list_dir'), diagnostic).toBeGreaterThanOrEqual(0)
    expect(requestedNames.indexOf('read_file'))
      .toBeGreaterThan(requestedNames.indexOf('list_dir'))
    expect(requested.find((event) => event.call.name === 'read_file')?.call.input)
      .toMatchObject({ path: 'largest.md' })
    expect(completed).toHaveLength(2)
    expect(completed.every((event) => event.result.success)).toBe(true)
    expect(finalMessage?.content).toContain(SUMMARY_MARKER)
    expect(terminal?.type).toBe('run.completed')
    if (terminal?.type === 'run.completed') {
      expect(terminal.usage.totalTokens).toBeGreaterThan(0)
      process.stdout.write(`${JSON.stringify({
        m1LiveEvidence: {
          provider: model.name,
          model: model.model,
          tools: requestedNames,
          usage: terminal.usage,
          summaryMarker: SUMMARY_MARKER,
        },
      })}\n`)
    }
  }, 120_000)
})

function liveModels(): LiveModel[] {
  if (!LIVE) return []
  const requested = new Set((process.env.M1_LIVE_MODELS ?? 'Claude,GPT,DeepSeek').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean))
  const models: LiveModel[] = []
  if (requested.has('claude')) {
    const anthropicKey = requireEnv('ANTHROPIC_API_KEY')
    models.push({
      name: 'Claude',
      model: process.env.M1_CLAUDE_MODEL ?? 'claude-sonnet-4-20250514',
      provider: () => new AnthropicProvider({
        apiKey: anthropicKey,
        baseURL: providerBaseURL(process.env.M1_ANTHROPIC_BASE_URL ?? '', 'anthropic'),
      }),
    })
  }
  if (requested.has('gpt')) {
    const openaiKey = requireEnv('OPENAI_API_KEY')
    models.push({
      name: 'GPT',
      model: process.env.M1_GPT_MODEL ?? 'gpt-4o',
      provider: () => new OpenAIProvider({
        apiKey: openaiKey,
        baseURL: providerBaseURL(process.env.M1_OPENAI_BASE_URL ?? '', 'openai'),
      }),
    })
  }
  if (requested.has('deepseek')) {
    const deepseekKey = requireEnv('DEEPSEEK_API_KEY')
    models.push({
      name: 'DeepSeek',
      model: process.env.M1_DEEPSEEK_MODEL ?? 'deepseek-chat',
      provider: () => new OpenAIProvider({
        apiKey: deepseekKey,
        baseURL: providerBaseURL(
          process.env.M1_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
          'openai',
        ),
      }),
    })
  }
  if (models.length === 0) throw new Error('M1_LIVE_MODELS must select at least one of Claude, GPT, DeepSeek')
  return models
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`M1-29 live E2E requires ${name}`)
  return value
}

function redactDiagnostic(message: string): string {
  return message
    .replace(/(?:sk|key)-[A-Za-z0-9_-]+/gi, '[redacted]')
    .replace(/(authorization|api[-_ ]?key)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]')
}

async function runLiveDemo(model: LiveModel): Promise<QueryEvent[]> {
  const providerRegistry = new ProviderRegistry()
  providerRegistry.register('live', model.provider())
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 110_000)

  const context: QueryContext = {
    runId: `m1-live-${model.name.toLowerCase()}`,
    conversationId: `m1-live-${model.name.toLowerCase()}`,
    cwd: workspaceRoot,
    messages: [{
      role: 'user',
      content: [
        'Inspect the current workspace.',
        'First call list_dir with path ".".',
        'Then identify the largest file from its size and call read_file for that file.',
        'Finally summarize the file and include the exact marker found inside it.',
        'Do not call any tool more than once.',
      ].join(' '),
    }],
    tools: createWorkspaceTools(),
    memory: new InMemoryState(),
    model: { provider: 'live', model: model.model, temperature: 0 },
    limits: {
      maxTurns: 4,
      maxTokens: 20_000,
      maxOutputTokens: 1200,
      maxToolCalls: 4,
      toolTimeoutMs: 30_000,
    },
    signal: controller.signal,
    providerRegistry,
    workspace: createWorkspaceHandle(workspaceRoot),
    platform: 'tauri',
  }

  const events: QueryEvent[] = []
  try {
    for await (const event of runQuery(context)) events.push(event)
  } finally {
    clearTimeout(timeout)
  }
  return events
}

function createWorkspaceTools(): Tool[] {
  return [listDirTool as Tool, readFileTool as Tool]
}

function createWorkspaceHandle(root: string): ToolUseContext['workspace'] {
  return {
    root,
    name: basename(root),
    resolve: (path) => safePath(root, path),
    contains(path) {
      try {
        safePath(root, path)
        return true
      } catch {
        return false
      }
    },
  }
}

function safePath(root: string, path: string): string {
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`Path must be relative: ${path}`)
  }
  const candidate = resolve(root, path)
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`Path escapes workspace: ${path}`)
  }
  return candidate
}
