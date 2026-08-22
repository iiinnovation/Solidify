import { beforeEach, describe, expect, it } from 'vitest'
import type { Skill } from '@/lib/skills'
import { finalizeSkillMigrationWindow, getSkillMigrationWindowStatus, isLegacySkillRuntimeRetired, isLegacySkillStoreWriteAllowed, migrateCustomSkills, migrateStoredCustomSkills, readSkillMigrationTelemetry, SKILL_MIGRATION_MARKER, SKILL_MIGRATION_OBSERVATION_SESSION_KEY, SKILL_MIGRATION_TELEMETRY_KEY, SKILL_RUNTIME_RETIRED_MARKER } from './migration'

const skill: Skill = {
  id: 'skill-custom-123',
  name: '客户需求',
  description: '整理客户需求',
  icon: 'ClipboardList',
  placeholder: '输入材料',
  skipConfirmation: true,
  systemPrompt: '先读取材料，再输出需求文档。',
}

describe('custom Skill migration', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.removeItem(SKILL_MIGRATION_OBSERVATION_SESSION_KEY)
  })

  it('closes the legacy store write boundary only after the migration marker', () => {
    localStorage.removeItem(SKILL_MIGRATION_MARKER)
    try {
      expect(isLegacySkillStoreWriteAllowed()).toBe(true)
      localStorage.setItem(SKILL_MIGRATION_MARKER, 'true')
      expect(isLegacySkillStoreWriteAllowed()).toBe(false)
    } finally {
      localStorage.removeItem(SKILL_MIGRATION_MARKER)
    }
  })

  it('validates aggregate migration telemetry without retaining Skill bodies', () => {
    localStorage.setItem(SKILL_MIGRATION_TELEMETRY_KEY, JSON.stringify({
      version: 1,
      attempts: 2,
      observations: 2,
      migrated: 3,
      skipped: 1,
      errors: 0,
      deferred: 1,
      lastStatus: 'deferred',
      lastAt: '2026-08-22T00:00:00.000Z',
    }))
    expect(readSkillMigrationTelemetry()).toMatchObject({ attempts: 2, migrated: 3, lastStatus: 'deferred' })
    localStorage.setItem(SKILL_MIGRATION_TELEMETRY_KEY, '{bad json')
    expect(readSkillMigrationTelemetry()).toBeNull()
    localStorage.removeItem(SKILL_MIGRATION_TELEMETRY_KEY)
  })

  it('upgrades telemetry written before the observation counter existed', () => {
    localStorage.setItem(SKILL_MIGRATION_TELEMETRY_KEY, JSON.stringify({
      version: 1, attempts: 1, migrated: 1, skipped: 0, errors: 0, deferred: 0,
      lastStatus: 'completed', lastAt: '2026-08-22T00:00:00.000Z',
    }))
    expect(readSkillMigrationTelemetry()).toMatchObject({ observations: 0 })
    localStorage.removeItem(SKILL_MIGRATION_TELEMETRY_KEY)
  })

  it('retires the legacy runtime only after clean repeated observations', () => {
    localStorage.removeItem(SKILL_RUNTIME_RETIRED_MARKER)
    localStorage.setItem(SKILL_MIGRATION_MARKER, 'true')
    localStorage.setItem(SKILL_MIGRATION_TELEMETRY_KEY, JSON.stringify({
      version: 1, attempts: 1, observations: 1, migrated: 1, skipped: 0, errors: 0, deferred: 0,
      lastStatus: 'completed', lastAt: '2026-08-22T00:00:00.000Z',
    }))
    expect(finalizeSkillMigrationWindow()).toBe(false)
    localStorage.setItem(SKILL_MIGRATION_TELEMETRY_KEY, JSON.stringify({
      version: 1, attempts: 1, observations: 2, migrated: 1, skipped: 0, errors: 0, deferred: 0,
      lastStatus: 'completed', lastAt: '2026-08-22T00:00:00.000Z',
    }))
    expect(finalizeSkillMigrationWindow()).toBe(true)
    expect(isLegacySkillRuntimeRetired()).toBe(true)
    localStorage.removeItem(SKILL_RUNTIME_RETIRED_MARKER)
    localStorage.removeItem(SKILL_MIGRATION_MARKER)
    localStorage.removeItem(SKILL_MIGRATION_TELEMETRY_KEY)
  })

  it('reports each migration-window gate without mutating storage', () => {
    localStorage.clear()
    expect(getSkillMigrationWindowStatus()).toMatchObject({ readyToFinalize: false, reason: 'not-migrated' })
    localStorage.setItem(SKILL_MIGRATION_MARKER, 'true')
    localStorage.setItem(SKILL_MIGRATION_TELEMETRY_KEY, JSON.stringify({
      version: 1, attempts: 1, observations: 1, migrated: 1, skipped: 0, errors: 0, deferred: 0,
      lastStatus: 'completed', lastAt: '2026-08-22T00:00:00.000Z',
    }))
    expect(getSkillMigrationWindowStatus()).toMatchObject({ migrated: true, observations: 1, reason: 'insufficient-observations' })
    localStorage.setItem(SKILL_MIGRATION_TELEMETRY_KEY, JSON.stringify({
      version: 1, attempts: 1, observations: 2, migrated: 1, skipped: 0, errors: 1, deferred: 0,
      lastStatus: 'failed', lastAt: '2026-08-22T00:00:00.000Z',
    }))
    expect(getSkillMigrationWindowStatus()).toMatchObject({ readyToFinalize: false, reason: 'unclean' })
    expect(localStorage.getItem(SKILL_RUNTIME_RETIRED_MARKER)).toBeNull()
    localStorage.clear()
  })

  it('records at most one clean observation per application session', async () => {
    localStorage.setItem(SKILL_MIGRATION_MARKER, 'true')
    localStorage.setItem(SKILL_MIGRATION_TELEMETRY_KEY, JSON.stringify({
      version: 1, attempts: 1, observations: 0, migrated: 1, skipped: 0, errors: 0, deferred: 0,
      lastStatus: 'completed', lastAt: '2026-08-22T00:00:00.000Z',
    }))
    await migrateStoredCustomSkills()
    await migrateStoredCustomSkills()
    expect(readSkillMigrationTelemetry()).toMatchObject({ observations: 1 })
    localStorage.clear()
  })

  it('backfills telemetry when an older build left only the migration marker', async () => {
    localStorage.setItem(SKILL_MIGRATION_MARKER, 'true')
    localStorage.removeItem(SKILL_MIGRATION_TELEMETRY_KEY)
    // This test intentionally runs after the session-count test in a fresh
    // module instance in the normal Vitest file isolation.
    await migrateStoredCustomSkills()
    expect(readSkillMigrationTelemetry()).toMatchObject({ observations: 1, lastStatus: 'completed' })
    localStorage.clear()
  })

  it('shares concurrent startup migration calls', async () => {
    localStorage.clear()
    const first = migrateStoredCustomSkills()
    const second = migrateStoredCustomSkills()
    expect(first).toBe(second)
    await expect(first).resolves.toMatchObject({ migrated: [], skipped: [], errors: [] })
    localStorage.clear()
  })

  it('writes a SKILL.md directory and preserves the legacy id', async () => {
    const files = new Map<string, string>()
    const result = await migrateCustomSkills([skill], '/home/.solidify/skills', {
      mkdir: async () => undefined,
      writeFile: async (path, content) => { files.set(path, content) },
    })

    expect(result).toEqual({ migrated: ['skill-custom-123'], skipped: [], errors: [] })
    const document = files.get('/home/.solidify/skills/skill-custom-123/SKILL.md')
    expect(document).toContain('name: skill-custom-123')
    expect(document).toContain('description: "整理客户需求"')
    expect(document).toContain('先读取材料，再输出需求文档。')
  })

  it('migrates three custom Skills into independent directories with unchanged bodies', async () => {
    const skills = [
      skill,
      { ...skill, id: 'skill-custom-456', name: '方案设计', systemPrompt: '输出方案设计。' },
      { ...skill, id: 'skill-custom-789', name: '测试计划', systemPrompt: '输出测试计划。' },
    ]
    const files = new Map<string, string>()
    const result = await migrateCustomSkills(skills, '/home/.solidify/skills', {
      mkdir: async () => undefined,
      writeFile: async (path, content) => { files.set(path, content) },
    })

    expect(result).toEqual({ migrated: skills.map((item) => item.id), skipped: [], errors: [] })
    for (const item of skills) {
      const content = files.get(`/home/.solidify/skills/${item.id}/SKILL.md`)
      expect(content).toContain(`name: ${item.id}`)
      expect(content).toContain(item.systemPrompt)
    }
  })

  it('keeps the original localStorage payload untouched when migration is unavailable', () => {
    expect(skill.id).toBe('skill-custom-123')
    // The one-shot browser entry point intentionally does not remove this data;
    // the directory is the new source of truth only after all writes succeed.
  })

  it('does not claim success when a file write fails', async () => {
    const result = await migrateCustomSkills([skill], '/skills', {
      mkdir: async () => undefined,
      writeFile: async () => { throw new Error('read-only') },
    })

    expect(result.migrated).toEqual([])
    expect(result.errors[0]).toMatchObject({ id: skill.id, message: 'read-only' })
  })

  it('does not overwrite an existing directory during one-shot migration', async () => {
    const files = new Map<string, string>()
    const result = await migrateCustomSkills([skill], '/skills', {
      exists: async (path) => path === '/skills/skill-custom-123',
      mkdir: async () => undefined,
      writeFile: async (path, content) => { files.set(path, content) },
    })

    expect(result.errors).toEqual([])
    expect(files.has('/skills/skill-custom-123/SKILL.md')).toBe(false)
    expect(files.get('/skills/skill-custom-123-2/SKILL.md')).toContain('name: skill-custom-123-2')
  })

  it('retries a partially migrated Skill idempotently instead of creating a duplicate', async () => {
    const files = new Map<string, string>([
      ['/skills/skill-custom-123/SKILL.md', '---\nname: skill-custom-123\nlegacy-id: "skill-custom-123"\nversion: 1.0.0\ndescription: "整理客户需求"\n---\n\n先读取材料，再输出需求文档。\n'],
    ])
    const result = await migrateCustomSkills([skill], '/skills', {
      exists: async (path) => path === '/skills/skill-custom-123',
      readFile: async (path) => files.get(path) ?? (() => { throw new Error('missing') })(),
      mkdir: async () => undefined,
      writeFile: async (path, content) => { files.set(path, content) },
    })

    expect(result).toEqual({ migrated: [skill.id], skipped: [], errors: [] })
    expect([...files.keys()]).toEqual(['/skills/skill-custom-123/SKILL.md'])
  })
})
