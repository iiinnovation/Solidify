import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Skill } from '@/lib/skills'

export interface ComposerAttachment {
  attachmentId?: string
  name: string
  size: number
  mimeType?: string
  file?: File
  extractedText?: string
  mediaUrl?: string
  mediaId?: string
  recoverable?: boolean
}

export interface ComposerDraft {
  input: string
  attachments: ComposerAttachment[]
  skill: Skill | null
}

export function isComposerAttachmentRecoverable(att: ComposerAttachment): boolean {
  if (att.recoverable === false) return false
  if (att.file || att.mediaUrl || att.mediaId || att.attachmentId) return true
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(att.name)) return false
  return att.extractedText !== undefined
}

export const NEW_COMPOSER_DRAFT_KEY = '__new__'
export const EMPTY_COMPOSER_DRAFT: ComposerDraft = {
  input: '',
  attachments: [],
  skill: null,
}

export type PreviewPanelKind = 'artifact' | 'document'
export type WorkspaceInspectorTab = 'deliverables' | 'files' | 'changes' | 'preview'

export function composerDraftKey(conversationId?: string): string {
  return conversationId ?? NEW_COMPOSER_DRAFT_KEY
}

interface UIState {
  sidebarOpen: boolean
  sidebarWidth: number
  chatPanelWidth: number
  workspaceInspectorOpen: boolean
  workspaceInspectorTab: WorkspaceInspectorTab
  previewPanelKind: PreviewPanelKind | null
  pendingInput: string | null
  composerDrafts: Record<string, ComposerDraft>
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  setChatPanelWidth: (width: number) => void
  openWorkspaceInspector: (tab?: WorkspaceInspectorTab) => void
  setWorkspaceInspectorTab: (tab: WorkspaceInspectorTab) => void
  openPreviewPanel: (kind: PreviewPanelKind) => void
  closePreviewPanel: () => void
  setPendingInput: (input: string | null) => void
  setComposerDraft: (conversationId: string | undefined, draft: Partial<ComposerDraft> | ((prev: ComposerDraft) => Partial<ComposerDraft>)) => void
  clearComposerDraft: (conversationId?: string) => void
}

function defaultSidebarOpen(): boolean {
  return typeof window === 'undefined'
    || typeof window.matchMedia !== 'function'
    || !window.matchMedia('(max-width: 767px)').matches
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarOpen: defaultSidebarOpen(),
      sidebarWidth: 260,
      chatPanelWidth: 440,
      workspaceInspectorOpen: false,
      workspaceInspectorTab: 'deliverables',
      previewPanelKind: null,
      pendingInput: null,
      composerDrafts: {},
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setSidebarWidth: (width) => set({ sidebarWidth: width }),
      setChatPanelWidth: (width) => set({ chatPanelWidth: width }),
      openWorkspaceInspector: (workspaceInspectorTab = 'deliverables') => set({
        workspaceInspectorOpen: true,
        workspaceInspectorTab,
        ...(isNarrowViewport() ? { sidebarOpen: false } : {}),
      }),
      setWorkspaceInspectorTab: (workspaceInspectorTab) => set({ workspaceInspectorTab }),
      openPreviewPanel: (previewPanelKind) => set({
        workspaceInspectorOpen: true,
        workspaceInspectorTab: 'preview',
        previewPanelKind,
        ...(isNarrowViewport() ? { sidebarOpen: false } : {}),
      }),
      closePreviewPanel: () => set({ workspaceInspectorOpen: false, previewPanelKind: null }),
      setPendingInput: (input) => set({ pendingInput: input }),
      setComposerDraft: (conversationId, draft) =>
        set((state) => {
          const key = composerDraftKey(conversationId)
          const previous = state.composerDrafts[key] ?? EMPTY_COMPOSER_DRAFT
          return {
            composerDrafts: {
              ...state.composerDrafts,
              [key]: {
                ...previous,
                ...(typeof draft === 'function' ? draft(previous) : draft),
              },
            },
          }
        }),
      clearComposerDraft: (conversationId) =>
        set((state) => {
          const key = composerDraftKey(conversationId)
          if (!state.composerDrafts[key]) return state
          const composerDrafts = { ...state.composerDrafts }
          delete composerDrafts[key]
          return { composerDrafts }
        }),
    }),
    {
      name: 'solidify-ui',
      version: 1,
      migrate: (persistedState: unknown, version) => {
        const state = persistedState && typeof persistedState === 'object'
          ? persistedState as Record<string, unknown>
          : {}
        if (version >= 1 || !state.composerDraft || state.composerDrafts) return state
        return {
          ...state,
          composerDrafts: { [NEW_COMPOSER_DRAFT_KEY]: state.composerDraft },
        }
      },
      partialize: (state) => ({
        sidebarOpen: state.sidebarOpen,
        sidebarWidth: state.sidebarWidth,
        chatPanelWidth: state.chatPanelWidth,
        composerDrafts: Object.fromEntries(
          Object.entries(state.composerDrafts).map(([key, draft]) => [key, {
            input: draft.input,
            attachments: draft.attachments
                .filter((att) =>
                  att.recoverable === false
                || att.attachmentId !== undefined
                || att.extractedText !== undefined
                || att.mediaUrl !== undefined
                || att.mediaId !== undefined,
              )
              .map((att) => ({
                attachmentId: att.attachmentId,
                name: att.name,
                size: att.size,
                mimeType: att.mimeType,
                mediaId: att.mediaId,
                recoverable: att.mediaId || att.attachmentId ? true : att.mediaUrl ? false : att.recoverable,
              })),
            skill: draft.skill,
          }]),
        ),
      }),
    },

  ),
)

function isNarrowViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < 768
}
