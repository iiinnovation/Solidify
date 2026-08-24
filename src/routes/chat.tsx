import { useLayoutEffect } from 'react'
import { useParams } from 'react-router-dom'
import { ChatPanel } from '@/components/chat/chat-panel'
import { ResizablePanel } from '@/components/layout/resizable-panel'
import { useUIStore } from '@/stores/ui-store'
import { Workbench } from '@/components/layout/workbench'
import { WorkspaceInspector } from '@/components/workspace/workspace-inspector'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { isEnabled } from '@/lib/harness/flags'
import { isTauri } from '@/lib/tauri'

export function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>()
  const { chatPanelWidth, setChatPanelWidth, workspaceInspectorOpen, closePreviewPanel } = useUIStore()
  const workspaceRoot = useWorkspaceStore((state) => state.workspaceRoot)
  const workbenchEnabled = isEnabled('workbenchV2') && isEnabled('localWorkspace') && isTauri && Boolean(workspaceRoot)

  useLayoutEffect(() => closePreviewPanel(), [conversationId, workspaceRoot, closePreviewPanel])

  if (workbenchEnabled) {
    const inspector = <WorkspaceInspector conversationId={conversationId} onClose={closePreviewPanel} />
    return <Workbench chat={<ChatPanel conversationId={conversationId} />} viewer={inspector} viewerOpen={workspaceInspectorOpen} />
  }

  return (
    <ResizablePanel
      left={<ChatPanel conversationId={conversationId} />}
      right={<WorkspaceInspector conversationId={conversationId} onClose={closePreviewPanel} />}
      rightOpen={workspaceInspectorOpen}
      leftWidth={chatPanelWidth}
      onResize={setChatPanelWidth}
      minLeft={360}
      maxLeft={520}
    />
  )
}
