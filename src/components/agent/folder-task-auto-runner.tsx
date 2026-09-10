import { useLocation } from 'react-router-dom'
import { useChat } from '@/hooks/use-chat'
import { useChatStore } from '@/stores/chat-store'

/**
 * Keeps automatic FolderTask conversations progressing when their chat route
 * is not mounted. The visible chat owns execution while it is open, preventing
 * two hook instances from scheduling the same durable turn.
 */
export function FolderTaskAutoRunner() {
  const location = useLocation()
  const visibleConversationId = location.pathname.startsWith('/chat/')
    ? location.pathname.slice('/chat/'.length).split('/')[0]
    : undefined
  const conversationId = useChatStore((state) => state.conversations.find((conversation) =>
    conversation.folderTaskId
    && conversation.folderTaskAutoRun
    && conversation.id !== visibleConversationId,
  )?.id)

  useChat(conversationId)
  return null
}
