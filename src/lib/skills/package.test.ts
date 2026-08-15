import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { createSkillPackage, readSkillPackage } from './package'
import type { LoadedSkill } from './types'

const skill: LoadedSkill = {
  metadata: { name: 'demo-skill', version: '1.0.0', description: 'demo', displayName: 'Demo', author: 'Solidify', tags: ['demo'], stage: 'delivery' },
  content: '# Demo',
  path: 'builtin://demo-skill/SKILL.md',
  resourceFiles: { 'reference/guide.md': '# Guide' },
}

describe('Skill package', () => {
  it('round-trips SKILL.md and resources', async () => {
    const blob = await createSkillPackage(skill)
    const files = await readSkillPackage(new Uint8Array(await blob.arrayBuffer()))
    expect(files['SKILL.md']).toContain('name: demo-skill')
    expect(files['SKILL.md']).toContain('author: "Solidify"')
    expect(files['SKILL.md']).toContain('tags: ["demo"]')
    expect(new TextDecoder().decode(files['reference/guide.md'] as Uint8Array)).toBe('# Guide')
  })

  it('collects disk resources and preserves binary assets', async () => {
    const binary = new Uint8Array([0, 255, 1, 2])
    const blob = await createSkillPackage({
      ...skill,
      metadata: { ...skill.metadata, directory: '/skills/demo-skill' },
      resourceFiles: undefined,
    }, {}, {
      listFiles: async () => ['SKILL.md', 'reference/guide.md', 'assets/template.docx'],
      readFile: async (path) => path.endsWith('.docx') ? binary : new TextEncoder().encode('# Disk guide'),
    })
    const files = await readSkillPackage(blob)

    expect(new TextDecoder().decode(files['reference/guide.md'] as Uint8Array)).toBe('# Disk guide')
    expect(files['assets/template.docx']).toEqual(binary)
  })

  it('accepts a Finder-style zip with one root directory and macOS metadata', async () => {
    const zip = new JSZip()
    zip.file('demo-skill/SKILL.md', '---\nname: demo-skill\nversion: 1.0.0\ndescription: Demo\n---\n\n# Demo\n')
    zip.file('demo-skill/reference/guide.md', '# Guide')
    zip.file('demo-skill/._SKILL.md', 'metadata')
    zip.file('__MACOSX/demo-skill/._SKILL.md', 'metadata')

    const files = await readSkillPackage(await zip.generateAsync({ type: 'uint8array' }))

    expect(files['SKILL.md']).toContain('name: demo-skill')
    expect(new TextDecoder().decode(files['reference/guide.md'] as Uint8Array)).toBe('# Guide')
    expect(Object.keys(files).some((path) => path.startsWith('__MACOSX') || path.startsWith('._'))).toBe(false)
  })

  it('rejects parent traversal paths', async () => {
    await expect(createSkillPackage(skill, { '../secret.txt': 'no' })).rejects.toThrow(/非法路径/)
  })

  it('rejects Windows absolute and UNC package paths', async () => {
    await expect(createSkillPackage(skill, { 'C:\\secret.txt': 'no' })).rejects.toThrow(/非法路径/)
    await expect(createSkillPackage(skill, { '\\\\server\\share.txt': 'no' })).rejects.toThrow(/非法路径/)
  })
})
