import type { Skill } from '@/lib/skills'
import { ensureUserSkillsRoot } from './loader'
import type { SkillPackageFiles } from './package'

export interface SkillDirectoryWriter {
  mkdir(path: string): Promise<void>
  writeFile(path: string, content: string): Promise<void>
  exists?(path: string): Promise<boolean>
}

export interface SkillMigrationResult {
  migrated: string[]
  skipped: string[]
  errors: Array<{ id: string; message: string }>
}

const MIGRATION_MARKER = 'solidify-skill-v2-migrated'

/** Convert the persisted legacy Skill records into SKILL.md directories. */
export async function migrateCustomSkills(
  skills: readonly Skill[],
  root: string,
  writer: SkillDirectoryWriter,
): Promise<SkillMigrationResult> {
  const result: SkillMigrationResult = { migrated: [], skipped: [], errors: [] }
  const usedNames = new Set<string>()

  for (const skill of skills) {
    try {
      const normalizedRoot = root.replace(/[\\/]$/, '')
      const name = await availableSkillName(skill.id, normalizedRoot, usedNames, writer)
      const directory = `${normalizedRoot}/${name}`
      await writer.mkdir(directory)
      await writer.writeFile(`${directory}/SKILL.md`, serializeLegacySkill(skill, name))
      usedNames.add(name)
      result.migrated.push(skill.id)
    } catch (error) {
      result.errors.push({ id: skill.id, message: error instanceof Error ? error.message : String(error) })
    }
  }

  return result
}

/** One-shot browser/Tauri migration entry point used during app startup. */
export async function migrateStoredCustomSkills(): Promise<SkillMigrationResult | null> {
  if (typeof localStorage === 'undefined') return null
  const root = await ensureUserSkillsRoot()
  if (localStorage.getItem(MIGRATION_MARKER) === 'true') return null
  const raw = localStorage.getItem('solidify-custom-skills')
  if (!raw) {
    localStorage.setItem(MIGRATION_MARKER, 'true')
    return { migrated: [], skipped: [], errors: [] }
  }
  const skills = readCustomSkills(raw)
  if (!skills) return { migrated: [], skipped: [], errors: [{ id: 'storage', message: '自定义 Skill 存储格式无效，未删除原数据。' }] }
  if (!root) return { migrated: [], skipped: skills.map((skill) => skill.id), errors: [] }

  const writer = await createTauriWriter()
  const result = await migrateCustomSkills(skills, root, writer)
  if (result.errors.length === 0) localStorage.setItem(MIGRATION_MARKER, 'true')
  return result
}

/** Write a user-level SKILL.md through the desktop filesystem permission layer. */
export async function writeUserSkillDocument(name: string, content: string): Promise<void> {
  const root = await ensureUserSkillsRoot()
  if (!root) throw new Error('Web 端不能写入用户级 Skill')
  const writer = await createTauriWriter()
  const directory = `${root.replace(/[\\/]$/, '')}/${name}`
  await writer.mkdir(directory)
  await writer.writeFile(`${directory}/SKILL.md`, content)
}

export async function writeUserSkillPackage(name: string, files: SkillPackageFiles): Promise<void> {
  const root = await ensureUserSkillsRoot()
  if (!root) throw new Error('Web 端不能写入用户级 Skill')
  const normalizedRoot = root.replace(/[\\/]$/, '')
  const directory = `${normalizedRoot}/${name}`
  const transactionId = crypto.randomUUID()
  const staging = `${normalizedRoot}/__solidify-import-${name}-${transactionId}`
  const backup = `${normalizedRoot}/__solidify-backup-${name}-${transactionId}`
  const { exists, mkdir, remove, rename, writeFile, writeTextFile } = await import('@tauri-apps/plugin-fs')

  for (const relativePath of Object.keys(files)) {
    if (!relativePath || /^[\\/]/.test(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath) || relativePath.includes('\0') || relativePath.split(/[\\/]/).some((part) => part === '..')) {
      throw new Error(`Skill 包含非法路径：${relativePath}`)
    }
  }

  await mkdir(staging, { recursive: true })
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const parts = relativePath.split('/').filter(Boolean)
      const parent = parts.slice(0, -1).join('/')
      if (parent) await mkdir(`${staging}/${parent}`, { recursive: true })
      if (typeof content === 'string') await writeTextFile(`${staging}/${relativePath}`, content)
      else await writeFile(`${staging}/${relativePath}`, content)
    }

    const replacing = await exists(directory)
    if (replacing) await rename(directory, backup)
    try {
      await rename(staging, directory)
      if (replacing) {
        try { await remove(backup, { recursive: true }) }
        catch (error) { console.warn('[skills] Imported Skill but could not remove its backup:', error) }
      }
    } catch (error) {
      if (replacing && await exists(backup) && !await exists(directory)) await rename(backup, directory)
      throw error
    }
  } finally {
    if (await exists(staging)) await remove(staging, { recursive: true })
  }
}

export async function removeUserSkillDirectory(name: string): Promise<void> {
  const root = await ensureUserSkillsRoot()
  if (!root) throw new Error('Web 端不能删除用户级 Skill')
  const { remove } = await import('@tauri-apps/plugin-fs')
  await remove(`${root.replace(/[\\/]$/, '')}/${name}`, { recursive: true })
}

function serializeLegacySkill(skill: Skill, name: string): string {
  const lines = [
    '---',
    `name: ${name}`,
    'version: 1.0.0',
    `displayName: ${yamlScalar(skill.name)}`,
    `description: ${yamlScalar(skill.description)}`,
    `icon: ${yamlScalar(skill.icon)}`,
    `placeholder: ${yamlScalar(skill.placeholder)}`,
    `skip-confirmation: ${skill.skipConfirmation ? 'true' : 'false'}`,
    '---',
    '',
    skill.systemPrompt.trim(),
    '',
  ]
  return lines.join('\n')
}

function yamlScalar(value: string): string {
  return JSON.stringify(value)
}

async function availableSkillName(
  id: string,
  root: string,
  used: Set<string>,
  writer: SkillDirectoryWriter,
): Promise<string> {
  const base = id.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom-skill'
  let name = base
  let suffix = 2
  while (used.has(name) || await writer.exists?.(`${root}/${name}`) === true) name = `${base}-${suffix++}`
  return name
}

function readCustomSkills(raw: string): Skill[] | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const customSkills = (value as { state?: { customSkills?: unknown } }).state?.customSkills
    if (!Array.isArray(customSkills)) return null
    if (!customSkills.every(isSkill)) return null
    return customSkills
  } catch {
    return null
  }
}

function isSkill(value: unknown): value is Skill {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return ['id', 'name', 'description', 'icon', 'placeholder', 'systemPrompt'].every((key) => typeof item[key] === 'string')
    && typeof item.skipConfirmation === 'boolean'
}

async function createTauriWriter(): Promise<SkillDirectoryWriter> {
  const { exists, mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs')
  return {
    mkdir: async (path) => { await mkdir(path, { recursive: true }) },
    writeFile: async (path, content) => { await writeTextFile(path, content) },
    exists,
  }
}
