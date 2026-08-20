import { appendWorkspaceRecord, listWorkspaceDir, readWorkspaceRecords } from '@/lib/tauri'
import { useChatStore, type Artifact, type Conversation } from '@/stores/chat-store'

interface ConversationSnapshot {
  type: 'conversation.snapshot'
  ts: string
  conversation: Conversation
  artifacts: Artifact[]
}

interface ConversationTombstone {
  type: 'conversation.deleted'
  ts: string
  id: string
}

type ConversationRecord = ConversationSnapshot | ConversationTombstone

export interface WorkspaceConversationSet {
  conversations: Conversation[]
  artifacts: Artifact[]
}

/** Read the conversations a workspace already owns. Does not touch the store. */
export async function loadWorkspaceConversations(root: string): Promise<WorkspaceConversationSet> {
  const files = await listWorkspaceDir('.solidify/conversations', root, 1)
  const snapshots: ConversationSnapshot[] = []
  for (const file of files) {
    if (file.kind !== 'file' || !file.name.endsWith('.chat.jsonl')) continue
    const recordId = file.name.slice(0, -'.jsonl'.length)
    const records = await readWorkspaceRecords<ConversationRecord>(root, 'conversations', recordId)
    // The last record wins: a trailing tombstone means the conversation was
    // deleted and must not be resurrected on the next open.
    const latest = [...records].reverse().find(isConversationRecord)
    if (latest && latest.type === 'conversation.snapshot') snapshots.push(latest)
  }
  snapshots.sort((left, right) => sortKey(right.conversation) - sortKey(left.conversation))
  return {
    conversations: snapshots.map((snapshot) => snapshot.conversation),
    artifacts: snapshots.flatMap((snapshot) => snapshot.artifacts),
  }
}

/**
 * Adopt a workspace's conversations into the chat store.
 *
 * A workspace that owns conversations is the source of truth for them. A
 * workspace that owns none must NOT clear the store: the chat store is
 * persisted to localStorage, so overwriting it with an empty set on the first
 * "open folder" would irreversibly destroy history the user accumulated in
 * cloud mode. In that case the existing conversations are carried over and the
 * persistence loop below writes them into the newly opened workspace.
 */
export async function restoreWorkspaceConversations(root: string): Promise<void> {
  const { conversations, artifacts } = await loadWorkspaceConversations(root)
  if (conversations.length === 0) return
  useChatStore.setState({
    conversations,
    artifacts,
    activeConversationId: conversations[0]?.id ?? null,
    activeArtifactId: null,
  })
}

/** `createdAt` may be a corrupted `NaN` from an older export; sort it last. */
function sortKey(conversation: Conversation): number {
  return Number.isFinite(conversation.createdAt) ? conversation.createdAt : 0
}

export function startWorkspaceConversationPersistence(root: string): () => Promise<void> {
  const lastSaved = new Map<string, string>()
  let known: Set<string> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let inFlight = Promise.resolve()

  const persist = async () => {
    timer = null
    const state = useChatStore.getState()
    const present = new Set(state.conversations.map((conversation) => conversation.id))

    for (const conversation of state.conversations) {
      const messageIds = new Set(conversation.messages.map((message) => message.id))
      const artifacts = state.artifacts.filter((artifact) => messageIds.has(artifact.messageId))
      // `runEvents` is a per-run UI trace, not part of the conversation record.
      // Snapshotting it appended the whole event stream on every change, which
      // made the append-only file grow quadratically in turn count.
      const persisted = { ...conversation, messages: conversation.messages.map(stripTransient) }
      const serialized = JSON.stringify({ conversation: persisted, artifacts })
      if (lastSaved.get(conversation.id) === serialized) continue
      const snapshot: ConversationSnapshot = {
        type: 'conversation.snapshot',
        ts: new Date().toISOString(),
        conversation: persisted,
        artifacts,
      }
      await appendWorkspaceRecord(root, 'conversations', `${safeId(conversation.id)}.chat`, snapshot)
      lastSaved.set(conversation.id, serialized)
    }

    // Tombstone removals. Without this a deleted conversation's file survived
    // and the conversation reappeared on the next workspace open.
    if (known) {
      for (const id of known) {
        if (present.has(id)) continue
        await appendWorkspaceRecord(root, 'conversations', `${safeId(id)}.chat`, {
          type: 'conversation.deleted', ts: new Date().toISOString(), id,
        })
        lastSaved.delete(id)
      }
    }
    known = present
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

function isConversationRecord(value: unknown): value is ConversationRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<ConversationRecord>
  if (record.type === 'conversation.deleted') return true
  return record.type === 'conversation.snapshot'
    && Boolean((record as Partial<ConversationSnapshot>).conversation)
    && Array.isArray((record as Partial<ConversationSnapshot>).artifacts)
}

/**
 * Drop per-run UI trace from the persisted record. `runEvents` holds the whole
 * QueryEvent stream for a run; keeping it turned every snapshot append into a
 * copy of every prior run's events.
 */
function stripTransient(message: Conversation['messages'][number]): Conversation['messages'][number] {
  const { runEvents: _runEvents, ...rest } = message as typeof message & { runEvents?: unknown }
  if (message.agentRun?.status === 'completed') {
    // The cleaned message/artifact or workspace document is authoritative after
    // completion. Do not append the raw artifact envelope to every JSONL
    // snapshot as part of the RunState text.
    return { ...rest, agentRun: { ...message.agentRun, text: '' } }
  }
  return 'runEvents' in message ? rest as typeof message : message
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_')
}
