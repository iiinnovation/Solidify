import { SkillLoader } from './loader'
import { virtualRootFor } from './loader'
import type { LoadedSkill, SkillLoadError, SkillMetadata, SkillRegistryApi } from './types'
import { isSkillEnabled } from './settings'

export type SkillRegistryListener = (result: { skills: LoadedSkill[]; errors: SkillLoadError[] }) => void | Promise<void>

const DEFAULT_INDEX_TOKEN_BUDGET = 599

/** Build the compact layer-0 prompt. Descriptions are clipped, never omitted silently. */
export function formatSkillIndex(
  metadata: readonly SkillMetadata[],
  maxTokens = DEFAULT_INDEX_TOKEN_BUDGET,
  options: { includePaths?: boolean } = {},
): string {
  const includePaths = options.includePaths ?? true
  const header = includePaths
    ? '可用的 Skill（需要详情时，用 read_file 读取对应的 SKILL.md）：'
    : '可用的 Skill（需要时由 Agent 激活对应能力）：'
  const lines: string[] = [header]
  for (const item of metadata) {
    if (!isSkillEnabled(item.name)) continue
    const label = item.displayName && item.displayName !== item.name ? `${item.displayName} / ${item.name}` : item.name
    const prefix = `- ${label}: `
    const suffix = includePaths ? `（详情：${virtualRootFor(item.name)}/SKILL.md）` : ''
    const remaining = Math.max(0, maxTokens - estimatePromptTokens(lines.join('\n') + '\n' + prefix + suffix))
    const description = clipToPromptTokens(item.description, remaining)
    const line = `${prefix}${description}${suffix}`
    if (estimatePromptTokens(lines.join('\n') + '\n' + line) > maxTokens && lines.length > 1) break
    lines.push(line)
  }
  return lines.join('\n')
}

/** In-memory registry backed by the filesystem loader. */
export class SkillRegistry implements SkillRegistryApi {
  private readonly loader: SkillLoader
  private readonly skills = new Map<string, LoadedSkill>()
  private errors: SkillLoadError[] = []
  private loaded = false
  private listeners = new Set<SkillRegistryListener>()
  private stopWatchingSubscription: (() => void) | null = null

  constructor(loader = new SkillLoader()) {
    this.loader = loader
  }

  async load(path: string): Promise<LoadedSkill> {
    return this.loader.loadDirectory(path)
  }

  async reload(): Promise<{ skills: LoadedSkill[]; errors: SkillLoadError[] }> {
    const result = await this.loader.load()
    this.skills.clear()
    for (const skill of result.skills) this.skills.set(skill.metadata.name, skill)
    this.errors = result.errors
    this.loaded = true
    await Promise.all([...this.listeners].map(async (listener) => { await listener(result) }))
    return result
  }

  async list(): Promise<SkillMetadata[]> {
    if (!this.loaded) await this.reload()
    return [...this.skills.values()].map((skill) => skill.metadata)
  }

  async resolve(name: string): Promise<LoadedSkill | null> {
    if (!this.loaded) await this.reload()
    return this.skills.get(name) ?? null
  }

  async resources(name: string) {
    const skill = await this.resolve(name)
    return skill ? this.loader.createResourceResolver(skill) : undefined
  }

  getErrors(): SkillLoadError[] {
    return [...this.errors]
  }

  subscribe(listener: SkillRegistryListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async startWatching(): Promise<() => void> {
    this.stopWatchingSubscription?.()
    this.stopWatchingSubscription = await this.loader.watch(() => this.reload().then(() => undefined))
    return () => {
      this.stopWatchingSubscription?.()
      this.stopWatchingSubscription = null
    }
  }

  async stopWatching(): Promise<void> {
    this.stopWatchingSubscription?.()
    this.stopWatchingSubscription = null
  }
}

function estimatePromptTokens(text: string): number {
  let cjk = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) cjk++
  }
  return Math.ceil(cjk + ([...text].length - cjk) / 4)
}

function clipToPromptTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return ''
  if (estimatePromptTokens(text) <= maxTokens) return text
  let output = ''
  for (const char of text) {
    const candidate = `${output}${char}…`
    if (estimatePromptTokens(candidate) > maxTokens) break
    output += char
  }
  return `${output}…`
}
