import { beforeEach, describe, expect, it } from 'vitest'
import { composerDraftKey, EMPTY_COMPOSER_DRAFT, NEW_COMPOSER_DRAFT_KEY, useUIStore } from './ui-store'

describe('UI composer drafts', () => {
  beforeEach(() => {
    localStorage.clear()
    useUIStore.setState({
      composerDrafts: {},
      pendingInput: null,
      workspaceInspectorOpen: false,
      workspaceInspectorTab: 'deliverables',
      previewPanelKind: null,
    })
  })

  it('isolates drafts by conversation and keeps a separate new-chat draft', () => {
    const { setComposerDraft } = useUIStore.getState()
    setComposerDraft('conv-a', { input: 'draft A' })
    setComposerDraft('conv-b', { input: 'draft B' })
    setComposerDraft(undefined, { input: 'new chat' })

    const drafts = useUIStore.getState().composerDrafts
    expect(drafts[composerDraftKey('conv-a')].input).toBe('draft A')
    expect(drafts[composerDraftKey('conv-b')].input).toBe('draft B')
    expect(drafts[NEW_COMPOSER_DRAFT_KEY].input).toBe('new chat')
  })

  it('clears only the selected conversation draft', () => {
    const { setComposerDraft, clearComposerDraft } = useUIStore.getState()
    setComposerDraft('conv-a', { input: 'draft A' })
    setComposerDraft('conv-b', { input: 'draft B' })
    clearComposerDraft('conv-a')

    const drafts = useUIStore.getState().composerDrafts
    expect(drafts[composerDraftKey('conv-a')] ?? EMPTY_COMPOSER_DRAFT).toEqual(EMPTY_COMPOSER_DRAFT)
    expect(drafts[composerDraftKey('conv-b')].input).toBe('draft B')
  })

  it('strips attachment media data from persisted drafts', () => {
    useUIStore.getState().setComposerDraft('conv-image', {
      attachments: [{
        name: 'image.png',
        size: 1024,
        extractedText: '[图片文件: image.png，需要 AI 视觉分析]',
        mediaUrl: 'data:image/png;base64,large-payload',
        mediaId: 'draft-media',
        recoverable: true,
      }],
    })

    const persisted = JSON.parse(localStorage.getItem('solidify-ui') ?? '{}')
    const attachment = persisted.state.composerDrafts['conv-image'].attachments[0]
    expect(attachment.mediaUrl).toBeUndefined()
    expect(attachment.mediaId).toBe('draft-media')
    expect(attachment.recoverable).toBe(true)
  })

  it('keeps preview visibility ephemeral', () => {
    useUIStore.getState().openPreviewPanel('artifact')

    expect(useUIStore.getState().previewPanelKind).toBe('artifact')
    expect(useUIStore.getState().workspaceInspectorOpen).toBe(true)
    expect(useUIStore.getState().workspaceInspectorTab).toBe('preview')
    expect(JSON.parse(localStorage.getItem('solidify-ui') ?? '{}').state.previewPanelKind).toBeUndefined()
    expect(JSON.parse(localStorage.getItem('solidify-ui') ?? '{}').state.workspaceInspectorOpen).toBeUndefined()

    useUIStore.getState().closePreviewPanel()
    expect(useUIStore.getState().previewPanelKind).toBeNull()
    expect(useUIStore.getState().workspaceInspectorOpen).toBe(false)
  })

  it('opens the workspace inspector without requiring a selected preview', () => {
    useUIStore.getState().openWorkspaceInspector('changes')

    expect(useUIStore.getState()).toMatchObject({
      workspaceInspectorOpen: true,
      workspaceInspectorTab: 'changes',
      previewPanelKind: null,
    })
  })

  it('collapses the mobile navigation before opening the inspector', () => {
    const previousWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    useUIStore.setState({ sidebarOpen: true })

    useUIStore.getState().openWorkspaceInspector('files')

    expect(useUIStore.getState()).toMatchObject({
      workspaceInspectorOpen: true,
      workspaceInspectorTab: 'files',
      sidebarOpen: false,
    })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth })
  })
})
