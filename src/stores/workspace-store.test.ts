import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const events: string[] = []
  class WorkspaceIndexer {
    readonly root: string
    constructor(root: string) { this.root = root }
    async start() { return { files: 0, indexedDocuments: 0 } }
    async stop() { events.push(`stop-index:${this.root}`) }
  }
  return {
    events,
    WorkspaceIndexer,
    openLocalWorkspace: vi.fn(async () => ({ root: '/new', project: { schemaVersion: 1, id: 'new', name: 'New', createdAt: '2026-08-14T00:00:00Z', stage: 'discovery' } })),
    restoreLocalWorkspace: vi.fn(async (root: string) => ({ root, project: { schemaVersion: 1, id: root, name: root, createdAt: '2026-08-14T00:00:00Z', stage: 'discovery' } })),
    restoreWorkspaceConversations: vi.fn(async (root: string) => { events.push(`restore-conversations:${root}`) }),
    startWorkspaceConversationPersistence: vi.fn((root: string) => async () => { events.push(`stop-persistence:${root}`) }),
  }
})

vi.mock('@/lib/tauri', () => ({
  isTauri: true,
  readWorkspaceTree: vi.fn(async () => []),
  searchWorkspaceIndex: vi.fn(async () => []),
}))

vi.mock('@/lib/workspace', () => ({
  WorkspaceIndexer: mocks.WorkspaceIndexer,
  closeLocalWorkspace: vi.fn(async () => undefined),
  createLocalWorkspace: vi.fn(async () => null),
  openLocalWorkspace: mocks.openLocalWorkspace,
  restoreLocalWorkspace: mocks.restoreLocalWorkspace,
  restoreWorkspaceConversations: mocks.restoreWorkspaceConversations,
  startWorkspaceConversationPersistence: mocks.startWorkspaceConversationPersistence,
}))

vi.mock('@/lib/harness/ledger', () => ({
  configureLedgerWorkspace: vi.fn(),
  flushWorkspaceLedger: vi.fn(async () => undefined),
}))

import { useWorkspaceStore } from './workspace-store'

describe('M3 workspace switching', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.events.length = 0
    useWorkspaceStore.setState({
      workspaceRoot: '/old',
      project: null,
      entries: [],
      selectedPath: null,
      indexStats: null,
      status: 'idle',
      error: null,
    })
  })

  it('stops old persistence before restoring the new workspace', async () => {
    await useWorkspaceStore.getState().initialize()
    mocks.events.length = 0

    await useWorkspaceStore.getState().open()

    expect(mocks.events).toContain('stop-persistence:/old')
    expect(mocks.events).toContain('restore-conversations:/new')
    expect(mocks.events.indexOf('stop-persistence:/old'))
      .toBeLessThan(mocks.events.indexOf('restore-conversations:/new'))
  })
})
