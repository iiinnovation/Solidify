import type { Message } from '@/stores/chat-store'

export interface ActiveChatRun {
  conversationId: string
  workspaceRoot: string | null
  token: symbol
  controller: AbortController
  messages: Message[]
}

const runs = new Map<string, ActiveChatRun>()
const listeners = new Set<() => void>()
let revision = 0

function emitChange() {
  revision += 1
  for (const listener of listeners) listener()
}

export function subscribeChatRuns(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getChatRunsRevision(): number {
  return revision
}

export function getActiveChatRun(conversationId: string | undefined): ActiveChatRun | undefined {
  return conversationId ? runs.get(conversationId) : undefined
}

export function startChatRun(input: Omit<ActiveChatRun, 'token'>): symbol | undefined {
  if (runs.has(input.conversationId)) return undefined
  const token = Symbol(input.conversationId)
  runs.set(input.conversationId, { ...input, token })
  emitChange()
  return token
}

export function isCurrentChatRun(conversationId: string, token: symbol): boolean {
  return runs.get(conversationId)?.token === token
}

export function updateChatRunMessages(
  conversationId: string,
  token: symbol,
  update: (messages: Message[]) => Message[],
): Message[] | undefined {
  const run = runs.get(conversationId)
  if (!run || run.token !== token) return undefined
  const messages = update(run.messages)
  runs.set(conversationId, { ...run, messages })
  emitChange()
  return messages
}

export function finishChatRun(conversationId: string, token: symbol): void {
  if (!isCurrentChatRun(conversationId, token)) return
  runs.delete(conversationId)
  emitChange()
}

export function abortChatRun(conversationId: string | undefined): void {
  if (!conversationId) return
  runs.get(conversationId)?.controller.abort()
}

/** Explicit user actions cancel a run; ordinary navigation never does. */
export function cancelChatRun(conversationId: string | undefined): void {
  if (!conversationId) return
  const run = runs.get(conversationId)
  if (!run) return
  runs.delete(conversationId)
  emitChange()
  run.controller.abort()
}

export function cancelChatRunsForWorkspace(workspaceRoot: string | null): void {
  const cancelled = [...runs.values()].filter((run) => run.workspaceRoot === workspaceRoot)
  if (cancelled.length === 0) return
  for (const run of cancelled) runs.delete(run.conversationId)
  emitChange()
  for (const run of cancelled) run.controller.abort()
}

export function resetChatRunsForTests(): void {
  for (const run of runs.values()) run.controller.abort()
  runs.clear()
  emitChange()
}
