import { useParams } from 'react-router-dom'
import { ChatPanel } from '@/components/chat/chat-panel'
import { ArtifactPanel } from '@/components/artifacts/artifact-panel'
import { ResizablePanel } from '@/components/layout/resizable-panel'
import { useUIStore } from '@/stores/ui-store'
import { Workbench } from '@/components/layout/workbench'
import { DocumentViewer } from '@/components/documents/document-viewer'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { isEnabled } from '@/lib/harness/flags'
import { isTauri } from '@/lib/tauri'

export function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>()
  const { chatPanelWidth, setChatPanelWidth } = useUIStore()
  const workspaceRoot = useWorkspaceStore((state) => state.workspaceRoot)

  if (isEnabled('workbenchV2') && isEnabled('localWorkspace') && isTauri && workspaceRoot) {
    return <Workbench chat={<ChatPanel conversationId={conversationId} />} viewer={<DocumentViewer />} />
  }

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
