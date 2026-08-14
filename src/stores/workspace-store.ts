import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { isTauri, readWorkspaceTree, searchWorkspaceIndex, type WorkspaceIndexStats } from '@/lib/tauri'
import { WorkspaceIndexer, closeLocalWorkspace, createLocalWorkspace, openLocalWorkspace, restoreLocalWorkspace, restoreWorkspaceConversations, startWorkspaceConversationPersistence } from '@/lib/workspace'
import type { WorkspaceEntry, WorkspaceInfo, WorkspaceSearchResult } from '@/lib/workspace'
import { useChatStore } from '@/stores/chat-store'
import { configureLedgerWorkspace, flushWorkspaceLedger } from '@/lib/harness/ledger'

interface WorkspaceState {
  workspaceRoot: string | null
  project: WorkspaceInfo['project'] | null
  entries: WorkspaceEntry[]
  selectedPath: string | null
  indexStats: WorkspaceIndexStats | null
  status: 'idle' | 'opening' | 'indexing' | 'ready' | 'error'
  error: string | null
  setWorkspaceRoot: (root: string | null) => void
  initialize: () => Promise<void>
  open: () => Promise<void>
  create: (name: string) => Promise<void>
  close: () => Promise<void>
  refreshTree: () => Promise<void>
  selectPath: (path: string | null) => void
  search: (query: string, limit?: number) => Promise<WorkspaceSearchResult[]>
}

let activeIndexer: WorkspaceIndexer | null = null
let stopConversationPersistence: (() => Promise<void>) | null = null
let initialization: Promise<void> | null = null

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      workspaceRoot: null,
      project: null,
      entries: [],
      selectedPath: null,
      indexStats: null,
      status: 'idle',
      error: null,
      setWorkspaceRoot: (workspaceRoot) => set({ workspaceRoot }),
      initialize: async () => {
        if (initialization) return initialization
        const root = get().workspaceRoot
        if (!isTauri || !root) return
        initialization = activate(root, restoreLocalWorkspace, set, get).finally(() => { initialization = null })
        return initialization
      },
      open: async () => {
        set({ status: 'opening', error: null })
        try {
          const info = await openLocalWorkspace()
          if (!info) { set({ status: get().workspaceRoot ? 'ready' : 'idle' }); return }
          await activate(info.root, async () => info, set, get)
        } catch (error) {
          set({ status: 'error', error: errorMessage(error) })
        }
      },
      create: async (name) => {
        set({ status: 'opening', error: null })
        try {
          const info = await createLocalWorkspace(name)
          if (!info) { set({ status: get().workspaceRoot ? 'ready' : 'idle' }); return }
          await activate(info.root, async () => info, set, get)
        } catch (error) {
          set({ status: 'error', error: errorMessage(error) })
        }
      },
      close: async () => {
        await activeIndexer?.stop()
        activeIndexer = null
        await stopConversationPersistence?.()
        stopConversationPersistence = null
        await flushWorkspaceLedger()
        configureLedgerWorkspace(null)
        await closeLocalWorkspace()
        useChatStore.setState({ conversations: [], artifacts: [], activeConversationId: null, activeArtifactId: null })
        set({ workspaceRoot: null, project: null, entries: [], selectedPath: null, indexStats: null, status: 'idle', error: null })
      },
      refreshTree: async () => {
        const root = get().workspaceRoot
        if (!root) return
        set({ entries: await readWorkspaceTree(root) })
      },
      selectPath: (selectedPath) => set({ selectedPath }),
      search: async (query, limit) => {
        const root = get().workspaceRoot
        if (!root || !query.trim()) return []
        return searchWorkspaceIndex(root, query, limit)
      },
    }),
    {
      name: 'solidify-workspace',
      partialize: (state) => ({ workspaceRoot: state.workspaceRoot, project: state.project }),
    },
  ),
)

async function activate(
  root: string,
  load: (root: string) => Promise<WorkspaceInfo>,
  set: (partial: Partial<WorkspaceState>) => void,
  get: () => WorkspaceState,
): Promise<void> {
  try {
    set({ status: 'indexing', error: null })
    await activeIndexer?.stop()
    const info = await load(root)
    await stopConversationPersistence?.()
    stopConversationPersistence = null
    set({ workspaceRoot: info.root, project: info.project })
    await restoreWorkspaceConversations(info.root)
    stopConversationPersistence = startWorkspaceConversationPersistence(info.root)
    const entries = await readWorkspaceTree(info.root)
    activeIndexer = new WorkspaceIndexer(info.root, async (_change, indexStats) => {
      if (get().workspaceRoot !== info.root) return
      set({ entries: await readWorkspaceTree(info.root), indexStats })
    })
    const indexStats = await activeIndexer.start()
    set({ entries, indexStats, status: 'ready' })
  } catch (error) {
    set({ status: 'error', error: errorMessage(error) })
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
