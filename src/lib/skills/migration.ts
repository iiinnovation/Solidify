import type { Skill } from '@/lib/skills'
import { ensureUserSkillsRoot } from './loader'
import type { SkillPackageFiles } from './package'

export interface SkillDirectoryWriter {
  mkdir(path: string): Promise<void>
  writeFile(path: string, content: string): Promise<void>
  exists?(path: string): Promise<boolean>
  readFile?(path: string): Promise<string>
}

export interface SkillMigrationResult {
  migrated: string[]
  skipped: string[]
  errors: Array<{ id: string; message: string }>
}

export interface SkillMigrationTelemetry {
  version: 1
  attempts: number
  /** Number of startup observations after the migration marker was written. */
  observations: number
  migrated: number
  skipped: number
  errors: number
  deferred: number
  lastStatus: 'completed' | 'deferred' | 'failed'
  lastAt: string
}

export const SKILL_MIGRATION_MARKER = 'solidify-skill-v2-migrated'
export const SKILL_MIGRATION_TELEMETRY_KEY = 'solidify-skill-v2-migration-telemetry'
export const SKILL_RUNTIME_RETIRED_MARKER = 'solidify-skill-runtime-retired'
export const SKILL_MIGRATION_OBSERVATION_SESSION_KEY = 'solidify-skill-v2-observation-session'

export interface SkillMigrationWindowStatus {
  migrated: boolean
  retired: boolean
  readyToFinalize: boolean
  observations: number
  reason: 'already-retired' | 'not-migrated' | 'insufficient-observations' | 'unclean' | 'ready'
}

let migrationInFlight: Promise<SkillMigrationResult | null> | null = null
// Fallback for non-browser test/SSR environments where sessionStorage is not
// available; Tauri/Web always use the session key below.
let migrationObservationRecorded = false

/**
 * The legacy Zustand store is a read-only compatibility surface after a
 * successful directory migration.  Keeping this decision in one module
 * prevents individual UI consumers from accidentally reintroducing writes.
 */
export function isLegacySkillStoreWriteAllowed(): boolean {
  if (typeof localStorage === 'undefined') return true
  return localStorage.getItem(SKILL_MIGRATION_MARKER) !== 'true'
}

/** True only after an explicit, evidence-backed compatibility-window close. */
export function isLegacySkillRuntimeRetired(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(SKILL_RUNTIME_RETIRED_MARKER) === 'true'
}

/**
 * Return the release/operator-facing state of the compatibility window without
 * exposing any migrated Skill content. This is deliberately separate from the
 * mutating finalize function so status checks are safe to run on every startup.
 */
export function getSkillMigrationWindowStatus(minObservations = 2): SkillMigrationWindowStatus {
  const retired = isLegacySkillRuntimeRetired()
  if (retired) return { migrated: true, retired: true, readyToFinalize: true, observations: readSkillMigrationTelemetry()?.observations ?? 0, reason: 'already-retired' }
  if (typeof localStorage === 'undefined') return { migrated: false, retired: false, readyToFinalize: false, observations: 0, reason: 'not-migrated' }
  const migrated = localStorage.getItem(SKILL_MIGRATION_MARKER) === 'true'
  if (!migrated) return { migrated: false, retired: false, readyToFinalize: false, observations: 0, reason: 'not-migrated' }
  const telemetry = readSkillMigrationTelemetry()
  const observations = telemetry?.observations ?? 0
  if (!telemetry || observations < Math.max(1, minObservations)) {
    return { migrated: true, retired: false, readyToFinalize: false, observations, reason: 'insufficient-observations' }
  }
  const clean = telemetry.lastStatus === 'completed'
    && telemetry.errors === 0
    && telemetry.skipped === 0
    && telemetry.deferred === 0
  if (!clean) return { migrated: true, retired: false, readyToFinalize: false, observations, reason: 'unclean' }
  return { migrated: true, retired: false, readyToFinalize: true, observations, reason: 'ready' }
}

/**
 * Require clean migration telemetry from at least two startup observations
 * before retiring the old runtime. The function only writes the retirement
 * marker when the caller explicitly opts into the irreversible compatibility
 * transition; migration itself never flips it automatically.
 */
export function finalizeSkillMigrationWindow(minObservations = 2): boolean {
  const status = getSkillMigrationWindowStatus(minObservations)
  if (status.retired) return true
  if (!status.readyToFinalize || typeof localStorage === 'undefined') return false
  localStorage.setItem(SKILL_RUNTIME_RETIRED_MARKER, 'true')
  return true
}

