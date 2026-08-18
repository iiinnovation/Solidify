import { describe, expect, it, vi } from 'vitest'
import { builtinSkills } from '@/lib/skills'
import { isSkillWatcherPath, SkillLoader, type SkillFileSystem } from './loader'
import { SkillParseError, parseSkillDocument } from './parse'
import { SkillRegistry } from './registry'
import { formatSkillIndex } from './registry'

function document(name: string, description = `${name} description`, body = '# Skill'): string {
  return `---\nname: ${name}\nversion: 1.2.3\ndescription: ${description}\ndisplayName: ${name} display\nallowed-tools: [read_file, list_dir]\n---\n\n${body}\n`
}

function memoryFileSystem(files: Record<string, string>, directories: Record<string, string[]>): SkillFileSystem {
  return {
    async listDirectories(path) { return directories[path] ?? [] },
    async readFile(path) {
      const content = files[path]
      if (content === undefined) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      return content
    },
  }
}

describe('parseSkillDocument', () => {
  it('parses metadata and keeps the body separate', () => {
    const skill = parseSkillDocument(document('requirement-analysis'), '/skills/requirement-analysis/SKILL.md', 'user')

    expect(skill.metadata).toMatchObject({
      name: 'requirement-analysis',
      version: '1.2.3',
      description: 'requirement-analysis description',
      allowedTools: ['read_file', 'list_dir'],
      source: 'user',
    })
    expect(skill.content).toBe('# Skill')
    expect(skill.path).toContain('SKILL.md')
  })

  it('fails explicitly when description is missing', () => {
    expect(() => parseSkillDocument('---\nname: broken\nversion: 1.0.0\n---\nbody', '/broken/SKILL.md'))
      .toThrowError(/缺少必填字段 description/)
    expect(() => parseSkillDocument('---\nname: broken\nversion: 1.0.0\n---\nbody', '/broken/SKILL.md'))
      .toThrowError(SkillParseError)
  })

  it('rejects invalid names and versions', () => {
    expect(() => parseSkillDocument(document('Bad_Name'), '/bad/SKILL.md')).toThrowError(/kebab-case/)
    expect(() => parseSkillDocument(document('valid').replace('1.2.3', 'v1'), '/bad/SKILL.md')).toThrowError(/语义化版本/)
  })
})

