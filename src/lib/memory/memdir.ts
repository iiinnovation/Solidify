import { newId } from '@/lib/id'
import { readWorkspaceFile, writeWorkspaceFile } from '@/lib/tauri'
import type { MemoryFragment, MemoryState } from './types'

interface MemdirEntry {
  path: string
  createdAt: string
  /** Content fingerprint used for dedupe without re-reading the payload. */
  hash?: string
  bytes?: number
}

interface MemdirManifest {
  version: 1
  entries: Record<string, MemdirEntry>
}

const MANIFEST_PATH = '.solidify/cache/memdir/index.json'

/** Cheap content fingerprint for dedupe (FNV-1a); not a security hash. */
function fingerprint(data: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < data.length; i++) {
    hash ^= data.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16)}-${data.length}`
}

export class MemdirMemory implements MemoryState {
  private manifest: MemdirManifest | null = null
  private readonly root: string

  constructor(root: string) { this.root = root }

  async store(data: string): Promise<string> {
    const manifest = await this.loadManifest()
    const hash = fingerprint(data)
    // Dedupe by fingerprint. Reading every stored entry's full content back
    // from disk on each store was O(N) IPC round trips per large tool result,
    // on the critical path of every tool call.
    for (const [handle, entry] of Object.entries(manifest.entries)) {
      if (entry.hash === hash) return handle
    }
    const handle = newId('mem')
    const path = `.solidify/cache/memdir/${handle}.txt`
    await writeWorkspaceFile(path, data, this.root)
    manifest.entries[handle] = { path, createdAt: new Date().toISOString(), hash, bytes: data.length }
    await this.saveManifest(manifest)
    return handle
  }

  async retrieve(handle: string): Promise<string | null> {
    const entry = (await this.loadManifest()).entries[handle]
    return entry ? this.read(entry.path) : null
  }

  async search(query: string, limit = 10): Promise<MemoryFragment[]> {
    const manifest = await this.loadManifest()
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return []
    const fragments: MemoryFragment[] = []
    for (const [handle, entry] of Object.entries(manifest.entries)) {
      const content = await this.read(entry.path)
      if (!content) continue
      const haystack = content.toLocaleLowerCase()
      // Matching the whole query as one substring made recall zero for any
      // multi-word question; require each term instead.
      if (!terms.every((term) => haystack.includes(term))) continue
      fragments.push({ content, relevance: 1, source: handle, timestamp: entry.createdAt })
      if (fragments.length >= limit) break
    }
    return fragments
  }

  async clear(): Promise<void> {
    const manifest: MemdirManifest = { version: 1, entries: {} }
    this.manifest = manifest
    await writeWorkspaceFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), this.root)
  }

  private async loadManifest(): Promise<MemdirManifest> {
    if (this.manifest) return this.manifest
    this.manifest = await this.readManifest()
    return this.manifest
  }

  private async readManifest(): Promise<MemdirManifest> {
    try {
      const result = await readWorkspaceFile(MANIFEST_PATH, this.root)
      const parsed = JSON.parse(result.content ?? '') as MemdirManifest
      if (parsed.version !== 1 || !parsed.entries) throw new Error('Invalid memdir manifest')
      return parsed
    } catch {
      return { version: 1, entries: {} }
    }
  }

  private async saveManifest(manifest: MemdirManifest): Promise<void> {
    // Merge against what is currently on disk. Each run builds its own
    // MemdirMemory, so two concurrent runs hold independent snapshots and a
    // blind overwrite would silently drop the other run's handles, leaving the
    // model holding a handle that no longer resolves.
    const onDisk = await this.readManifest()
    const merged: MemdirManifest = {
      version: 1,
      entries: { ...onDisk.entries, ...manifest.entries },
    }
    this.manifest = merged
    await writeWorkspaceFile(MANIFEST_PATH, JSON.stringify(merged, null, 2), this.root)
  }

  private async read(path: string): Promise<string | null> {
    try { return (await readWorkspaceFile(path, this.root)).content }
    catch { return null }
  }
}
