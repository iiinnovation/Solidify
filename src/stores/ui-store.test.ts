import { beforeEach, describe, expect, it } from 'vitest'
import { composerDraftKey, EMPTY_COMPOSER_DRAFT, NEW_COMPOSER_DRAFT_KEY, useUIStore } from './ui-store'

describe('UI composer drafts', () => {
  beforeEach(() => {
    localStorage.clear()
    useUIStore.setState({ composerDrafts: {}, pendingInput: null })
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
})