describe('SkillLoader', () => {
  it('matches only workspace-relative Skill watcher paths', () => {
    expect(isSkillWatcherPath('.solidify/skills/demo/SKILL.md')).toBe(true)
    expect(isSkillWatcherPath('.solidify/skills')).toBe(true)
    expect(isSkillWatcherPath('03-交付物/demo.md')).toBe(false)
    expect(isSkillWatcherPath('/tmp/.solidify/skills/demo/SKILL.md')).toBe(false)
  })

  it('loads the bundled directory Skills when no override is provided', async () => {
    const result = await new SkillLoader({ fileSystem: memoryFileSystem({}, {}) }).load()
    expect(result.errors).toEqual([])
    expect(result.skills.filter((skill) => skill.source === 'builtin')).toHaveLength(10)
    expect(result.skills.some((skill) => skill.metadata.name === 'presentation')).toBe(false)
    for (const skill of result.skills.filter((item) => item.source === 'builtin')) {
      if (skill.metadata.name === 'pptd-deck') {
        expect(skill.metadata.version).toBe('1.2.0')
        expect(skill.metadata.allowedTools).toContain('generate_pptd')
        expect(skill.metadata.allowedTools).not.toContain('capture_preview')
        expect(skill.content).toContain('PPTD v2')
        expect(skill.content).toContain('整份 deck 只能交付为一个 `<solidify-artifact type="slides">`')
        expect(skill.content).toContain('不得使用 `type="document"` 交付页面 YAML')
        expect(skill.resourceFiles?.['reference/pptd.md']).toContain('960, 540')
        expect(skill.resourceFiles?.['reference/slide-categories/management-report.md']).toContain('Management Reporting')
        expect(skill.resourceFiles?.['reference/design-system/consulting/apricot-white-brief/design.md']).toContain('Apricot White Brief')
        expect(skill.resourceFiles?.['examples/kimi/product-overview.page']).toContain('elementType: text')
      } else {
        expect(skill.metadata.version, skill.metadata.name).toBe('2.1.0')
        expect(skill.content, skill.metadata.name).toContain('reference/legacy-guidance.md')
        expect(skill.content, skill.metadata.name).toContain('## 提交前自检')
        expect(skill.resourceFiles?.['reference/legacy-guidance.md'], skill.metadata.name)
          .toBe(builtinSkills.find((item) => item.id === skill.metadata.name)?.systemPrompt)
      }
    }
    const requirement = result.skills.find((skill) => skill.metadata.name === 'requirement-analysis')
    expect(requirement?.content).toContain('reference/output-format.md')
    expect(requirement?.resourceFiles?.['SKILL.md']).toContain('name: requirement-analysis')
    expect(requirement?.resourceFiles?.['reference/output-format.md']).toContain('需求规格文档')
    const drawio = result.skills.find((skill) => skill.metadata.name === 'drawio-diagram')
    expect(drawio?.content).toContain('reference/layout-guidance.md')
    expect(drawio?.content).toContain('独立的有填充色方块')
    expect(drawio?.content).toContain('<solidify-artifact type="drawio"')
    expect(drawio?.content).toContain('不要把 XML 直接输出到对话正文')
    expect(drawio?.resourceFiles?.['reference/legacy-guidance.md']).toContain('<solidify-artifact type="drawio"')
    expect(drawio?.resourceFiles?.['reference/legacy-guidance.md']).not.toContain('直接输出完整的 Draw.io XML 格式')
    expect(drawio?.resourceFiles?.['reference/layout-guidance.md']).toContain('输出前几何检查')
    expect(drawio?.resourceFiles?.['reference/layout-guidance.md']).toContain('禁止把多个组件合并进一个')
    expect(drawio?.resourceFiles?.['reference/layout-guidance.md']).toContain('不能填写画布绝对坐标')
    expect(drawio?.resourceFiles?.['reference/xml-checklist.md']).toContain('连线不穿过')
    expect(drawio?.resourceFiles?.['reference/xml-checklist.md']).toContain('不能用一个无填充、无边框的 text 节点')
  })

  it('merges roots with project-over-user-over-builtin precedence', async () => {
    const fs = memoryFileSystem(
      {
        '/user/same/SKILL.md': document('same', 'user description'),
        '/project/.solidify/skills/same/SKILL.md': document('same', 'project description'),
        '/project/.solidify/skills/project-only/SKILL.md': document('project-only'),
      },
      {
        '/user': ['same'],
        '/project/.solidify/skills': ['same', 'project-only'],
      },
    )
    const loader = new SkillLoader({
      workspaceRoot: '/project',
      userSkillsRoot: '/user',
      fileSystem: fs,
      builtins: [{ metadata: { name: 'same', version: '1.0.0', description: 'builtin', source: 'builtin' }, content: 'builtin', path: 'builtin://same' }],
    })

    const result = await loader.load()
    expect(result.errors).toEqual([])
    expect(result.skills.map((skill) => skill.metadata.name)).toEqual(['project-only', 'same'])
    expect(result.skills.find((skill) => skill.metadata.name === 'same')?.metadata.description).toBe('project description')
  })

  it('returns invalid skill errors without silently hiding them', async () => {
    const loader = new SkillLoader({
      userSkillsRoot: '/user',
      fileSystem: memoryFileSystem(
        { '/user/broken/SKILL.md': '---\nname: broken\nversion: 1.0.0\n---\nbody' },
        { '/user': ['broken'] },
      ),
      builtins: [],
    })

    const result = await loader.load()
    expect(result.skills).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/description/)
  })

  it('ignores import transaction directories while scanning Skills', async () => {
    const readFile = vi.fn(async (path: string) => {
      if (path === '/user/installed/SKILL.md') return document('installed')
      throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    })
    const loader = new SkillLoader({
      userSkillsRoot: '/user',
      fileSystem: {
        listDirectories: async () => [
          '__solidify-import-demo-transaction',
          '__solidify-backup-demo-transaction',
          'installed',
        ],
        readFile,
      },
      builtins: [],
    })

    const result = await loader.load()

    expect(result.errors).toEqual([])
    expect(result.skills.map((skill) => skill.metadata.name)).toEqual(['installed'])
    expect(readFile).toHaveBeenCalledOnce()
  })

  it('fails explicitly when frontmatter name differs from its directory', async () => {
    const loader = new SkillLoader({
      userSkillsRoot: '/user',
      fileSystem: memoryFileSystem(
        { '/user/wrong-directory/SKILL.md': document('actual-name') },
        { '/user': ['wrong-directory'] },
      ),
      builtins: [],
    })

    const result = await loader.load()
    expect(result.skills).toEqual([])
    expect(result.errors[0].message).toMatch(/name 必须与目录名一致/)
  })

  it('hot-reloads a Skill added to the user directory without recreating the registry', async () => {
    vi.useFakeTimers()
    const files: Record<string, string> = {}
    const directories: Record<string, string[]> = { '/user': [] }
    const registry = new SkillRegistry(new SkillLoader({
      userSkillsRoot: '/user',
      fileSystem: memoryFileSystem(files, directories),
      builtins: [],
    }))

    try {
      await registry.reload()
      const stop = await registry.startWatching()
      directories['/user'] = ['installed']
      files['/user/installed/SKILL.md'] = document('installed')
      await vi.advanceTimersByTimeAsync(1_000)

      expect(await registry.resolve('installed')).not.toBeNull()
      stop()
    } finally {
      await registry.stopWatching()
      vi.useRealTimers()
    }
  })

  it('never runs two user-root poll passes at once', async () => {
    vi.useFakeTimers()
    let active = 0
    let peak = 0
    let started = 0
    const pending: Array<() => void> = []
    const loader = new SkillLoader({ userSkillsRoot: '/user', fileSystem: memoryFileSystem({}, {}), builtins: [] })

    try {
      const stop = await loader.watch(async () => {
        started += 1
        active += 1
        peak = Math.max(peak, active)
        // A pass that outlives the poll period: the old setInterval stacked
        // another one on top of it every second.
        await new Promise<void>((resolve) => pending.push(resolve))
        active -= 1
      })

      await vi.advanceTimersByTimeAsync(5_000)
      expect(started).toBe(1)
      expect(peak).toBe(1)

      pending.shift()?.()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(started).toBe(2)
      expect(peak).toBe(1)

      stop()
      pending.shift()?.()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(started).toBe(2)
    } finally {
      for (const resolve of pending) resolve()
      vi.useRealTimers()
    }
  })

  it('skips user-root poll passes while the window is hidden', async () => {
    vi.useFakeTimers()
    const hidden = vi.spyOn(Document.prototype, 'hidden', 'get')
    let passes = 0
    const loader = new SkillLoader({ userSkillsRoot: '/user', fileSystem: memoryFileSystem({}, {}), builtins: [] })

    try {
      hidden.mockReturnValue(true)
      const stop = await loader.watch(() => { passes += 1 })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(passes).toBe(0)

      hidden.mockReturnValue(false)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(passes).toBe(1)
      stop()
    } finally {
      hidden.mockRestore()
      vi.useRealTimers()
    }
  })

  it('maps only the selected Skill resources into the virtual read-only root', async () => {
    const fs = memoryFileSystem(
      {
        '/user/pptd/SKILL.md': document('pptd'),
        '/user/pptd/reference/pptd.md': '# PPTD reference',
      },
      { '/user': ['pptd'] },
    )
    const loader = new SkillLoader({ userSkillsRoot: '/user', fileSystem: fs, builtins: [] })
    const skill = (await loader.load()).skills[0]
    const resolver = loader.createResourceResolver(skill)

    expect(resolver.canRead('.solidify/skills/pptd/reference/pptd.md')).toBe(true)
    expect(resolver.canRead('.solidify/skills/pptd/examples/')).toBe(true)
    expect(resolver.canRead('.solidify/skills/other/reference/pptd.md')).toBe(false)
    expect(resolver.canRead('.solidify/skills/pptd/../other.txt')).toBe(false)
    await expect(resolver.read('.solidify/skills/other/reference/pptd.md')).rejects.toThrow()
    await expect(resolver.read('.solidify/skills/pptd/examples/')).rejects.toThrow(/必须指向具体文件/)
    await expect(resolver.read('.solidify/skills/pptd/reference/pptd.md')).resolves.toMatchObject({ content: '# PPTD reference' })
  })
})

describe('SkillRegistry', () => {
  it('reloads and notifies subscribers', async () => {
    const listener = vi.fn()
    const loader = new SkillLoader({
      fileSystem: memoryFileSystem({}, {}),
      builtins: [{ metadata: { name: 'builtin', version: '1.0.0', description: 'builtin' }, content: 'body', path: 'builtin://builtin' }],
    })
    const registry = new SkillRegistry(loader)
    registry.subscribe(listener)

    await registry.reload()

    expect(await registry.resolve('builtin')).not.toBeNull()
    expect(await registry.list()).toHaveLength(1)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('keeps the layer-0 index below 600 estimated tokens', () => {
    const index = formatSkillIndex(Array.from({ length: 100 }, (_, i) => ({
      name: `skill-${i}`,
      version: '1.0.0',
      description: '这是一个用于处理访谈材料并生成结构化交付物的详细 Skill 描述。',
    })))
    const cjk = [...index].filter((char) => /[\u3400-\u9fff]/.test(char)).length
    const estimate = Math.ceil(cjk + ([...index].length - cjk) / 4)
    expect(estimate).toBeLessThan(600)
  })
})
