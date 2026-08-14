import { newId } from '@/lib/id'
import { readWorkspaceFile, writeWorkspaceFile } from '@/lib/tauri'
import type { MemoryFragment, MemoryState } from './types'

interface MemdirManifest {
  version: 1
  entries: Record<string, { path: string; createdAt: string }>
}

const MANIFEST_PATH = '.solidify/cache/memdir/index.json'

export class MemdirMemory implements MemoryState {
  private manifest: MemdirManifest | null = null
  private readonly root: string

  constructor(root: string) { this.root = root }

  async store(data: string): Promise<string> {
    const manifest = await this.loadManifest()
    for (const [handle, entry] of Object.entries(manifest.entries)) {
      const existing = await this.read(entry.path)
      if (existing === data) return handle
    }
    const handle = newId('mem')
    const path = `.solidify/cache/memdir/${handle}.txt`
    await writeWorkspaceFile(path, data, this.root)
    manifest.entries[handle] = { path, createdAt: new Date().toISOString() }
    await this.saveManifest(manifest)
    return handle
  }

  async retrieve(handle: string): Promise<string | null> {
    const entry = (await this.loadManifest()).entries[handle]
    return entry ? this.read(entry.path) : null
  }

  async search(query: string, limit = 10): Promise<MemoryFragment[]> {
    const manifest = await this.loadManifest()
    const normalized = query.toLocaleLowerCase()
    const fragments: MemoryFragment[] = []
    for (const [handle, entry] of Object.entries(manifest.entries)) {
      const content = await this.read(entry.path)
      if (!content?.toLocaleLowerCase().includes(normalized)) continue
      fragments.push({ content, relevance: 1, source: handle, timestamp: entry.createdAt })
      if (fragments.length >= limit) break
    }
    return fragments
  }

  async clear(): Promise<void> {
    this.manifest = { version: 1, entries: {} }
    await this.saveManifest(this.manifest)
  }

  private async loadManifest(): Promise<MemdirManifest> {
    if (this.manifest) return this.manifest
    try {
      const result = await readWorkspaceFile(MANIFEST_PATH, this.root)
      const parsed = JSON.parse(result.content ?? '') as MemdirManifest
      if (parsed.version !== 1 || !parsed.entries) throw new Error('Invalid memdir manifest')
      this.manifest = parsed
    } catch {
      this.manifest = { version: 1, entries: {} }
    }
    return this.manifest
  }

  private async saveManifest(manifest: MemdirManifest): Promise<void> {
    await writeWorkspaceFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), this.root)
  }

  private async read(path: string): Promise<string | null> {
    try { return (await readWorkspaceFile(path, this.root)).content }
    catch { return null }
  }
}
