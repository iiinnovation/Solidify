import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkspaceInspector } from './workspace-inspector'
import { useChatStore } from '@/stores/chat-store'
import { useDocumentStore } from '@/stores/document-store'
import { useUIStore } from '@/stores/ui-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

vi.mock('@/components/artifacts/artifact-panel', () => ({
  ArtifactPanel: () => <div>Artifact preview</div>,
}))

vi.mock('@/components/documents/document-viewer', () => ({
  DocumentViewer: () => <div>Document preview</div>,
}))

vi.mock('@/components/workspace/file-tree', () => ({
  FileTree: ({ entries, onSelect }: { entries: Array<{ path: string; name: string; kind: string }>; onSelect: (path: string) => void }) => (
    <div>{entries.filter((entry) => entry.kind === 'file').map((entry) => (
      <button key={entry.path} type="button" onClick={() => onSelect(entry.path)}>{entry.name}</button>
    ))}</div>
  ),
}))

describe('WorkspaceInspector', () => {
  beforeEach(() => {
    useUIStore.setState({ workspaceInspectorOpen: true, workspaceInspectorTab: 'deliverables', previewPanelKind: null })
    useDocumentStore.setState({ activePath: null, documents: {} })
    useWorkspaceStore.setState({
      workspaceRoot: '/workspace',
      entries: [{ path: 'notes.md', name: 'notes.md', kind: 'file', size: 10, modifiedAt: 1 }],
      selectedPath: null,
      status: 'ready',
    })
    useChatStore.setState({
      activeConversationId: 'conversation-1',
      activeArtifactId: null,
      artifacts: [{ id: 'artifact-1', title: 'Summary', type: 'document', content: '# Summary', messageId: 'message-1', version: 1 }],
      conversations: [{
        id: 'conversation-1',
        title: 'Task',
        createdAt: 1,
        messages: [{
          id: 'message-1',
          role: 'assistant',
          content: 'Done',
          agentRun: {
            runId: 'run-1', status: 'completed', text: '', startedAt: 1, completedAt: 2,
            tools: [{
              call: { id: 'write-1', name: 'write_file', input: { path: 'notes.md', content: 'notes' } },
              status: 'completed', startedAt: 1, completedAt: 2,
              result: { success: true, content: 'ok', metadata: { durationMs: 1, bytesWritten: 5 } },
            }],
          },
        }],
      }],
    })
  })

  it('opens deliverables in the preview tab without closing the inspector', () => {
    render(<WorkspaceInspector conversationId="conversation-1" onClose={() => undefined} />)

    expect(screen.getByRole('tab', { name: /交付物/ }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /Summary/ }))

    expect(useUIStore.getState()).toMatchObject({
      workspaceInspectorOpen: true,
      workspaceInspectorTab: 'preview',
      previewPanelKind: 'artifact',
    })
    expect(useChatStore.getState().activeArtifactId).toBe('artifact-1')
    expect(screen.getByText('Artifact preview')).toBeTruthy()
  })

  it('shows conversation-scoped writes and previews successful files', () => {
    render(<WorkspaceInspector conversationId="conversation-1" onClose={() => undefined} />)
    fireEvent.click(screen.getByRole('tab', { name: /变更/ }))

    expect(screen.getByText('notes.md')).toBeTruthy()
    expect(screen.getByText(/已写入 · 5 B · write_file/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /notes.md/ }))

    expect(useDocumentStore.getState().activePath).toBe('notes.md')
    expect(useUIStore.getState().workspaceInspectorTab).toBe('preview')
    expect(screen.getByText('Document preview')).toBeTruthy()
  })

  it('browses workspace files and closes only through the inspector control', () => {
    const onClose = vi.fn()
    render(<WorkspaceInspector conversationId="conversation-1" onClose={onClose} />)
    fireEvent.click(screen.getByRole('tab', { name: '文件' }))
    fireEvent.click(screen.getByRole('button', { name: 'notes.md' }))

    expect(useWorkspaceStore.getState().selectedPath).toBe('notes.md')
    expect(useUIStore.getState().previewPanelKind).toBe('document')
    fireEvent.click(screen.getByRole('button', { name: '关闭工作区检查器' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('invalidates file search results when the workspace changes', async () => {
    const search = vi.fn(async () => useWorkspaceStore.getState().workspaceRoot === '/workspace'
      ? [{ path: 'old-private.md', text: 'old result', score: 1 }]
      : [{ path: 'new-public.md', text: 'new result', score: 1 }])
    useWorkspaceStore.setState({ search })
    render(<WorkspaceInspector conversationId="conversation-1" onClose={() => undefined} />)
    fireEvent.click(screen.getByRole('tab', { name: '文件' }))
    fireEvent.change(screen.getByPlaceholderText('搜索工作区文件'), { target: { value: 'report' } })
    await waitFor(() => expect(screen.getByText('old-private.md')).toBeTruthy())

    act(() => useWorkspaceStore.setState({ workspaceRoot: '/new-workspace' }))

    await waitFor(() => expect(screen.getByText('new-public.md')).toBeTruthy())
    expect(screen.queryByText('old-private.md')).toBeNull()
    expect(search).toHaveBeenCalledTimes(2)
  })
})
