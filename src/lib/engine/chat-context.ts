import type { ModelProvider } from '@/stores/model-store'
import type { LoadedSkill } from '@/lib/skills/types'
import type { SkillRegistryApi, SkillResourceResolver } from '@/lib/skills/types'
import { ensureUserSkillsRoot, SkillLoader } from '@/lib/skills/loader'
import { SkillRegistry } from '@/lib/skills/registry'
import { isSkillEnabled } from '@/lib/skills/settings'
import type { Settings } from '@/lib/harness/types'
import type { Message, QueryContext, RunLimits } from './types'
import { getFlags, isEnabled } from '@/lib/harness/flags'
import { createProviderRegistry } from '@/lib/model'
import { providerBaseURL } from '@/lib/model/provider-url'
import { toolRegistry } from '@/lib/tools'
import { createSnapshotStore } from './snapshot'
import { isTauri } from '@/lib/tauri'
import { createModelProviderFetch, getSystemPrompt } from '@/lib/chat-api'
import { InMemoryState, WorkspaceMemory } from '@/lib/memory'
import { configureLedgerWorkspace } from '@/lib/harness/ledger'
import type { WorkspaceHandle } from '@/lib/workspace'
import { enableSubAgents } from './sub-agent/context'
import { enablePptdPipeline } from './pptd-context'
import type { AttachmentResource } from '../attachments/types'
import { modelSupportsVision } from '../model/capabilities'

const DEFAULT_LIMITS: RunLimits = {
  maxTurns: 25,
  maxTokens: 100_000,
  maxOutputTokens: 4096,
  maxToolCalls: 50,
  toolTimeoutMs: 60_000,
}

export interface ChatQueryContextOptions {
  runId: string
  requestStartedAt?: number
  conversationId: string
  messages: readonly Message[]
  provider: ModelProvider
  signal: AbortSignal
  skillSystemPrompt?: string
  skillSkipConfirmation?: boolean
  loadedSkill?: LoadedSkill
  skillResources?: SkillResourceResolver
  skillRegistry?: SkillRegistryApi
  pptdMedia?: Readonly<Record<string, string | Uint8Array>>
  attachments?: readonly AttachmentResource[]
  workspaceRoot?: string | null
  restoreSnapshot?: boolean
}

/** Build the browser-side runtime context for both plain chat and tool-enabled Agent runs. */
export function createChatQueryContext(options: ChatQueryContextOptions): QueryContext {
  const providerName = options.provider.format
  const platform = isTauri ? 'tauri' : 'web'
  const selectedRoot = platform === 'tauri' ? options.workspaceRoot?.trim() : undefined
  const workspaceRoot = selectedRoot ? normalizeWorkspacePath(selectedRoot) : undefined
  const cwd = workspaceRoot || '/'
  const skillV2Enabled = isEnabled('skillV2')
  const skill = options.loadedSkill ?? (skillV2Enabled
    ? undefined
    : createInlineSkill(getSystemPrompt(options.skillSystemPrompt, options.skillSkipConfirmation)))
  const settings = createSettings(options.provider, cwd)
  const localWorkspaceEnabled = isEnabled('localWorkspace') && Boolean(workspaceRoot)
  configureLedgerWorkspace(localWorkspaceEnabled ? workspaceRoot ?? null : null)
  const hasAttachments = Boolean(options.attachments?.length)
  const agentToolsEnabled = getFlags().agentLoop && isEnabled('toolCalling')
  const resolvedTools = agentToolsEnabled
    ? toolRegistry.resolve({
        // A real root is mandatory before exposing desktop filesystem tools.
        platform: platform === 'tauri' && workspaceRoot ? 'tauri' : 'web',
        skillAllowedTools: skill?.metadata.allowedTools,
        skillActive: skillV2Enabled && Boolean(skill),
        skillResourceAccess: Boolean(options.skillResources),
        hasAttachments,
        userDisabledTools: settings.disabledTools,
        isOnline: typeof navigator === 'undefined' || navigator.onLine,
      })
    : []
  const tools = resolvedTools.filter((tool) =>
    (tool.name !== 'search_attachments' && tool.name !== 'read_attachment') || hasAttachments,
  )

  const maxOutputTokens = options.provider.maxOutputTokens ?? inferMaxOutputTokens(options.provider.modelId)

  const context: QueryContext = {
    runId: options.runId,
    requestStartedAt: options.requestStartedAt,
    conversationId: options.conversationId,
    cwd,
    messages: options.messages,
    tools,
    skill,
    skillResources: options.skillResources,
    skillRegistry: options.skillRegistry,
    pptdMedia: options.pptdMedia,
    attachments: options.attachments,
    memory: localWorkspaceEnabled && workspaceRoot ? new WorkspaceMemory(workspaceRoot) : new InMemoryState(),
    model: {
      provider: providerName,
      model: options.provider.modelId,
      temperature: 0.7,
      maxTokens: maxOutputTokens,
      contextWindow: options.provider.contextWindow ?? inferContextWindow(options.provider.modelId),
    },
    limits: { ...DEFAULT_LIMITS, maxOutputTokens },
    signal: options.signal,
    providerRegistry: createProviderRegistry({
      [providerName]: {
        type: providerName,
        config: {
          apiKey: options.provider.apiKey,
          baseURL: providerBaseURL(options.provider.apiUrl, options.provider.format),
          defaultModel: options.provider.modelId,
          supportsTools: options.provider.supportsTools !== false,
          supportsVision: modelSupportsVision(options.provider.modelId, options.provider.supportsVision),
          timeout: 60000,
          maxRetries: 2,
          fetch: createModelProviderFetch(options.provider),
        },
      },
    }),
    snapshots: createSnapshotStore({ platform, workspaceRoot }),
    restoreSnapshot: options.restoreSnapshot,
    settings,
    platform,
    workspace: workspaceRoot ? createWorkspaceHandle(workspaceRoot) : undefined,
  }
  const withSubAgents = agentToolsEnabled && isEnabled('subAgents') ? enableSubAgents(context) : context
  return agentToolsEnabled ? enablePptdPipeline(withSubAgents) : withSubAgents
}

