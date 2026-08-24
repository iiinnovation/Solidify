import type { Artifact, Conversation } from '@/stores/chat-store'

export interface WorkspaceDeliverable {
  id: string
  kind: 'artifact' | 'document'
  title: string
  path?: string
  messageId: string
  version: number
  artifactId?: string
}

export interface WorkspaceChange {
  id: string
  path: string
  operation: 'generated' | 'written'
  status: 'completed' | 'failed'
  toolName: string
  messageId: string
  bytesWritten?: number
}

export function conversationDeliverables(
  conversation: Conversation | undefined,
  artifacts: readonly Artifact[],
): WorkspaceDeliverable[] {
  if (!conversation) return []
  const messageIds = new Set(conversation.messages.map((message) => message.id))
  const items: WorkspaceDeliverable[] = artifacts
    .filter((artifact) => messageIds.has(artifact.messageId))
    .map((artifact) => ({
      id: `artifact:${artifact.id}`,
      kind: 'artifact',
      title: artifact.title,
      messageId: artifact.messageId,
      version: artifact.version,
      artifactId: artifact.id,
    }))

  const documents = new Map<string, WorkspaceDeliverable>()
  for (const message of conversation.messages) {
    for (const document of message.documents ?? []) {
      documents.set(document.path, {
        id: `document:${document.path}`,
        kind: 'document',
        title: fileName(document.path),
        path: document.path,
        messageId: message.id,
        version: document.version,
      })
    }
  }
  return [...items, ...documents.values()]
}

/**
 * Build a conservative, conversation-scoped change summary from completed
 * write tools. This is intentionally not called a diff: the event stream has
 * the final write and status, but it does not always retain the previous file.
 */
export function conversationChanges(conversation: Conversation | undefined): WorkspaceChange[] {
  if (!conversation) return []
  const changes = new Map<string, WorkspaceChange>()

  for (const message of conversation.messages) {
    for (const item of message.agentRun?.tools ?? []) {
      const path = changedPath(item.call.name, item.call.input, item.result?.data)
      if (!path || item.status !== 'completed') continue
      changes.set(path, {
        id: `${message.id}:${item.call.id}:${path}`,
        path,
        operation: item.call.name === 'generate_pptd' ? 'generated' : 'written',
        status: item.result?.success === false ? 'failed' : 'completed',
        toolName: item.call.name,
        messageId: message.id,
        bytesWritten: item.result?.metadata?.bytesWritten,
      })
    }
  }

  return [...changes.values()]
}

function changedPath(toolName: string, input: unknown, data: unknown): string | undefined {
  if (toolName === 'write_file') return recordString(input, 'path')
  if (toolName === 'generate_pptd') {
    const artifact = recordValue(data, 'artifact')
    return recordString(artifact, 'path') ?? recordString(input, 'artifactPath')
  }
  return undefined
}

function recordValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return (value as Record<string, unknown>)[key]
}

function recordString(value: unknown, key: string): string | undefined {
  const candidate = recordValue(value, key)
  return typeof candidate === 'string' && candidate.trim() ? candidate : undefined
}

function fileName(path: string): string {
  return path.split('/').pop() ?? path
}
