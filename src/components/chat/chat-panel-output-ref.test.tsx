import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ArtifactRefCard, DocumentRefCard } from './chat-panel'
import { useChatStore, type Message } from '@/stores/chat-store'
import { useDocumentStore } from '@/stores/document-store'
import { useUIStore } from '@/stores/ui-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

describe('chat output references', () => {
  beforeEach(() => {
    useChatStore.setState({ artifacts: [], activeArtifactId: null })
    useDocumentStore.getState().reset()
    useWorkspaceStore.setState({ selectedPath: null })
    useUIStore.setState({ previewPanelKind: null })
  })

  it('opens a legacy Artifact only after its card is clicked', () => {
    useChatStore.setState({
      artifacts: [{
        id: 'artifact-1',
        title: '需求规格',
        type: 'document',
        content: '# 需求',
        messageId: 'message-1',
        version: 1,
      }],
    })

    render(<ArtifactRefCard messageId="message-1" />)
    expect(useUIStore.getState().previewPanelKind).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /需求规格/ }))

    expect(useChatStore.getState().activeArtifactId).toBe('artifact-1')
    expect(useUIStore.getState().previewPanelKind).toBe('artifact')
  })

  it('opens a workspace document only after its card is clicked', () => {
    const message: Message = {
      id: 'message-2',
      role: 'assistant',
      content: '',
      documents: [{ path: '03-交付物/方案.md', messageId: 'message-2', version: 1 }],
    }

    render(<DocumentRefCard message={message} />)
    expect(useUIStore.getState().previewPanelKind).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /方案\.md/ }))

    expect(useWorkspaceStore.getState().selectedPath).toBe('03-交付物/方案.md')
    expect(useDocumentStore.getState().activePath).toBe('03-交付物/方案.md')
    expect(useUIStore.getState().previewPanelKind).toBe('document')
  })
})
