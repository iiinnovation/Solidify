import type { ModelProvider } from '@/stores/model-store'
import type { LoadedSkill } from '@/lib/skills/types'
import type { Settings } from '@/lib/harness/types'
import type { Message, QueryContext, RunLimits } from './types'
import { getFlags, isEnabled } from '@/lib/harness/flags'
import { createProviderRegistry } from '@/lib/model'
import { providerBaseURL } from '@/lib/model/provider-url'
import { toolRegistry } from '@/lib/tools'
import { createSnapshotStore } from './snapshot'
import { isTauri } from '@/lib/tauri'
import { getSystemPrompt } from '@/lib/chat-api'
import { InMemoryState } from '@/lib/memory'
import type { WorkspaceHandle } from '@/lib/workspace'

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
  workspaceRoot?: string | null
  restoreSnapshot?: boolean
}

/** Build the browser-side runtime context without affecting the legacy chat path. */
export function createChatQueryContext(options: ChatQueryContextOptions): QueryContext {
  const providerName = options.provider.format
  const platform = isTauri ? 'tauri' : 'web'
  const selectedRoot = platform === 'tauri' ? options.workspaceRoot?.trim() : undefined
  const workspaceRoot = selectedRoot ? normalizeWorkspacePath(selectedRoot) : undefined
  const cwd = workspaceRoot || '/'
  const skill = createInlineSkill(getSystemPrompt(
    options.skillSystemPrompt,
    options.skillSkipConfirmation,
  ))
  const settings = createSettings(options.provider, cwd)
  const tools = isEnabled('toolCalling')
    ? toolRegistry.resolve({
        // A real root is mandatory before exposing desktop filesystem tools.
        platform: platform === 'tauri' && workspaceRoot ? 'tauri' : 'web',
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
    memory: new InMemoryState(),
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
          supportsTools: options.provider.supportsTools !== false,
        },
      },
    }),
    snapshots: createSnapshotStore({ platform, workspaceRoot }),
    restoreSnapshot: options.restoreSnapshot,
    settings,
    platform,
    workspace: workspaceRoot ? createWorkspaceHandle(workspaceRoot) : undefined,
  }
}

function createWorkspaceHandle(root: string): WorkspaceHandle {
  const normalizedRoot = normalizeWorkspacePath(root)
  const name = normalizedRoot.split('/').filter(Boolean).pop() ?? normalizedRoot

  return {
    root: normalizedRoot,
    name,
    resolve(path: string): string {
      if (path === '.' || path === '') return normalizedRoot
      if (/^(?:[A-Za-z]:)?\//.test(path.replace(/\\/g, '/'))) {
        throw new Error(`Path must be relative: ${path}`)
      }
      const candidate = normalizeWorkspacePath(`${normalizedRoot}/${path}`)
      if (
        normalizedRoot !== '/'
        && candidate !== normalizedRoot
        && !candidate.startsWith(`${normalizedRoot}/`)
      ) {
        throw new Error(`Path escapes workspace: ${path}`)
      }
      return candidate
    },
    contains(path: string): boolean {
      try {
        this.resolve(path)
        return true
      } catch {
        return false
      }
    },
  }
}

function normalizeWorkspacePath(path: string): string {
  const slashPath = path.replace(/\\/g, '/')
  const drive = slashPath.match(/^[A-Za-z]:/)?.[0] ?? ''
  const absolute = slashPath.startsWith('/') || Boolean(drive)
  const parts: string[] = []
  for (const part of slashPath.replace(/^[A-Za-z]:/, '').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  const prefix = drive ? `${drive}/` : absolute ? '/' : ''
  return `${prefix}${parts.join('/')}`.replace(/\/$/, '') || '/'
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
