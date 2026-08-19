import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ArtifactPanel } from './artifact-panel'
import { useChatStore } from '@/stores/chat-store'

describe('ArtifactPanel PPTD integration', () => {
  beforeEach(() => useChatStore.setState({ artifacts: [], conversations: [], activeArtifactId: null, activeConversationId: null }))

  it('routes slide artifacts containing PPTD to the local renderer', () => {
    const content = `version: v2
title: Panel PPTD
size: [960, 540]
theme: {colors: {bg: '#fff'}, textStyles: {}}
pages:
  - elements:
      - elementId: title
        elementType: text
        bounds: [40, 40, 400, 60]
        content: {text: Rendered in panel, fontSize: 24}
`
    useChatStore.setState({
      artifacts: [{ id: 'artifact-1', title: 'Deck', type: 'slides', content, messageId: 'message-1', version: 1 }],
      activeArtifactId: 'artifact-1',
      conversations: [{ id: 'conversation-1', title: 'Conversation', createdAt: 1, messages: [{ id: 'message-1', role: 'assistant', content: '' }] }],
      activeConversationId: 'conversation-1',
    })
    render(<ArtifactPanel conversationId="conversation-1" />)
    expect(screen.getByText('Rendered in panel')).toBeTruthy()
    expect(document.querySelector('[data-pptd-artifact="Panel PPTD"]')).toBeTruthy()
  })

  it('closes the active artifact without removing it', () => {
    useChatStore.setState({
      artifacts: [{ id: 'artifact-1', title: '附件.md', type: 'document', content: '# 内容', messageId: 'message-1', version: 1 }],
      activeArtifactId: 'artifact-1',
      conversations: [{ id: 'conversation-1', title: 'Conversation', createdAt: 1, messages: [{ id: 'message-1', role: 'assistant', content: '' }] }],
      activeConversationId: 'conversation-1',
    })

    render(<ArtifactPanel conversationId="conversation-1" />)
    fireEvent.click(screen.getByRole('button', { name: '关闭预览' }))

    expect(useChatStore.getState().activeArtifactId).toBeNull()
    expect(useChatStore.getState().artifacts).toHaveLength(1)
    expect(screen.getByText('Artifacts 将在此处展示')).toBeTruthy()
  })
})
