import { builtinSkills } from '@/lib/skills'
import {
  isTauri,
  listenWorkspaceChanges,
  listWorkspaceDir,
  readWorkspaceFile,
} from '@/lib/tauri'
import { SkillParseError, parseSkillDocument, toSkillLoadError } from './parse'
import { loadBundledSkills } from './bundled'
import type { LoadedSkill, SkillLoadResult, SkillResourceRead, SkillResourceResolver, SkillSource } from './types'

export interface SkillFileSystem {
  listDirectories(path: string): Promise<string[]>
  readFile(path: string): Promise<string>
}

export interface SkillLoaderOptions {
  workspaceRoot?: string | null
  userSkillsRoot?: string | null
  builtins?: LoadedSkill[]
  fileSystem?: SkillFileSystem
}

interface SkillRoot {
  path: string
  source: SkillSource
}

/** Loads project, user and bundled skills with project precedence. */
export class SkillLoader {
  private readonly options: SkillLoaderOptions
  private readonly fileSystem: SkillFileSystem
  private readonly builtins: LoadedSkill[]
  private readonly roots: SkillRoot[]

  constructor(options: SkillLoaderOptions = {}) {
    this.options = options
    this.fileSystem = options.fileSystem ?? createTauriSkillFileSystem(options.workspaceRoot)
    this.builtins = options.builtins ?? bundledOrLegacyBuiltinSkills()
    this.roots = buildRoots(options)
  }

  async load(): Promise<SkillLoadResult> {
    const errors: SkillLoadResult['errors'] = []
    const byName = new Map<string, LoadedSkill>()

    // Low priority sources are loaded first; higher priority sources replace them.
    for (const skill of this.builtins) byName.set(skill.metadata.name, withVirtualRoot(skill))
    for (const root of [...this.roots].reverse()) {
      const directories = await this.listDirectories(root, errors)
      for (const directory of directories) {
        const skillPath = joinPath(directory, 'SKILL.md')
        try {
          const content = await this.fileSystem.readFile(skillPath)
          const skill = withVirtualRoot(parseSkillDocument(content, skillPath, root.source))
          assertMatchingDirectoryName(skill, directory)
          byName.set(skill.metadata.name, skill)
        } catch (error) {
          errors.push(toSkillLoadError(error, skillPath))
        }
      }
    }

    return { skills: [...byName.values()].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)), errors }
  }

  /** Load one directory directly, used by the registry and by import flows. */
  async loadDirectory(directory: string, source?: SkillSource): Promise<LoadedSkill> {
    const path = joinPath(directory, 'SKILL.md')
    const skill = withVirtualRoot(parseSkillDocument(await this.fileSystem.readFile(path), path, source))
    assertMatchingDirectoryName(skill, directory)
    return skill
  }

  createResourceResolver(skill: LoadedSkill): SkillResourceResolver {
    const virtualRoot = skill.virtualRoot ?? virtualRootFor(skill.metadata.name)
    const realRoot = skill.metadata.directory
    const fileSystem = this.fileSystem
    return {
      virtualRoot,
      canRead(path) {
        return relativeSkillResourcePath(path, virtualRoot) !== null
      },
      async read(path, offset, limit): Promise<SkillResourceRead> {
        const relative = relativeSkillResourcePath(path, virtualRoot)
        if (relative === null) throw new Error('Skill 资源路径不在当前 Skill 范围内')
        const content = skill.resourceFiles?.[relative]
          ?? (realRoot && !realRoot.startsWith('builtin://') ? await fileSystem.readFile(joinPath(realRoot, relative)) : undefined)
        if (content === undefined) throw new Error(`Skill 资源不存在：${relative}`)
        const chars = [...content]
        const start = Math.max(0, offset ?? 0)
        const end = limit === undefined ? chars.length : Math.min(chars.length, start + Math.max(0, limit))
        const selected = chars.slice(start, end).join('')
        return { content: selected, bytes: new TextEncoder().encode(selected).byteLength, truncated: end < chars.length }
      },
    }
  }

  /** Subscribe to the existing workspace watcher for project Skill changes. */
  async watch(onChange: () => void | Promise<void>): Promise<() => void> {
    const root = this.options.workspaceRoot
    let stopWorkspaceWatcher: () => void = () => undefined
    if (root && isTauri) {
      // The Rust watcher emits paths relative to the workspace root.
      stopWorkspaceWatcher = await listenWorkspaceChanges((change) => {
        const changedPath = normalizePath(change.path)
        if (change.kind === 'rescan' || isSkillWatcherPath(changedPath)) void onChange()
      })
    }
    // ~/.solidify/skills is outside the workspace watcher scope. Poll only
    // that optional root so drag-and-drop installs appear without a restart.
    const timer = this.options.userSkillsRoot
      ? setInterval(() => { void onChange() }, 1_000)
      : undefined
    return () => {
      stopWorkspaceWatcher()
      if (timer !== undefined) clearInterval(timer)
    }
  }

  private async listDirectories(root: SkillRoot, errors: SkillLoadResult['errors']): Promise<string[]> {
    try {
      return (await this.fileSystem.listDirectories(root.path))
        .filter((name) => !name.startsWith('.') && !name.startsWith('__solidify-'))
        .map((name) => joinPath(root.path, name))
    } catch (error) {
      // Skill roots are optional. A not-yet-created ~/.solidify/skills directory
      // is normal, while a real permission/I/O error remains visible to the UI.
      if (isMissingError(error)) return []
      errors.push(toSkillLoadError(error, root.path))
      return []
    }
  }
}

