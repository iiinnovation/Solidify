import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface UIState {
  sidebarOpen: boolean
  sidebarWidth: number
  chatPanelWidth: number
  pendingInput: string | null
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  setChatPanelWidth: (width: number) => void
  setPendingInput: (input: string | null) => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      sidebarWidth: 260,
      chatPanelWidth: 440,
      pendingInput: null,
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setSidebarWidth: (width) => set({ sidebarWidth: width }),
      setChatPanelWidth: (width) => set({ chatPanelWidth: width }),
      setPendingInput: (input) => set({ pendingInput: input }),
    }),
    {
      name: 'solidify-ui',
      partialize: (state) => ({
        sidebarOpen: state.sidebarOpen,
        sidebarWidth: state.sidebarWidth,
        chatPanelWidth: state.chatPanelWidth,
      }),
    },
  ),
)
