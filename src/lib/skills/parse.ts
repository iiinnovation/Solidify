import { load as parseYaml } from 'js-yaml'
import type { SkillLoadError, SkillMetadata, LoadedSkill, SkillSource } from './types'

const FRONTMATTER = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export class SkillParseError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'SkillParseError'
    this.path = path
  }
}

/** Parse and validate a SKILL.md document. Invalid metadata is an explicit error. */
export function parseSkillDocument(content: string, path: string, source?: SkillSource): LoadedSkill {
  const match = content.match(FRONTMATTER)
  if (!match) throw new SkillParseError(path, '缺少 frontmatter（文件必须以 --- 开始）')

  let raw: unknown
  try {
    raw = parseYaml(match[1])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new SkillParseError(path, `frontmatter YAML 无效：${message}`)
  }

  if (!isRecord(raw)) throw new SkillParseError(path, 'frontmatter 必须是对象')
  const name = requiredString(raw.name, path, 'name')
  if (!NAME_PATTERN.test(name)) throw new SkillParseError(path, 'name 必须是 kebab-case')
  const version = requiredString(raw.version, path, 'version')
  if (!VERSION_PATTERN.test(version)) throw new SkillParseError(path, 'version 必须是语义化版本（如 1.0.0）')
  const description = requiredString(raw.description, path, 'description')

  const metadata: SkillMetadata = {
    name,
    version,
    description,
    displayName: optionalString(raw.displayName, path, 'displayName'),
    icon: optionalString(raw.icon, path, 'icon'),
    placeholder: optionalString(raw.placeholder, path, 'placeholder'),
    skipConfirmation: optionalBoolean(raw['skip-confirmation'], path, 'skip-confirmation'),
    author: optionalString(raw.author, path, 'author'),
    allowedTools: optionalStringArray(raw['allowed-tools'], path, 'allowed-tools'),
    recommendedModels: optionalStringArray(raw['recommended-models'], path, 'recommended-models'),
    tags: optionalStringArray(raw.tags, path, 'tags'),
    stage: optionalString(raw.stage, path, 'stage'),
    source,
    directory: path.replace(/[\\/]SKILL\.md$/, ''),
  }

  return {
    metadata: compactMetadata(metadata),
    content: content.slice(match[0].length).trim(),
    path,
    source,
  }
}

export function toSkillLoadError(error: unknown, fallbackPath: string): SkillLoadError {
  return {
    path: error instanceof SkillParseError ? error.path : fallbackPath,
    message: error instanceof Error ? error.message : String(error),
  }
}

function requiredString(value: unknown, path: string, field: string): string {
  const result = optionalString(value, path, field)
  if (!result) throw new SkillParseError(path, `缺少必填字段 ${field}`)
  return result
}

function optionalString(value: unknown, path: string, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new SkillParseError(path, `${field} 必须是非空字符串`)
  return value.trim()
}

function optionalStringArray(value: unknown, path: string, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new SkillParseError(path, `${field} 必须是字符串数组`)
  }
  return value.map((item) => item.trim())
}

function optionalBoolean(value: unknown, path: string, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new SkillParseError(path, `${field} 必须是布尔值`)
  return value
}

function compactMetadata(metadata: SkillMetadata): SkillMetadata {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)) as SkillMetadata
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
