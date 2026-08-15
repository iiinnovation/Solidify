import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  listWorkspaceDir: vi.fn(),
  readWorkspaceFile: vi.fn(),
  mkdir: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  isTauri: true,
  listenWorkspaceChanges: async () => () => undefined,
  listWorkspaceDir: tauri.listWorkspaceDir,
  readWorkspaceFile: tauri.readWorkspaceFile,
}))

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: async () => '/Users/test',
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  mkdir: tauri.mkdir,
}))

import { ensureUserSkillsRoot, SkillLoader } from './loader'

describe('desktop project Skill loader', () => {
  beforeEach(() => {
    tauri.listWorkspaceDir.mockReset()
    tauri.readWorkspaceFile.mockReset()
    tauri.mkdir.mockReset()
  })

  it('creates the user Skill root when directory management starts', async () => {
    await expect(ensureUserSkillsRoot()).resolves.toBe('/Users/test/.solidify/skills')
    expect(tauri.mkdir).toHaveBeenCalledWith('/Users/test/.solidify/skills', { recursive: true })
  })

  it('reads project Skills through the authorized Rust workspace boundary', async () => {
    tauri.listWorkspaceDir.mockResolvedValue([{
      path: '.solidify/skills/project-skill',
      name: 'project-skill',
      kind: 'directory',
      size: 0,
    }])
    tauri.readWorkspaceFile.mockResolvedValue({
      content: '---\nname: project-skill\nversion: 1.0.0\ndescription: Project Skill\n---\n\n# Project Skill\n',
      binary: false,
      bytes: 99,
      truncated: false,
    })
    const loader = new SkillLoader({ workspaceRoot: '/workspace', builtins: [] })

    const result = await loader.load()

    expect(tauri.listWorkspaceDir).toHaveBeenCalledWith('.solidify/skills', '/workspace', 1)
    expect(tauri.readWorkspaceFile).toHaveBeenCalledWith(
      '.solidify/skills/project-skill/SKILL.md',
      '/workspace',
    )
    expect(result.errors).toEqual([])
    expect(result.skills[0]).toMatchObject({
      source: 'project',
      metadata: { name: 'project-skill', source: 'project' },
    })
  })
})
