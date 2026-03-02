import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/* ── 共享类型 ── */

export type ArtifactType = 'document' | 'slides' | 'code' | 'mermaid' | 'chart' | 'drawio'

export interface Artifact {
  id: string
  title: string
  type: ArtifactType
  content: string
  messageId: string
  version: number
  streaming?: boolean
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  attachments?: { name: string; size: number }[]
  knowledgeSources?: Array<{
    id: string
    title: string
    similarity: number
  }>
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: number
}

/* ── Store 类型 ── */

interface ChatState {
  /* Artifact */
  artifacts: Artifact[]
  activeArtifactId: string | null
  setActiveArtifact: (id: string) => void
  addArtifact: (artifact: Artifact) => void
  updateArtifactContent: (id: string, content: string, streaming?: boolean) => void

  /* Conversation */
  conversations: Conversation[]
  activeConversationId: string | null
  createConversation: (title: string) => string
  setActiveConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
  deleteConversation: (id: string) => void
  addMessageToConversation: (convId: string, message: Message) => void
  updateMessageInConversation: (convId: string, messageId: string, content: string) => void
  removeLastMessageFromConversation: (convId: string) => void
}

/* ── ID 生成 ── */

let idCounter = 0
function genId(prefix: string) {
  return `${prefix}-${Date.now()}-${++idCounter}`
}

/* ── Store ── */

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      /* ── Artifact state ── */
      artifacts: [],
      activeArtifactId: null,

      setActiveArtifact: (id) => set({ activeArtifactId: id }),

      addArtifact: (artifact) =>
        set((state) => ({
          artifacts: [...state.artifacts, artifact],
          activeArtifactId: artifact.id,
        })),

      updateArtifactContent: (id, content, streaming) =>
        set((state) => ({
          artifacts: state.artifacts.map((a) =>
            a.id === id
              ? { ...a, content, ...(streaming !== undefined && { streaming }) }
              : a,
          ),
        })),

      /* ── Conversation state ── */
      conversations: [],
      activeConversationId: null,

      createConversation: (title) => {
        const id = genId('conv')
        set((state) => ({
          conversations: [
            { id, title, messages: [], createdAt: Date.now() },
            ...state.conversations,
          ],
          activeConversationId: id,
        }))
        return id
      },

      setActiveConversation: (id) => set({ activeConversationId: id }),

      renameConversation: (id, title) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, title } : c
          ),
        })),

      deleteConversation: (id) =>
        set((state) => {
          const filtered = state.conversations.filter((c) => c.id !== id)
          return {
            conversations: filtered,
            activeConversationId:
              state.activeConversationId === id
                ? (filtered[0]?.id ?? null)
                : state.activeConversationId,
            // 清理关联的 artifacts
            artifacts: state.artifacts.filter(
              (a) =>
                !state.conversations
                  .find((c) => c.id === id)
                  ?.messages.some((m) => m.id === a.messageId),
            ),
          }
        }),

      addMessageToConversation: (convId, message) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === convId
              ? { ...c, messages: [...c.messages, message] }
              : c,
          ),
        })),

      updateMessageInConversation: (convId, messageId, content) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === messageId ? { ...m, content } : m,
                  ),
                }
              : c,
          ),
        })),

      removeLastMessageFromConversation: (convId) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === convId
              ? { ...c, messages: c.messages.slice(0, -1) }
              : c,
          ),
        })),
    }),
    {
      name: 'solidify-chat',
      partialize: (state) => ({
        conversations: state.conversations,
        activeConversationId: state.activeConversationId,
        artifacts: state.artifacts,
        activeArtifactId: state.activeArtifactId,
      }),
      onRehydrateStorage: () => {
        // 清理孤儿 artifacts + 迁移旧类型
        return (state: ChatState | undefined) => {
          if (!state) return
          const allMessageIds = new Set(
            state.conversations.flatMap((c) => c.messages.map((m) => m.id)),
          )
          // 过滤孤儿 + 迁移旧的 diagram 类型到 mermaid
          const cleaned = state.artifacts
            .filter((a) => allMessageIds.has(a.messageId))
            .map((a) => ({
              ...a,
              // 迁移旧类型
              type: a.type === ('diagram' as ArtifactType) ? 'mermaid' : a.type,
            }))
          if (cleaned.length !== state.artifacts.length || state.artifacts.some(a => a.type === ('diagram' as ArtifactType))) {
            useChatStore.setState({
              artifacts: cleaned,
              activeArtifactId:
                state.activeArtifactId && cleaned.some((a) => a.id === state.activeArtifactId)
                  ? state.activeArtifactId
                  : null,
            })
          }
        }
      },
    },
  ),
)
