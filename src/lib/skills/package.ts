import JSZip from 'jszip'
import { isTauri } from '@/lib/tauri'
import { parseSkillDocument } from './parse'
import type { LoadedSkill } from './types'

export type SkillPackageContent = string | Uint8Array

export interface SkillPackageFiles {
  [relativePath: string]: SkillPackageContent
}

export interface SkillPackageReader {
  listFiles(root: string): Promise<string[]>
  readFile(path: string): Promise<Uint8Array>
}

/** Build a portable zip without allowing absolute or parent-traversing paths. */
export async function createSkillPackage(
  skill: LoadedSkill,
  extraFiles: SkillPackageFiles = {},
  reader?: SkillPackageReader,
): Promise<Blob> {
  const zip = new JSZip()
  zip.file('SKILL.md', renderSkillDocument(skill))
  const diskFiles = await collectDiskResources(skill, reader)
  for (const [path, content] of Object.entries({ ...skill.resourceFiles, ...diskFiles, ...extraFiles })) {
    if (path === 'SKILL.md') continue
    assertSafePackagePath(path)
    // JSZip uses realm-sensitive instanceof checks for typed arrays. A plain
    // byte array works in the browser, Node, and jsdom without changing bytes.
    zip.file(path, typeof content === 'string' ? content : Array.from(content))
  }
  return zip.generateAsync({ type: 'blob' })
}

/** Read and validate an imported Skill package before it reaches the filesystem. */
export async function readSkillPackage(input: Blob | ArrayBuffer | Uint8Array): Promise<SkillPackageFiles> {
  const zip = await JSZip.loadAsync(input)
  const files: SkillPackageFiles = {}
  for (const [path, entry] of Object.entries(zip.files)) {
    assertSafePackagePath(path)
    if (entry.dir) continue
    if (isIgnoredPackageMetadata(path)) continue
    files[path] = path === 'SKILL.md' ? await entry.async('string') : await entry.async('uint8array')
  }
  const normalized = unwrapSingleRootDirectory(files)
  if (!normalized['SKILL.md']) throw new Error('Skill 压缩包缺少 SKILL.md')
  normalized['SKILL.md'] = packageFileText(normalized['SKILL.md'])
  parseSkillDocument(normalized['SKILL.md'], 'SKILL.md', 'user')
  return normalized
}

export function packageFileText(content: SkillPackageContent): string {
  return typeof content === 'string' ? content : new TextDecoder().decode(content)
}

function renderSkillDocument(skill: LoadedSkill): string {
  const metadata = skill.metadata
  const lines = [
    '---',
    `name: ${metadata.name}`,
    `version: ${metadata.version}`,
    `displayName: ${JSON.stringify(metadata.displayName ?? metadata.name)}`,
    `description: ${JSON.stringify(metadata.description)}`,
  ]
  if (metadata.icon) lines.push(`icon: ${metadata.icon}`)
  if (metadata.placeholder) lines.push(`placeholder: ${JSON.stringify(metadata.placeholder)}`)
  if (metadata.author) lines.push(`author: ${JSON.stringify(metadata.author)}`)
  if (metadata.allowedTools) lines.push(`allowed-tools: [${metadata.allowedTools.join(', ')}]`)
  if (metadata.recommendedModels) lines.push(`recommended-models: [${metadata.recommendedModels.join(', ')}]`)
  if (metadata.tags) lines.push(`tags: ${JSON.stringify(metadata.tags)}`)
  if (metadata.stage) lines.push(`stage: ${JSON.stringify(metadata.stage)}`)
  if (metadata.skipConfirmation !== undefined) lines.push(`skip-confirmation: ${metadata.skipConfirmation}`)
  lines.push('---', '', skill.content.trim(), '')
  return lines.join('\n')
}

function assertSafePackagePath(path: string): void {
  if (!path || /^[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(path) || path.includes('\0') || path.split(/[\\/]/).some((part) => part === '..')) {
    throw new Error(`Skill 包含非法路径：${path}`)
  }
}

function isIgnoredPackageMetadata(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return normalized.startsWith('__MACOSX/')
    || normalized.split('/').some((part) => part === '.DS_Store' || part.startsWith('._'))
}

function unwrapSingleRootDirectory(files: SkillPackageFiles): SkillPackageFiles {
  if (files['SKILL.md']) return files
  const paths = Object.keys(files)
  const root = paths[0]?.split('/')[0]
  if (!root || !paths.includes(`${root}/SKILL.md`) || !paths.every((path) => path.startsWith(`${root}/`))) {
    return files
  }
  return Object.fromEntries(paths.map((path) => [path.slice(root.length + 1), files[path]]))
}

async function collectDiskResources(skill: LoadedSkill, reader?: SkillPackageReader): Promise<SkillPackageFiles> {
  const root = skill.metadata.directory
  if (!root || root.startsWith('builtin://')) return {}
  const source = reader ?? (isTauri ? await createTauriPackageReader() : undefined)
  if (!source) return {}
  const files: SkillPackageFiles = {}
  for (const relativePath of await source.listFiles(root)) {
    assertSafePackagePath(relativePath)
    if (relativePath === 'SKILL.md') continue
    files[relativePath] = await source.readFile(joinPath(root, relativePath))
  }
  return files
}

async function createTauriPackageReader(): Promise<SkillPackageReader> {
  const { readDir, readFile } = await import('@tauri-apps/plugin-fs')
  return {
    async listFiles(root) {
      const files: string[] = []
      const visit = async (directory: string, prefix: string): Promise<void> => {
        for (const entry of await readDir(directory)) {
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name
          if (entry.isDirectory) await visit(joinPath(directory, entry.name), relative)
          else if (entry.isFile) files.push(relative)
        }
      }
      await visit(root, '')
      return files
    },
    async readFile(path) {
      return readFile(path)
    },
  }
}

function joinPath(...parts: string[]): string {
  return parts.join('/').replace(/\\/g, '/').replace(/\/+/g, '/')
}
