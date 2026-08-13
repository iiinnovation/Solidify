import type { ModelProvider } from '@/stores/model-store'
import type { LoadedSkill } from '@/lib/skills/types'
import type { MemoryFragment, MemoryState } from '@/lib/memory/types'
import type { Settings } from '@/lib/harness/types'
import type { Message, QueryContext, RunLimits } from './types'
import { getFlags, isEnabled } from '@/lib/harness/flags'
import { createProviderRegistry } from '@/lib/model'
import { providerBaseURL } from '@/lib/model/provider-url'
import { toolRegistry } from '@/lib/tools'
import { createSnapshotStore } from './snapshot'
import { isTauri } from '@/lib/tauri'
import { getSystemPrompt } from '@/lib/chat-api'

const DEFAULT_LIMITS: RunLimits = {
  maxTurns: 25,
  maxTokens: 100_000,
  maxOutputTokens: 4096,
  maxToolCalls: 50,
  toolTimeoutMs: 60_000,
}

export interface ChatQueryContextOptions {
  runId: string
  conversationId: string
  messages: readonly Message[]
  provider: ModelProvider
  signal: AbortSignal
  skillSystemPrompt?: string
  skillSkipConfirmation?: boolean
}

/** Build the browser-side runtime context without affecting the legacy chat path. */
export function createChatQueryContext(options: ChatQueryContextOptions): QueryContext {
  const providerName = options.provider.format
  const platform = isTauri ? 'tauri' : 'web'
  const cwd = isTauri ? '.' : '/'
  const skill = createInlineSkill(getSystemPrompt(
    options.skillSystemPrompt,
    options.skillSkipConfirmation,
  ))
  const settings = createSettings(options.provider, cwd)
  const tools = isEnabled('toolCalling')
    ? toolRegistry.resolve({
        // Local workspace selection lands in M3. Until then, do not expose
        // desktop file tools against the process working directory.
        platform: 'web',
        skillAllowedTools: skill?.metadata.allowedTools,
        userDisabledTools: settings.disabledTools,
        isOnline: typeof navigator === 'undefined' || navigator.onLine,
      })
    : []

  return {
    runId: options.runId,
    conversationId: options.conversationId,
    cwd,
    messages: options.messages,
    tools,
    skill,
    memory: createRunMemory(),
    model: {
      provider: providerName,
      model: options.provider.modelId,
      temperature: 0.7,
      maxTokens: DEFAULT_LIMITS.maxOutputTokens,
    },
    limits: { ...DEFAULT_LIMITS },
    signal: options.signal,
    providerRegistry: createProviderRegistry({
      [providerName]: {
        type: providerName,
        config: {
          apiKey: options.provider.apiKey,
          baseURL: providerBaseURL(options.provider.apiUrl, options.provider.format),
          defaultModel: options.provider.modelId,
        },
      },
    }),
    snapshots: createSnapshotStore({ platform }),
    settings,
    platform,
  }
}

function createInlineSkill(content?: string): LoadedSkill | undefined {
  if (!content?.trim()) return undefined
  return {
    metadata: {
      name: 'chat-skill',
      version: '1',
      description: 'Skill selected from the chat palette',
    },
    content,
    path: 'chat://skill',
  }
}

function createSettings(provider: ModelProvider, cwd: string): Settings {
  return {
    model: {
      provider: provider.format,
      model: provider.modelId,
      apiKey: provider.apiKey,
      baseUrl: providerBaseURL(provider.apiUrl, provider.format),
      temperature: 0.7,
      maxTokens: DEFAULT_LIMITS.maxOutputTokens,
    },
    ui: { theme: 'auto', fontSize: 14, codeTheme: 'default', compactMode: false },
    privacy: { allowTelemetry: false, allowCrashReports: false, shareUsageData: false },
    features: getFlags(),
    disabledTools: [],
    workspaceRoot: cwd,
  }
}

function createRunMemory(): MemoryState {
  const values = new Map<string, string>()
  let nextId = 0

  return {
    async store(data) {
      const id = `memory-${++nextId}`
      values.set(id, data)
      return id
    },
    async retrieve(handle) {
      return values.get(handle) ?? null
    },
    async search(query, limit = 10) {
      const normalized = query.toLowerCase()
      return Array.from(values.entries())
        .filter(([, value]) => value.toLowerCase().includes(normalized))
        .slice(0, limit)
        .map(([source, content]): MemoryFragment => ({
          content,
          relevance: 1,
          source,
          timestamp: new Date().toISOString(),
        }))
    },
    async clear() {
      values.clear()
    },
  }
}
