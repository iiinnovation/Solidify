import { create } from 'zustand'
import type { ArtifactType } from '@/stores/chat-store'

export interface DocumentState {
  path: string
  title: string
  type: ArtifactType
  content: string
  streaming: boolean
  messageId?: string
  version: number
  modifiedAt?: number
  error?: string
}

interface DocumentsState {
  documents: Record<string, DocumentState>
  activePath: string | null
  setActivePath: (path: string | null) => void
  upsertDocument: (document: DocumentState) => void
  patchDocument: (path: string, patch: Partial<Omit<DocumentState, 'path'>>) => void
  removeDocument: (path: string) => void
  reset: () => void
}

export const useDocumentStore = create<DocumentsState>((set) => ({
  documents: {},
  activePath: null,
  setActivePath: (activePath) => set({ activePath }),
  upsertDocument: (document) => set((state) => ({
    documents: { ...state.documents, [document.path]: document },
    activePath: document.path,
  })),
  patchDocument: (path, patch) => set((state) => {
    const current = state.documents[path]
    if (!current) return state
    return { documents: { ...state.documents, [path]: { ...current, ...patch } } }
  }),
  removeDocument: (path) => set((state) => {
    const documents = { ...state.documents }
    delete documents[path]
    return { documents, activePath: state.activePath === path ? null : state.activePath }
  }),
  reset: () => set({ documents: {}, activePath: null }),
}))
