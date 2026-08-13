import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface WorkspaceState {
  workspaceRoot: string | null
  setWorkspaceRoot: (root: string | null) => void
}

/** Minimal M1 workspace selection. M3 owns indexing and file watching. */
export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      workspaceRoot: null,
      setWorkspaceRoot: (workspaceRoot) => set({ workspaceRoot }),
    }),
    { name: 'solidify-workspace' },
  ),
)
