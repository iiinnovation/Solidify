import type { ApprovalAnswer, ApprovalRequest, ApprovalResponder } from './approval'

type Listener = (request: ApprovalRequest | null) => void
type BatchListener = (requests: ApprovalRequest[]) => void
interface PendingApproval {
  request: ApprovalRequest
  resolve: (answer: ApprovalAnswer) => void
}

const listeners = new Set<Listener>()
const batchListeners = new Set<BatchListener>()
const pending = new Map<string, PendingApproval>()

function requests(): ApprovalRequest[] {
  return [...pending.values()].map((entry) => entry.request)
}

function publish(): void {
  const current = requests()
  for (const listener of listeners) listener(current[0] ?? null)
  for (const listener of batchListeners) listener(current)
}

function hasSubscribers(): boolean {
  return listeners.size > 0 || batchListeners.size > 0
}

export const approvalResponder: ApprovalResponder = (request) => {
  if (!hasSubscribers()) return Promise.reject(new Error('No approval UI is subscribed'))
  if (request.signal.aborted) return Promise.resolve('deny')
  return new Promise<ApprovalAnswer>((resolve) => {
    const onAbort = () => settle(request.requestId, 'deny')
    request.signal.addEventListener('abort', onAbort, { once: true })
    pending.set(request.requestId, {
      request,
      resolve: (answer) => {
        request.signal.removeEventListener('abort', onAbort)
        resolve(answer)
      },
    })
    publish()
  })
}

function settle(requestId: string, answer: ApprovalAnswer): boolean {
  const entry = pending.get(requestId)
  if (!entry) return false
  pending.delete(requestId)
  entry.resolve(answer)
  publish()
  return true
}

export function answerApproval(requestId: string, answer: ApprovalAnswer): boolean {
  return settle(requestId, answer)
}

/** Backward-compatible single-request subscription used by non-M6 callers. */
export function subscribeApproval(listener: Listener): () => void {
  listeners.add(listener)
  listener(requests()[0] ?? null)
  return () => {
    listeners.delete(listener)
    closeWithoutUI()
  }
}

/** M6 UI subscription: all concurrent requests are rendered in one dialog. */
export function subscribeApprovals(listener: BatchListener): () => void {
  batchListeners.add(listener)
  listener(requests())
  return () => {
    batchListeners.delete(listener)
    closeWithoutUI()
  }
}

function closeWithoutUI(): void {
  if (hasSubscribers()) return
  for (const requestId of [...pending.keys()]) settle(requestId, 'deny')
}
