import { extractText } from '@/lib/file-extractor'
import {
  getWorkspaceIndexStats,
  listenWorkspaceChanges,
  readWorkspaceBytes,
  readWorkspaceFile,
  readWorkspaceTree,
  rebuildWorkspaceIndex,
  removeWorkspaceIndexPath,
  startWorkspaceWatcher,
  stopWorkspaceWatcher,
  upsertWorkspaceIndexDocument,
  type WorkspaceFsChange,
  type WorkspaceIndexStats,
} from '@/lib/tauri'

const RICH_TEXT_EXTENSIONS = new Set(['pdf', 'docx'])

export class WorkspaceIndexer {
  private unlisten: (() => void) | null = null
  private stopped = false
  private starting = false
  private changedDuringStart = false
  private changeQueue = Promise.resolve()
  private readonly root: string
  private readonly onChange: (change: WorkspaceFsChange, stats: WorkspaceIndexStats) => void | Promise<void>

  constructor(
    root: string,
    onChange: (change: WorkspaceFsChange, stats: WorkspaceIndexStats) => void | Promise<void>,
  ) {
    this.root = root
    this.onChange = onChange
  }

  async start(): Promise<WorkspaceIndexStats> {
    this.stopped = false
    this.starting = true
    this.changedDuringStart = false
    try {
      this.unlisten = await listenWorkspaceChanges((change) => {
        if (this.starting) {
          this.changedDuringStart = true
          return
        }
        this.enqueueChange(change)
      })
      await startWorkspaceWatcher(this.root)
      const stats = await this.rebuild()
      this.starting = false
      if (this.changedDuringStart) {
        this.enqueueChange({ kind: 'rescan', path: '', isDir: true })
      }
      return stats
    } catch (error) {
      this.starting = false
      this.unlisten?.()
      this.unlisten = null
      await stopWorkspaceWatcher().catch(() => undefined)
      throw error
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.unlisten?.()
    this.unlisten = null
    await stopWorkspaceWatcher()
    await this.changeQueue
  }

  async rebuild(): Promise<WorkspaceIndexStats> {
    await rebuildWorkspaceIndex(this.root)
    const entries = await readWorkspaceTree(this.root)
    for (const entry of entries) {
      if (entry.kind === 'file' && RICH_TEXT_EXTENSIONS.has(extension(entry.path))) {
        await this.indexDocument(entry.path)
      }
    }
    return getWorkspaceIndexStats(this.root)
  }

  private async handleChange(change: WorkspaceFsChange): Promise<void> {
    if (this.stopped) return
    try {
      if (change.kind === 'rescan' || change.isDir) {
        await this.rebuild()
      } else if (change.kind === 'removed') {
        await removeWorkspaceIndexPath(this.root, change.path)
      } else {
        await this.indexDocument(change.path)
      }
      if (this.stopped) return
      const stats = await getWorkspaceIndexStats(this.root)
      await this.onChange(change, stats)
    } catch (error) {
      console.error('Workspace incremental indexing failed:', error)
    }
  }

  private enqueueChange(change: WorkspaceFsChange): void {
    this.changeQueue = this.changeQueue
      .then(() => this.handleChange(change))
      .catch((error) => console.error('Workspace incremental indexing failed:', error))
  }

  private async indexDocument(path: string): Promise<void> {
    const ext = extension(path)
    if (RICH_TEXT_EXTENSIONS.has(ext)) {
      const bytes = new Uint8Array(await readWorkspaceBytes(path, this.root))
      const file = new File([bytes], path.split('/').pop() ?? path, { type: mimeType(ext) })
      await upsertWorkspaceIndexDocument(this.root, path, await extractText(file))
      return
    }
    const result = await readWorkspaceFile(path, this.root)
    await upsertWorkspaceIndexDocument(this.root, path, result.binary ? undefined : result.content ?? undefined)
  }
}

function extension(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? ''
}

function mimeType(extension: string): string {
  if (extension === 'pdf') return 'application/pdf'
  if (extension === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  return 'application/octet-stream'
}