/** Read aggregate migration counters without exposing Skill bodies or names. */
export function readSkillMigrationTelemetry(): SkillMigrationTelemetry | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SKILL_MIGRATION_TELEMETRY_KEY) ?? 'null')
    if (!value || typeof value !== 'object') return null
    const item = value as Partial<SkillMigrationTelemetry>
    if (item.version !== 1 || !['completed', 'deferred', 'failed'].includes(item.lastStatus ?? '')) return null
    if (![item.attempts, item.migrated, item.skipped, item.errors, item.deferred].every(isNonNegativeInteger)) return null
    if (item.observations !== undefined && !isNonNegativeInteger(item.observations)) return null
    if (typeof item.lastAt !== 'string') return null
    return { ...item, observations: item.observations ?? 0 } as SkillMigrationTelemetry
  } catch {
    return null
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

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
      const baseName = normalizedSkillName(skill.id)
      const existingDirectory = `${normalizedRoot}/${baseName}`
      if (await writer.exists?.(existingDirectory) === true
        && await isMigratedSkillDirectory(writer, existingDirectory, skill.id, baseName)) {
        // A previous attempt may have written this Skill before another item
        // failed. Treat the matching directory as already migrated so retries
        // remain idempotent instead of creating `-2` duplicates.
        usedNames.add(baseName)
        result.migrated.push(skill.id)
        continue
      }
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
export function migrateStoredCustomSkills(): Promise<SkillMigrationResult | null> {
  // App and the Skill registry both initialize at startup. Share one promise so
  // concurrent callers cannot migrate the same localStorage snapshot twice and
  // create suffixed duplicate directories.
  if (migrationInFlight) return migrationInFlight
  migrationInFlight = migrateStoredCustomSkillsOnce().finally(() => {
    migrationInFlight = null
  })
  return migrationInFlight
}

async function migrateStoredCustomSkillsOnce(): Promise<SkillMigrationResult | null> {
  if (typeof localStorage === 'undefined') return null
  const root = await ensureUserSkillsRoot()
  if (localStorage.getItem(SKILL_MIGRATION_MARKER) === 'true') {
    if (!hasMigrationObservationBeenRecorded()) {
      recordMigrationObservation()
      markMigrationObservationRecorded()
    }
    return null
  }
  const raw = localStorage.getItem('solidify-custom-skills')
  if (!raw) {
    localStorage.setItem(SKILL_MIGRATION_MARKER, 'true')
    const result = { migrated: [], skipped: [], errors: [] }
    recordMigrationTelemetry(result, 'completed')
    markMigrationObservationRecorded()
    return result
  }
  const skills = readCustomSkills(raw)
  if (!skills) {
    const result = { migrated: [], skipped: [], errors: [{ id: 'storage', message: '自定义 Skill 存储格式无效，未删除原数据。' }] }
    recordMigrationTelemetry(result, 'failed')
    return result
  }
  if (!root) {
    const result = { migrated: [], skipped: skills.map((skill) => skill.id), errors: [] }
    recordMigrationTelemetry(result, 'deferred')
    return result
  }

  const writer = await createTauriWriter()
  const result = await migrateCustomSkills(skills, root, writer)
  if (result.errors.length === 0) {
    localStorage.setItem(SKILL_MIGRATION_MARKER, 'true')
    markMigrationObservationRecorded()
  }
  recordMigrationTelemetry(result, result.errors.length === 0 ? 'completed' : 'failed')
  return result
}

function recordMigrationTelemetry(result: SkillMigrationResult, status: SkillMigrationTelemetry['lastStatus']): void {
  if (typeof localStorage === 'undefined') return
  const previous = readSkillMigrationTelemetry()
  const next: SkillMigrationTelemetry = {
    version: 1,
    attempts: (previous?.attempts ?? 0) + 1,
    observations: previous?.observations ?? 0,
    migrated: (previous?.migrated ?? 0) + result.migrated.length,
    skipped: (previous?.skipped ?? 0) + result.skipped.length,
    errors: (previous?.errors ?? 0) + result.errors.length,
    deferred: (previous?.deferred ?? 0) + (status === 'deferred' ? 1 : 0),
    lastStatus: status,
    lastAt: new Date().toISOString(),
  }
  localStorage.setItem(SKILL_MIGRATION_TELEMETRY_KEY, JSON.stringify(next))
}

function recordMigrationObservation(): void {
  if (typeof localStorage === 'undefined') return
  const previous = readSkillMigrationTelemetry()
  if (!previous) {
    // Older builds could write the migration marker before telemetry existed.
    // Backfill an aggregate-only baseline so those installs are not stuck at
    // 0/2 forever; no Skill body or name is reconstructed here.
    localStorage.setItem(SKILL_MIGRATION_TELEMETRY_KEY, JSON.stringify({
      version: 1,
      attempts: 1,
      observations: 1,
      migrated: 0,
      skipped: 0,
      errors: 0,
      deferred: 0,
      lastStatus: 'completed',
      lastAt: new Date().toISOString(),
    } satisfies SkillMigrationTelemetry))
    return
  }
  localStorage.setItem(SKILL_MIGRATION_TELEMETRY_KEY, JSON.stringify({ ...previous, observations: previous.observations + 1 }))
}

function hasMigrationObservationBeenRecorded(): boolean {
  if (typeof sessionStorage !== 'undefined') return sessionStorage.getItem(SKILL_MIGRATION_OBSERVATION_SESSION_KEY) === 'true'
  return migrationObservationRecorded
}

function markMigrationObservationRecorded(): void {
  if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(SKILL_MIGRATION_OBSERVATION_SESSION_KEY, 'true')
  else migrationObservationRecorded = true
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
    `legacy-id: ${yamlScalar(skill.id)}`,
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

function normalizedSkillName(id: string): string {
  return id.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom-skill'
}

async function isMigratedSkillDirectory(
  writer: SkillDirectoryWriter,
  directory: string,
  legacyId: string,
  normalizedName: string,
): Promise<boolean> {
  if (!writer.readFile) return false
  try {
    const content = await writer.readFile(`${directory}/SKILL.md`)
    const legacyMatch = content.match(/^legacy-id:\s*(.+)$/m)
    if (legacyMatch) {
      try { return JSON.parse(legacyMatch[1]) === legacyId }
      catch { return false }
    }
    // Compatibility with directories produced before `legacy-id` was added.
    const nameMatch = content.match(/^name:\s*([^\r\n]+)$/m)
    return nameMatch?.[1].trim() === normalizedName
  } catch {
    return false
  }
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
  const base = normalizedSkillName(id)
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
  const { exists, mkdir, readTextFile, writeTextFile } = await import('@tauri-apps/plugin-fs')
  return {
    mkdir: async (path) => { await mkdir(path, { recursive: true }) },
    writeFile: async (path, content) => { await writeTextFile(path, content) },
    exists,
    readFile: readTextFile,
  }
}
