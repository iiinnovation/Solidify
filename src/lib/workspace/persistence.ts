import { appendWorkspaceRecord, listWorkspaceDir, readWorkspaceRecords } from '@/lib/tauri'
import { useChatStore, type Artifact, type Conversation } from '@/stores/chat-store'

interface ConversationSnapshot {
  type: 'conversation.snapshot'
  ts: string
  conversation: Conversation
  artifacts: Artifact[]
}

export async function restoreWorkspaceConversations(root: string): Promise<void> {
  const files = await listWorkspaceDir('.solidify/conversations', root, 1)
  const snapshots: ConversationSnapshot[] = []
  for (const file of files) {
    if (file.kind !== 'file' || !file.name.endsWith('.chat.jsonl')) continue
    const recordId = file.name.slice(0, -'.jsonl'.length)
    const records = await readWorkspaceRecords<ConversationSnapshot>(root, 'conversations', recordId)
    const latest = [...records].reverse().find(isConversationSnapshot)
    if (latest) snapshots.push(latest)
  }
  snapshots.sort((left, right) => right.conversation.createdAt - left.conversation.createdAt)
  const conversations = snapshots.map((snapshot) => snapshot.conversation)
  useChatStore.setState({
    conversations,
    artifacts: snapshots.flatMap((snapshot) => snapshot.artifacts),
    activeConversationId: conversations[0]?.id ?? null,
    activeArtifactId: null,
  })
}

export function startWorkspaceConversationPersistence(root: string): () => Promise<void> {
  const lastSaved = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let inFlight = Promise.resolve()

  const persist = async () => {
    timer = null
    const state = useChatStore.getState()
    for (const conversation of state.conversations) {
      const messageIds = new Set(conversation.messages.map((message) => message.id))
      const artifacts = state.artifacts.filter((artifact) => messageIds.has(artifact.messageId))
      const snapshot: ConversationSnapshot = { type: 'conversation.snapshot', ts: new Date().toISOString(), conversation, artifacts }
      const serialized = JSON.stringify({ conversation, artifacts })
      if (lastSaved.get(conversation.id) === serialized) continue
      await appendWorkspaceRecord(root, 'conversations', `${safeId(conversation.id)}.chat`, snapshot)
      lastSaved.set(conversation.id, serialized)
    }
  }

  const enqueuePersist = () => {
    const next = inFlight.catch(() => undefined).then(persist)
    inFlight = next
    return next
  }

  const schedule = () => {
    if (stopped || timer) return
    timer = setTimeout(() => { void enqueuePersist().catch((error) => console.error('Unable to persist workspace conversations:', error)) }, 250)
  }
  const unsubscribe = useChatStore.subscribe(schedule)
  schedule()
  return async () => {
    stopped = true
    unsubscribe()
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    await enqueuePersist()
  }
}

function isConversationSnapshot(value: unknown): value is ConversationSnapshot {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<ConversationSnapshot>
  return record.type === 'conversation.snapshot'
    && Boolean(record.conversation)
    && Array.isArray(record.artifacts)
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_')
}
