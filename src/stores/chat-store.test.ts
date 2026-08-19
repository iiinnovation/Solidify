import { beforeEach, describe, expect, it } from 'vitest'
import { useChatStore } from './chat-store'

describe('chat store truncation', () => {
  beforeEach(() => {
    localStorage.clear()
    useChatStore.setState({ conversations: [], artifacts: [], activeArtifactId: null })
  })

  it('removes artifacts owned by truncated messages and clears the active artifact', () => {
    useChatStore.setState({
      conversations: [{
        id: 'conv', title: 'Conversation', createdAt: 1,
        messages: [
          { id: 'user-1', role: 'user', content: 'keep' },
          { id: 'assistant-1', role: 'assistant', content: 'keep response' },
          { id: 'user-2', role: 'user', content: 'recall' },
          { id: 'assistant-2', role: 'assistant', content: 'remove response' },
        ],
      }],
      artifacts: [
        { id: 'keep-artifact', title: 'Keep', type: 'document', content: 'keep', messageId: 'assistant-1', version: 1 },
        { id: 'remove-artifact', title: 'Remove', type: 'document', content: 'remove', messageId: 'assistant-2', version: 1 },
      ],
      activeArtifactId: 'remove-artifact',
    })

    useChatStore.getState().truncateMessagesFrom('conv', 'user-2')

    expect(useChatStore.getState().conversations[0].messages.map((message) => message.id))
      .toEqual(['user-1', 'assistant-1'])
    expect(useChatStore.getState().artifacts.map((artifact) => artifact.id)).toEqual(['keep-artifact'])
    expect(useChatStore.getState().activeArtifactId).toBeNull()
  })
})
