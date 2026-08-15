import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { isTauri, readWorkspaceTree, searchWorkspaceIndex, updateWorkspaceProjectStage, type WorkspaceIndexStats } from '@/lib/tauri'
import { WorkspaceIndexer, closeLocalWorkspace, createLocalWorkspace, openLocalWorkspace, restoreLocalWorkspace, restoreWorkspaceConversations, startWorkspaceConversationPersistence } from '@/lib/workspace'
import type { WorkspaceEntry, WorkspaceInfo, WorkspaceSearchResult } from '@/lib/workspace'
import { useChatStore } from '@/stores/chat-store'
import { configureLedgerWorkspace, flushWorkspaceLedger } from '@/lib/harness/ledger'
import { migrateLegacyArtifactsToWorkspace } from '@/lib/migration'
import { isEnabled } from '@/lib/harness/flags'
import { useDocumentStore } from '@/stores/document-store'

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
  setStage: (stage: string) => Promise<void>
}

let activeIndexer: WorkspaceIndexer | null = null
let stopConversationPersistence: (() => Promise<void>) | null = null
let initialization: Promise<void> | null = null
let activation: Promise<void> = Promise.resolve()

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
        useDocumentStore.getState().reset()
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
      setStage: async (stage) => {
        const root = get().workspaceRoot
        if (!root) return
        const project = await updateWorkspaceProjectStage(root, stage)
        set({ project })
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
  // Serialize activations: two overlapping calls (e.g. layout initialize racing a
  // user-triggered open) would each build an indexer, and the loser's Tauri event
  // listener would never be unlistened — leaking a live listener for the process
  // lifetime that keeps re-walking the tree on every fs change.
  const previous = activation
  activation = (async () => {
    await previous
    try {
      set({ status: 'indexing', error: null })
      await activeIndexer?.stop()
      activeIndexer = null
      // Flush and detach the previous workspace BEFORE `load` reassigns the
      // native workspace authorization — a flush afterwards would be rejected by
      // the Rust side because it still targets the old root.
      await stopConversationPersistence?.()
      stopConversationPersistence = null
      await flushWorkspaceLedger()
      configureLedgerWorkspace(null)

      const info = await load(root)
      set({ workspaceRoot: info.root, project: info.project })
      await restoreWorkspaceConversations(info.root)
      if (isEnabled('workbenchV2')) await migrateLegacyArtifactsToWorkspace(info.root)
      stopConversationPersistence = startWorkspaceConversationPersistence(info.root)
      const entries = await readWorkspaceTree(info.root)
      const indexer = new WorkspaceIndexer(info.root, async (_change, indexStats) => {
        if (get().workspaceRoot !== info.root) return
        set({ entries: await readWorkspaceTree(info.root), indexStats })
      })
      activeIndexer = indexer
      const indexStats = await indexer.start()
      set({ entries, indexStats, status: 'ready' })
    } catch (error) {
      set({ status: 'error', error: errorMessage(error) })
    }
  })()
  return activation
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
