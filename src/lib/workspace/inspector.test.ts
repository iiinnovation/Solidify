import { describe, expect, it } from 'vitest'
import { conversationChanges, conversationDeliverables } from './inspector'
import type { Artifact, Conversation } from '@/stores/chat-store'

describe('workspace inspector selectors', () => {
  it('collects current-conversation artifacts and deduplicates document versions by path', () => {
    const conversation: Conversation = {
      id: 'conversation-1',
      title: 'Task',
      createdAt: 1,
      messages: [
        { id: 'message-1', role: 'assistant', content: '', documents: [{ path: '03-交付物/report.md', messageId: 'message-1', version: 1 }] },
        { id: 'message-2', role: 'assistant', content: '', documents: [{ path: '03-交付物/report.md', messageId: 'message-2', version: 2 }] },
      ],
    }
    const artifacts: Artifact[] = [
      { id: 'artifact-1', title: 'Chart', type: 'chart', content: '{}', messageId: 'message-1', version: 1 },
      { id: 'artifact-other', title: 'Other', type: 'document', content: '', messageId: 'outside', version: 1 },
    ]

    expect(conversationDeliverables(conversation, artifacts)).toEqual([
      expect.objectContaining({ kind: 'artifact', artifactId: 'artifact-1', title: 'Chart' }),
      expect.objectContaining({ kind: 'document', path: '03-交付物/report.md', version: 2, messageId: 'message-2' }),
    ])
  })

  it('reports only completed writes and keeps the latest record for each path', () => {
    const conversation: Conversation = {
      id: 'conversation-1',
      title: 'Task',
      createdAt: 1,
      messages: [{
        id: 'message-1',
        role: 'assistant',
        content: '',
        agentRun: {
          runId: 'run-1',
          status: 'completed',
          text: '',
          startedAt: 1,
          completedAt: 2,
          tools: [
            { call: { id: 'read', name: 'read_file', input: { path: 'source.md' } }, status: 'completed', startedAt: 1, completedAt: 2, result: { success: true, content: 'read' } },
            { call: { id: 'pending', name: 'write_file', input: { path: 'draft.md', content: 'draft' } }, status: 'running', startedAt: 1 },
            { call: { id: 'write-1', name: 'write_file', input: { path: 'report.md', content: 'old' } }, status: 'completed', startedAt: 1, completedAt: 2, result: { success: true, content: 'ok', metadata: { durationMs: 1, bytesWritten: 3 } } },
            { call: { id: 'write-2', name: 'write_file', input: { path: 'report.md', content: 'new' } }, status: 'completed', startedAt: 2, completedAt: 3, result: { success: true, content: 'ok', metadata: { durationMs: 1, bytesWritten: 3 } } },
          ],
        },
      }],
    }

    expect(conversationChanges(conversation)).toEqual([
      expect.objectContaining({ path: 'report.md', toolName: 'write_file', bytesWritten: 3, id: expect.stringContaining('write-2') }),
    ])
  })

  it('reads generated deck paths from structured tool results', () => {
    const conversation: Conversation = {
      id: 'conversation-1',
      title: 'Task',
      createdAt: 1,
      messages: [{
        id: 'message-1',
        role: 'assistant',
        content: '',
        agentRun: {
          runId: 'run-1', status: 'completed', text: '', tools: [], startedAt: 1, completedAt: 2,
        },
      }],
    }
    conversation.messages[0].agentRun!.tools.push({
      call: { id: 'deck', name: 'generate_pptd', input: { brief: 'Deck' } },
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      result: { success: true, content: 'done', data: { artifact: { path: '03-交付物/deck.pptd' } } },
    })

    expect(conversationChanges(conversation)).toEqual([
      expect.objectContaining({ path: '03-交付物/deck.pptd', operation: 'generated' }),
    ])
  })
})