export function isSkillWatcherPath(path: string): boolean {
  const normalized = normalizePath(path)
  return normalized === '.solidify/skills' || normalized.startsWith('.solidify/skills/')
}

function buildRoots(options: SkillLoaderOptions): SkillRoot[] {
  const roots: SkillRoot[] = []
  if (options.workspaceRoot) roots.push({ path: joinPath(options.workspaceRoot, '.solidify/skills'), source: 'project' })
  if (options.userSkillsRoot) roots.push({ path: options.userSkillsRoot, source: 'user' })
  return roots
}

function legacyBuiltinSkills(): LoadedSkill[] {
  return builtinSkills.map((skill) => ({
    metadata: {
      name: skill.id,
      version: '1.0.0',
      description: skill.description,
      displayName: skill.name,
      icon: skill.icon,
      placeholder: skill.placeholder,
      skipConfirmation: skill.skipConfirmation,
      recommendedModels: skill.recommendedModels,
      source: 'builtin',
      directory: `builtin://${skill.id}`,
    },
    content: skill.systemPrompt,
    path: `builtin://${skill.id}/SKILL.md`,
    source: 'builtin',
    virtualRoot: virtualRootFor(skill.id),
  }))
}

function bundledOrLegacyBuiltinSkills(): LoadedSkill[] {
  const bundled = loadBundledSkills()
  return bundled.length > 0 ? bundled : legacyBuiltinSkills()
}

function withVirtualRoot(skill: LoadedSkill): LoadedSkill {
  return { ...skill, virtualRoot: virtualRootFor(skill.metadata.name) }
}

export function virtualRootFor(name: string): string {
  return `.solidify/skills/${name}`
}

function assertMatchingDirectoryName(skill: LoadedSkill, directory: string): void {
  const directoryName = normalizePath(directory).split('/').filter(Boolean).pop()
  if (directoryName !== skill.metadata.name) {
    throw new SkillParseError(skill.path, `name 必须与目录名一致（目录：${directoryName ?? ''}）`)
  }
}

function relativeSkillResourcePath(path: string, root: string): string | null {
  const normalized = path.replace(/\\/g, '/')
  if (
    normalized.startsWith('/')
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.includes('\0')
    || normalized.split('/').some((part) => part === '..' || part === '.')
  ) return null
  const prefix = `${root}/`
  if (!normalized.startsWith(prefix)) return null
  const relative = normalized.slice(prefix.length)
  return relative && !relative.split('/').some((part) => !part) ? relative : null
}

function createTauriSkillFileSystem(workspaceRoot?: string | null): SkillFileSystem {
  const normalizedWorkspaceRoot = workspaceRoot ? normalizePath(workspaceRoot) : null
  return {
    async listDirectories(path) {
      if (!isTauri) return []
      const workspacePath = normalizedWorkspaceRoot
        ? relativePathWithinRoot(path, normalizedWorkspaceRoot)
        : null
      if (workspacePath !== null && normalizedWorkspaceRoot) {
        const entries = await listWorkspaceDir(workspacePath, normalizedWorkspaceRoot, 1)
        return entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.name)
      }
      const { readDir } = await import('@tauri-apps/plugin-fs')
      const entries = await readDir(path)
      return entries.filter((entry) => entry.isDirectory).map((entry) => entry.name).filter((name): name is string => Boolean(name))
    },
    async readFile(path) {
      if (!isTauri) throw new Error('Skill 文件只能在桌面端读取')
      const workspacePath = normalizedWorkspaceRoot
        ? relativePathWithinRoot(path, normalizedWorkspaceRoot)
        : null
      if (workspacePath !== null && normalizedWorkspaceRoot) {
        const result = await readWorkspaceFile(workspacePath, normalizedWorkspaceRoot)
        if (result.binary || result.content === null) throw new Error(`Skill 资源不是 UTF-8 文本：${workspacePath}`)
        return result.content
      }
      const { readTextFile } = await import('@tauri-apps/plugin-fs')
      return readTextFile(path)
    },
  }
}

function relativePathWithinRoot(path: string, root: string): string | null {
  const normalizedPath = normalizePath(path)
  if (normalizedPath === root) return '.'
  const prefix = `${root}/`
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : null
}

/** Resolve the platform user Skill directory without touching the filesystem. */
export async function resolveUserSkillsRoot(): Promise<string | null> {
  if (!isTauri) return null
  const { homeDir } = await import('@tauri-apps/api/path')
  return joinPath(await homeDir(), '.solidify/skills')
}

/** Resolve and create the user Skill root on desktop. */
export async function ensureUserSkillsRoot(): Promise<string | null> {
  const root = await resolveUserSkillsRoot()
  if (!root) return null
  const { mkdir } = await import('@tauri-apps/plugin-fs')
  await mkdir(root, { recursive: true })
  return root
}

function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/'))
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/'
}

function isMissingError(error: unknown): boolean {
  if (!error) return false
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (message.includes('not found') || message.includes('no such file')) return true
  if (typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'NotFound'
}
