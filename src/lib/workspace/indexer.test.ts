import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  listener: null as ((change: { kind: 'created' | 'removed'; path: string; isDir: boolean }) => void) | null,
  releaseRemove: (() => undefined) as () => void,
  getWorkspaceIndexStats: vi.fn(async () => ({ files: 1, indexedDocuments: 1 })),
  readWorkspaceFile: vi.fn(async () => ({ content: 'updated', binary: false, bytes: 7, truncated: false })),
  readWorkspaceTree: vi.fn(async () => []),
  rebuildWorkspaceIndex: vi.fn(async () => { mocks.order.push('rebuild'); return { files: 0, indexedDocuments: 0 } }),
  removeWorkspaceIndexPath: vi.fn<(root: string, path: string) => Promise<void>>(async () => undefined),
  startWorkspaceWatcher: vi.fn(async () => { mocks.order.push('watch') }),
  upsertWorkspaceIndexDocument: vi.fn(async () => undefined),
}))

vi.mock('@/lib/tauri', () => ({
  getWorkspaceIndexStats: mocks.getWorkspaceIndexStats,
  listenWorkspaceChanges: vi.fn(async (listener: typeof mocks.listener) => { mocks.listener = listener; return () => undefined }),
  readWorkspaceBytes: vi.fn(async () => []),
  readWorkspaceFile: mocks.readWorkspaceFile,
  readWorkspaceTree: mocks.readWorkspaceTree,
  rebuildWorkspaceIndex: mocks.rebuildWorkspaceIndex,
  removeWorkspaceIndexPath: mocks.removeWorkspaceIndexPath,
  startWorkspaceWatcher: mocks.startWorkspaceWatcher,
  stopWorkspaceWatcher: vi.fn(async () => undefined),
  upsertWorkspaceIndexDocument: mocks.upsertWorkspaceIndexDocument,
}))

import { WorkspaceIndexer } from './indexer'

describe('M3 workspace incremental indexer', () => {
  beforeEach(() => {
    mocks.order.length = 0
    mocks.listener = null
    mocks.getWorkspaceIndexStats.mockClear()
    mocks.readWorkspaceFile.mockClear()
    mocks.rebuildWorkspaceIndex.mockClear()
    mocks.removeWorkspaceIndexPath.mockReset()
    mocks.removeWorkspaceIndexPath.mockResolvedValue(undefined)
    mocks.startWorkspaceWatcher.mockClear()
    mocks.upsertWorkspaceIndexDocument.mockClear()
  })

  it('starts watching before the initial scan', async () => {
    const indexer = new WorkspaceIndexer('/workspace', vi.fn())
    await indexer.start()
    expect(mocks.order).toEqual(['watch', 'rebuild'])
    await indexer.stop()
  })

  it('serializes consecutive filesystem changes', async () => {
    const indexer = new WorkspaceIndexer('/workspace', vi.fn())
    await indexer.start()
    mocks.removeWorkspaceIndexPath.mockImplementation(() => new Promise<void>((resolve) => { mocks.releaseRemove = resolve }))

    mocks.listener?.({ kind: 'removed', path: 'old.txt', isDir: false })
    mocks.listener?.({ kind: 'created', path: 'new.txt', isDir: false })
    await vi.waitFor(() => expect(mocks.removeWorkspaceIndexPath).toHaveBeenCalledOnce())
    expect(mocks.upsertWorkspaceIndexDocument).not.toHaveBeenCalled()

    mocks.releaseRemove()
    await vi.waitFor(() => expect(mocks.upsertWorkspaceIndexDocument).toHaveBeenCalledOnce())
    await indexer.stop()
  })
})