export interface ChatSkillRuntime {
  registry: SkillRegistry
  loader: SkillLoader
  skill?: LoadedSkill
  resources?: SkillResourceResolver
}

interface CachedChatSkillRegistry {
  loader: SkillLoader
  registry: SkillRegistry
  loadedAt: number
}

const CHAT_SKILL_REGISTRY_TTL_MS = 30_000
const chatSkillRegistryCache = new Map<string, Promise<CachedChatSkillRegistry>>()

/** Resolve the selected Skill once before a run; the query loop stays synchronous. */
export async function loadChatSkillRuntime(options: {
  workspaceRoot?: string | null
  skillName?: string
}): Promise<ChatSkillRuntime> {
  const cacheKey = normalizeWorkspacePath(options.workspaceRoot?.trim() || '/')
  let pending = chatSkillRegistryCache.get(cacheKey)
  if (!pending) {
    pending = cacheChatSkillRegistry(cacheKey, options.workspaceRoot)
  }
  let cached = await pending
  if (Date.now() - cached.loadedAt >= CHAT_SKILL_REGISTRY_TTL_MS) {
    // Only the first caller that still observes the stale promise replaces it;
    // concurrent callers join the replacement instead of starting more scans.
    const current = chatSkillRegistryCache.get(cacheKey)
    if (current === pending) {
      pending = cacheChatSkillRegistry(cacheKey, options.workspaceRoot)
    } else if (current) {
      pending = current
    }
    cached = await pending
  }
  const { loader, registry } = cached
  // Persisted conversations created before PPTD used `presentation`. Keep the
  // identifier as an input-only migration alias while exposing one PPT Skill.
  const skillName = options.skillName === 'presentation' ? 'pptd-deck' : options.skillName
  const skill = skillName && isSkillEnabled(skillName)
    ? await registry.resolve(skillName)
    : undefined
  return {
    registry,
    loader,
    skill: skill ?? undefined,
    resources: skill ? loader.createResourceResolver(skill) : undefined,
  }
}

function cacheChatSkillRegistry(cacheKey: string, workspaceRoot?: string | null): Promise<CachedChatSkillRegistry> {
  const pending = createChatSkillRegistry(workspaceRoot)
  chatSkillRegistryCache.set(cacheKey, pending)
  void pending.catch(() => {
    if (chatSkillRegistryCache.get(cacheKey) === pending) chatSkillRegistryCache.delete(cacheKey)
  })
  return pending
}

async function createChatSkillRegistry(workspaceRoot?: string | null): Promise<CachedChatSkillRegistry> {
  const loader = new SkillLoader({
    workspaceRoot,
    userSkillsRoot: await ensureUserSkillsRoot(),
  })
  const registry = new SkillRegistry(loader)
  await registry.reload()
  return { loader, registry, loadedAt: Date.now() }
}

/** Test hook for callers that require an immediate rescan. */
export function clearChatSkillRuntimeCache(): void {
  chatSkillRegistryCache.clear()
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

/**
 * Best-effort context window by model family, used only when the provider
 * config does not declare one. Deliberately conservative: under-estimating
 * costs a little history, over-estimating means the request is rejected
 * outright by the provider after trimming has already decided it fits.
 */
function inferContextWindow(modelId: string): number | undefined {
  const id = modelId.toLowerCase()
  if (id.includes('claude')) return 200_000
  if (id.includes('gpt-4o') || id.includes('gpt-4.1') || id.includes('gpt-5')) return 128_000
  if (id.includes('gpt-4-turbo')) return 128_000
  if (id.includes('gpt-3.5') && id.includes('16k')) return 16_384
  if (id.includes('gpt-3.5')) return 16_384
  if (id.includes('deepseek')) return 64_000
  if (id.includes('qwen') || id.includes('glm') || id.includes('moonshot')) return 128_000
  return undefined
}

/**
 * Output ceilings are a separate budget from the context window, and asking for
 * more than a model allows is a hard 400 rather than a silent clamp — so every
 * branch stays at or below the documented limit and unknown ids keep the
 * conservative shared default. A single deliverable routinely needs more than
 * the old flat 4096, which truncated decks mid-page.
 */
function inferMaxOutputTokens(modelId: string): number {
  const id = modelId.toLowerCase()
  if (id.includes('claude')) {
    if (id.includes('claude-3-5') || id.includes('claude-3.5')) return 8_192
    if (id.includes('claude-3-')) return 4_096
    return 32_000
  }
  if (id.includes('gpt-5') || id.includes('gpt-4.1')) return 32_768
  if (id.includes('gpt-4o')) return 16_384
  if (id.includes('gpt-4-turbo') || id.includes('gpt-3.5')) return 4_096
  if (id.includes('deepseek-reasoner')) return 32_768
  if (id.includes('deepseek')) return 8_192
  if (id.includes('qwen') || id.includes('glm') || id.includes('moonshot')) return 8_192
  return DEFAULT_LIMITS.maxOutputTokens
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
      version: '1.0.0',
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
      maxTokens: provider.maxOutputTokens ?? inferMaxOutputTokens(provider.modelId),
    },
    ui: { theme: 'auto', fontSize: 14, codeTheme: 'default', compactMode: false },
    privacy: { allowTelemetry: false, allowCrashReports: false, shareUsageData: false },
    features: getFlags(),
    disabledTools: [],
    workspaceRoot: cwd,
  }
}
