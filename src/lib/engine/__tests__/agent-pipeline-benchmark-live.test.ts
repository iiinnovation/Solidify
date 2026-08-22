/// <reference types="node" />
// @vitest-environment node

/**
 * Explicitly opt-in live benchmark runner.
 *
 * This file is intentionally skipped in the normal suite. A paid provider
 * run requires both AGENT_PIPELINE_BENCHMARK=true and an output path, so a
 * developer cannot trigger network calls by merely running `vitest`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { runQuery } from '../query'
import type { Message, QueryContext, QueryEvent } from '../types'
import { InMemoryState } from '../../memory'
import { AnthropicProvider, OpenAIProvider, ProviderRegistry } from '../../model'
import { providerBaseURL } from '../../model/provider-url'
import type { ModelProvider } from '../../model/provider'
import { toolRegistry } from '../../tools'
import { SkillLoader } from '../../skills/loader'
import { SkillRegistry } from '../../skills/registry'
import type { LoadedSkill, SkillResourceResolver } from '../../skills/types'
import { chooseAttachmentContextMode, createAttachmentResourceId, formatAttachmentManifest, formatInlineAttachments, buildAttachmentEvidencePack, type AttachmentResource } from '../../attachments/types'
import { enablePptdPipeline } from '../pptd-context'
import { RunLedger } from '../../harness/ledger'
import { deriveBenchmarkObservation, type BenchmarkObservationRow } from '../../harness/telemetry'
import casesDocument from '../../../../benchmarks/agent-pipeline/cases.json'
import { vi } from 'vitest'

vi.mock('@/lib/tauri', () => ({
  isTauri: false,
  listenWorkspaceChanges: async () => () => undefined,
  readWorkspaceFile: async () => { throw new Error('Unexpected workspace read in live benchmark') },
  readWorkspaceBytes: async () => { throw new Error('Unexpected workspace byte read in live benchmark') },
  appendWorkspaceRecord: async () => undefined,
}))

interface BenchmarkCase {
  id: string
  kind: string
  prompt: string
  skill?: string
  attachment?: string
}

interface LiveProvider {
  id: string
  model: string
  format: 'anthropic' | 'openai'
  apiKey: string
  baseURL: string
  create: () => ModelProvider
}

interface ReviewPacketRow {
  provider: string
  caseId: string
  model: string
  runId: string
  status: 'completed' | 'failed'
  output: string
}

const LIVE = process.env.AGENT_PIPELINE_BENCHMARK === 'true'
const OUTPUT_PATH = process.env.AGENT_PIPELINE_RESULTS?.trim()
const REVIEW_PATH = process.env.AGENT_PIPELINE_REVIEW_OUTPUT?.trim()
const RUNTIME_VERSION = process.env.AGENT_PIPELINE_RUNTIME_VERSION?.trim() || 'm4r-14.3'
const cases = (casesDocument.cases as BenchmarkCase[])
const observations: BenchmarkObservationRow[] = []
const reviewPacket: ReviewPacketRow[] = []
let registry: SkillRegistry

describe.skipIf(!LIVE)('agent pipeline live benchmark', () => {
  const providers = liveProviders()
  const benchmarkCases = selectedCases()

  beforeAll(async () => {
    if (!OUTPUT_PATH) throw new Error('Live benchmark requires AGENT_PIPELINE_RESULTS; no provider call was made')
    installMemoryStorage()
    const loader = new SkillLoader({
      fileSystem: {
        listDirectories: async () => [],
        readFile: async () => { throw new Error('Unexpected external Skill read') },
      },
    })
    registry = new SkillRegistry(loader)
    await registry.reload()
  })

  afterAll(async () => {
    if (!LIVE || !OUTPUT_PATH) return
    await writeJson(OUTPUT_PATH, {
      schemaVersion: 'agent-pipeline-observations/v1',
      suite: casesDocument.version,
      runtimeVersion: RUNTIME_VERSION,
      generatedAt: new Date().toISOString(),
      observations,
    })
    if (REVIEW_PATH) {
      await writeJson(REVIEW_PATH, {
        schemaVersion: 'agent-pipeline-review-packet/v1',
        suite: casesDocument.version,
        generatedAt: new Date().toISOString(),
        rows: reviewPacket,
      })
    }
    process.stdout.write(`${JSON.stringify({
      agentPipelineBenchmark: {
        providers: providers.map((provider) => provider.id),
        cases: benchmarkCases.length,
        observations: observations.length,
        output: OUTPUT_PATH,
        reviewPacket: REVIEW_PATH ?? null,
      },
    })}\n`)
  })

  for (const provider of providers) {
    for (const benchmarkCase of benchmarkCases) {
      it(`${provider.id}/${benchmarkCase.id}`, async () => {
        const row = await executeCase(provider, benchmarkCase)
        observations.push(row.observation)
        reviewPacket.push(row.review)
        // Persist after every case so an interrupted long run still leaves
        // usable objective facts. The gate will reject incomplete matrices.
        await writeJson(OUTPUT_PATH!, {
          schemaVersion: 'agent-pipeline-observations/v1',
          suite: casesDocument.version,
          runtimeVersion: RUNTIME_VERSION,
          generatedAt: new Date().toISOString(),
          observations,
        })
        if (REVIEW_PATH) {
          await writeJson(REVIEW_PATH, {
            schemaVersion: 'agent-pipeline-review-packet/v1',
            suite: casesDocument.version,
            generatedAt: new Date().toISOString(),
            rows: reviewPacket,
          })
        }
        expect(row.observation.runId).toContain(`agent-pipeline-${provider.id}-${benchmarkCase.id}`)
      }, 45 * 60_000)
    }
  }
})

function liveProviders(): LiveProvider[] {
  if (!LIVE) return []
  const requested = new Set((process.env.AGENT_PIPELINE_PROVIDERS ?? '')
    .split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))
  if (requested.size === 0) throw new Error('AGENT_PIPELINE_PROVIDERS is required (claude,gpt,deepseek)')
  const providers: LiveProvider[] = []
  if (requested.has('claude') || requested.has('anthropic')) {
    providers.push({
      id: 'claude', model: envOr('M1_CLAUDE_MODEL', 'claude-sonnet-4-20250514'), format: 'anthropic',
      apiKey: requireEnv('ANTHROPIC_API_KEY'),
      baseURL: providerBaseURL(envOr('M1_ANTHROPIC_BASE_URL', 'https://api.anthropic.com/v1/messages'), 'anthropic'),
      create: () => new AnthropicProvider({ apiKey: requireEnv('ANTHROPIC_API_KEY'), baseURL: providerBaseURL(envOr('M1_ANTHROPIC_BASE_URL', 'https://api.anthropic.com/v1/messages'), 'anthropic') }),
    })
  }
  if (requested.has('gpt') || requested.has('openai')) {
    providers.push({
      id: 'gpt', model: envOr('M1_GPT_MODEL', 'gpt-4o'), format: 'openai',
      apiKey: requireEnv('OPENAI_API_KEY'),
      baseURL: providerBaseURL(envOr('M1_OPENAI_BASE_URL', 'https://api.openai.com/v1/chat/completions'), 'openai'),
      create: () => new OpenAIProvider({ apiKey: requireEnv('OPENAI_API_KEY'), baseURL: providerBaseURL(envOr('M1_OPENAI_BASE_URL', 'https://api.openai.com/v1/chat/completions'), 'openai') }),
    })
  }
  if (requested.has('deepseek')) {
    providers.push({
      id: 'deepseek', model: envOr('M1_DEEPSEEK_MODEL', 'deepseek-chat'), format: 'openai',
      apiKey: requireEnv('DEEPSEEK_API_KEY'),
      baseURL: providerBaseURL(envOr('M1_DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1/chat/completions'), 'openai'),
      create: () => new OpenAIProvider({ apiKey: requireEnv('DEEPSEEK_API_KEY'), baseURL: providerBaseURL(envOr('M1_DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1/chat/completions'), 'openai') }),
    })
  }
  if (providers.length === 0) throw new Error('AGENT_PIPELINE_PROVIDERS selected no known provider')
  return providers
}

function selectedCases(): BenchmarkCase[] {
  const requested = process.env.AGENT_PIPELINE_CASES?.split(',').map((item) => item.trim()).filter(Boolean)
  if (!requested?.length) return cases
  const selected = cases.filter((item) => requested.includes(item.id))
  const unknown = requested.filter((id) => !cases.some((item) => item.id === id))
  if (unknown.length) throw new Error(`Unknown AGENT_PIPELINE_CASES: ${unknown.join(', ')}`)
  return selected
}

async function executeCase(provider: LiveProvider, benchmarkCase: BenchmarkCase): Promise<{ observation: BenchmarkObservationRow; review: ReviewPacketRow }> {
  const runId = `agent-pipeline-${provider.id}-${benchmarkCase.id}-${Date.now().toString(36)}`
  const attachment = benchmarkCase.attachment ? fixtureAttachment(benchmarkCase.attachment) : undefined
  const attachments = attachment ? [attachment] : []
  const runtime = benchmarkCase.skill ? await loadSkill(benchmarkCase.skill) : { skill: undefined, resources: undefined }
  const attachmentMode = chooseAttachmentContextMode({ resources: attachments, userContent: benchmarkCase.prompt, contextWindow: 32_000, reservedTokens: 4_000 })
  const enriched = enrichPrompt(benchmarkCase.prompt, attachments, attachmentMode)
  const messages = createMessages(enriched, benchmarkCase.attachment === 'image' ? attachment : undefined)
  const providerRegistry = new ProviderRegistry()
  providerRegistry.register('live', provider.create())
  const context = createBenchmarkContext({
    runId, provider, messages, attachments, attachmentMode,
    skill: runtime.skill, skillResources: runtime.resources, providerRegistry,
  })
  const events: QueryEvent[] = []
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 40 * 60_000)
  let streamedText = ''
  let firstArtifactAt: number | undefined
  try {
    for await (const event of runQuery({ ...context, signal: controller.signal })) {
      events.push(event)
      if (event.type === 'message.delta') {
        streamedText += event.text
        if (firstArtifactAt === undefined && streamedText.includes('<solidify-artifact')) firstArtifactAt = Date.now()
      }
    }
  } finally {
    clearTimeout(timeout)
  }
  const ledger = new RunLedger(runId)
  const ledgerEvents = ledger.events()
  const terminal = [...events].reverse().find((event) => event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.exhausted')
  if (!terminal || ledgerEvents.length === 0) throw new Error(`Live benchmark ${runId} produced no terminal ledger`)
  const observation = deriveBenchmarkObservation(ledgerEvents, {
    caseId: benchmarkCase.id, provider: provider.id, model: provider.model, runtimeVersion: RUNTIME_VERSION,
  }, { firstArtifactAt })
  const output = [...events].reverse().find((event): event is Extract<QueryEvent, { type: 'message.completed' }> => event.type === 'message.completed')?.content ?? ''
  if (terminal.type === 'run.failed') {
    process.stdout.write(`${JSON.stringify({
      agentPipelineBenchmarkFailure: {
        provider: provider.id,
        caseId: benchmarkCase.id,
        kind: terminal.error.kind,
        message: redactDiagnostic(terminal.error.message),
      },
    })}\n`)
  }
  return {
    observation,
    review: { provider: provider.id, caseId: benchmarkCase.id, model: provider.model, runId, status: observation.status, output },
  }
}

async function loadSkill(name: string): Promise<{ skill?: LoadedSkill; resources?: SkillResourceResolver }> {
  const skill = await registry.resolve(name)
  if (!skill) throw new Error(`Bundled Skill unavailable in benchmark: ${name}`)
  // Registry.resources is the public resolver and keeps the benchmark aligned
  // with production resource boundaries.
  return { skill, resources: await registry.resources(name) }
}

function createBenchmarkContext(input: {
  runId: string
  provider: LiveProvider
  messages: readonly Message[]
  attachments: readonly AttachmentResource[]
  attachmentMode: 'inline' | 'retrieval'
  skill?: LoadedSkill
  skillResources?: SkillResourceResolver
  providerRegistry: ProviderRegistry
}): QueryContext {
  const settings = {
    model: { provider: input.provider.format, model: input.provider.model, temperature: 0, maxTokens: 8_192 },
    ui: { theme: 'auto' as const, fontSize: 14, codeTheme: 'default', compactMode: false },
    privacy: { allowTelemetry: false, allowCrashReports: false, shareUsageData: false },
    features: { agentLoop: true, toolCalling: true, harness: true, localWorkspace: false, workbenchV2: false, skillV2: true, pptdEngine: true, subAgents: false },
    disabledTools: [], workspaceRoot: '/',
  }
  const tools = toolRegistry.resolve({
    platform: 'web', skillAllowedTools: input.skill?.metadata.allowedTools, skillActive: Boolean(input.skill),
    skillResourceAccess: Boolean(input.skillResources), minimalUnselected: !input.skill,
    hasAttachments: input.attachments.length > 0, userDisabledTools: [], isOnline: true,
  }).filter((tool) => !['search_attachments', 'read_attachment', 'prepare_attachment_evidence'].includes(tool.name) || input.attachmentMode !== 'inline')
  const context: QueryContext = {
    runId: input.runId, conversationId: input.runId, cwd: '/', messages: input.messages, tools,
    skill: input.skill, skillResources: input.skillResources, skillRegistry: registry,
    attachments: input.attachments, attachmentMode: input.attachmentMode, memory: new InMemoryState(),
    model: { provider: 'live', model: input.provider.model, temperature: 0, contextWindow: 32_000, maxTokens: 8_192 },
    limits: { maxTurns: 12, maxTokens: 60_000, maxOutputTokens: 8_192, maxToolCalls: 16, toolTimeoutMs: 90_000 },
    signal: new AbortController().signal, providerRegistry: input.providerRegistry, platform: 'web', settings,
  }
  return enablePptdPipeline(context)
}

function createMessages(content: string, image?: AttachmentResource): Message[] {
  if (!image?.mediaUrl) return [{ role: 'user', content }]
  return [{ role: 'user', content: [{ type: 'text', text: content }, { type: 'image_url', image_url: { url: image.mediaUrl } }] }]
}

function enrichPrompt(prompt: string, attachments: readonly AttachmentResource[], mode: 'inline' | 'retrieval'): string {
  if (attachments.length === 0) return prompt
  if (mode === 'inline') return `${prompt}${formatInlineAttachments(attachments)}`
  const evidence = buildAttachmentEvidencePack(attachments, undefined, 16_000)
  return `${prompt}\n\n${formatAttachmentManifest(attachments, evidence ? { includePreview: false } : undefined)}${evidence ? `\n\n<attachment_evidence_pack>\n${evidence.content}\n</attachment_evidence_pack>` : ''}`
}

function fixtureAttachment(kind: string): AttachmentResource {
  const base = kind === 'small-markdown'
    ? '# 客户访谈\n\n客户需要统一查看项目进度；项目经理可以更新状态；普通成员只能查看。\n\n约束：保留审批记录，支持导出。'
    : kind === 'large-markdown'
      ? `# 项目材料\n\n${Array.from({ length: 40 }, (_, index) => `## 证据 ${index + 1}\n客户要求可追踪的交付状态，约束是本地优先存储，待确认项是导出格式。\n`).join('')}`
      : kind === 'pdf'
        ? '# PDF 事实摘录\n\n合同周期为 30 天；风险是审批延迟；待办是确认验收负责人。'
        : kind === 'office'
          ? '# Office 会议记录\n\n风险：权限边界未确认。\n待办：项目经理在周五前确认审计字段。'
          : undefined
  const imageUrl = kind === 'image' ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' : undefined
  const name = kind === 'small-markdown' ? 'interview.md' : kind === 'large-markdown' ? 'architecture.md' : `${kind}-fixture.${kind === 'office' ? 'docx' : kind === 'pdf' ? 'pdf' : 'png'}`
  const resource: AttachmentResource = { id: '', name, size: base?.length ?? 68, mimeType: kind === 'pdf' ? 'application/pdf' : kind === 'office' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : kind === 'image' ? 'image/png' : 'text/markdown', ...(base ? { text: base } : {}), ...(imageUrl ? { mediaUrl: imageUrl } : {}) }
  return { ...resource, id: createAttachmentResourceId(resource) }
}

function installMemoryStorage(): void {
  if (typeof localStorage !== 'undefined') return
  const values = new Map<string, string>()
  const storage: Storage = {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, String(value)) },
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const target = resolve(process.cwd(), path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Live benchmark requires ${name}`)
  return value
}

function envOr(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback
}

function redactDiagnostic(message: string): string {
  return message
    .replace(/(?:sk|key)-[A-Za-z0-9_-]+/gi, '[redacted]')
    .replace(/(authorization|api[-_ ]?key)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]')
    .slice(0, 500)
}
