import { useParams } from 'react-router-dom'
import { ChatPanel } from '@/components/chat/chat-panel'
import { ArtifactPanel } from '@/components/artifacts/artifact-panel'
import { ResizablePanel } from '@/components/layout/resizable-panel'
import { useUIStore } from '@/stores/ui-store'

export function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>()
  const { chatPanelWidth, setChatPanelWidth } = useUIStore()

  return (
    <ResizablePanel
      left={<ChatPanel conversationId={conversationId} />}
      right={<ArtifactPanel conversationId={conversationId} />}
      leftWidth={chatPanelWidth}
      onResize={setChatPanelWidth}
      minLeft={360}
      maxLeft={520}
    />
  )
}
