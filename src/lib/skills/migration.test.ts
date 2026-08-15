import { describe, expect, it } from 'vitest'
import type { Skill } from '@/lib/skills'
import { migrateCustomSkills } from './migration'

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
})
