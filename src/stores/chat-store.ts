import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { QueryEvent } from '@/lib/engine/types'
import type { RunState, ExecutionMetrics } from '@/lib/engine/run-state'
import { createQuotaResilientStateStorage } from '@/lib/storage-quota'
import { createAttachmentResourceId, type AttachmentResource } from '@/lib/attachments/types'
import { saveAttachmentResource } from '@/lib/attachments/store'

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

export interface MessageAttachment {
  attachmentId?: string
  name: string
  size: number
  mimeType?: string
  extractedText?: string
  mediaUrl?: string
  mediaId?: string
  recoverable?: boolean
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  skill?: { id: string; name: string }
  attachments?: MessageAttachment[]
  metrics?: ExecutionMetrics

  knowledgeSources?: Array<{
    id: string
    title: string
    similarity: number
  }>
  /** Agent runs persist their source event stream and reduced UI state together. */
  runEvents?: QueryEvent[]
  agentRun?: RunState
  agentContext?: {
    providerId: string
    workspaceRoot?: string
    skillSystemPrompt?: string
    skillSkipConfirmation?: boolean
    skillId?: string
  }
  requestContext?: {
    skillSystemPrompt?: string
    skillSkipConfirmation?: boolean
    skillId?: string
  }
  /** M3.5: artifacts are file references; content lives in the workspace. */
  documents?: Array<{ path: string; messageId: string; version: number }>
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
  setActiveArtifact: (id: string | null) => void
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
  patchMessageInConversation: (convId: string, messageId: string, patch: Partial<Message>) => void
  removeMessageFromConversation: (convId: string, messageId: string) => void
  removeLastMessageFromConversation: (convId: string) => void
  truncateMessagesFrom: (convId: string, messageId: string) => void
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

      patchMessageInConversation: (convId, messageId, patch) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === messageId ? { ...m, ...patch } : m,
                  ),
                }
              : c,
          ),
        })),

      removeMessageFromConversation: (convId, messageId) =>
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === convId
              ? {
                  ...conversation,
                  messages: conversation.messages.filter((message) => message.id !== messageId),
                }
              : conversation,
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

      truncateMessagesFrom: (convId, messageId) =>
        set((state) => {
          const removedMessageIds = new Set<string>()
          let found = false
          const conversations = state.conversations.map((c) => {
            if (c.id !== convId) return c
            const idx = c.messages.findIndex((m) => m.id === messageId)
            if (idx === -1) return c
            found = true
            c.messages.slice(idx).forEach((message) => removedMessageIds.add(message.id))
            return { ...c, messages: c.messages.slice(0, idx) }
          })
          if (!found) return state
          const artifacts = state.artifacts.filter((artifact) => !removedMessageIds.has(artifact.messageId))
          return {
            conversations,
            artifacts,
            activeArtifactId: state.activeArtifactId && artifacts.some((artifact) => artifact.id === state.activeArtifactId)
              ? state.activeArtifactId
              : null,
          }
        }),
    }),

    {
      name: 'solidify-chat',
      storage: createJSONStorage(() => createQuotaResilientStateStorage(localStorage)),
      partialize: (state) => ({
        conversations: state.conversations.map((conversation) => ({
          ...conversation,
          messages: conversation.messages.map((message) => ({
            ...message,
            attachments: message.attachments?.map(({ mediaUrl, extractedText: _extractedText, ...attachment }) => ({
              ...attachment,
              recoverable: mediaUrl && !attachment.mediaId && !attachment.attachmentId ? false : attachment.recoverable,
            })),
          })),
        })),
        activeConversationId: state.activeConversationId,
        artifacts: state.artifacts,
        activeArtifactId: state.activeArtifactId,
      }),
      onRehydrateStorage: () => {
        // 清理孤儿 artifacts + 迁移旧类型
        return (state: ChatState | undefined) => {
          if (!state) return
          for (const conversation of state.conversations) {
            for (const message of conversation.messages) {
              for (const attachment of message.attachments ?? []) {
                if (attachment.extractedText === undefined && attachment.mediaUrl === undefined) continue
                const resource: AttachmentResource = {
                  id: attachment.attachmentId ?? createAttachmentResourceId({
                    name: attachment.name,
                    size: attachment.size,
                    mimeType: attachment.mimeType,
                    text: attachment.extractedText,
                    mediaId: attachment.mediaId,
                  }),
                  name: attachment.name,
                  size: attachment.size,
                  mimeType: attachment.mimeType,
                  text: attachment.extractedText,
                  mediaUrl: attachment.mediaUrl,
                  mediaId: attachment.mediaId,
                }
                attachment.attachmentId = resource.id
                void saveAttachmentResource(resource).catch((error) => {
                  console.warn('[attachments] legacy resource migration failed', error)
                })
              }
            }
          }
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
