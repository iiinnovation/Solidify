import type { ApprovalAnswer, ApprovalRequest, ApprovalResponder } from './approval'

type Listener = (request: ApprovalRequest | null) => void
const listeners = new Set<Listener>()
let current: { request: ApprovalRequest; resolve: (answer: ApprovalAnswer) => void } | null = null

function publish(request: ApprovalRequest | null): void { for (const listener of listeners) listener(request) }

export const approvalResponder: ApprovalResponder = (request) => {
  if (listeners.size === 0) return Promise.reject(new Error('No approval UI is subscribed'))
  return new Promise<ApprovalAnswer>((resolve) => {
  if (current) current.resolve('deny')
  const onAbort = () => {
    if (current?.request.requestId !== request.requestId) return
    current = null
    publish(null)
    resolve('deny')
  }
  request.signal.addEventListener('abort', onAbort, { once: true })
  current = {
    request,
    resolve: (answer) => {
      request.signal.removeEventListener('abort', onAbort)
      if (current?.request.requestId !== request.requestId) return
      current = null
      publish(null)
      resolve(answer)
    },
  }
  publish(request)
  })
}

export function answerApproval(requestId: string, answer: ApprovalAnswer): boolean {
  if (current?.request.requestId !== requestId) return false
  current.resolve(answer)
  return true
}

export function subscribeApproval(listener: Listener): () => void {
  listeners.add(listener)
  listener(current?.request ?? null)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && current) current.resolve('deny')
  }
}
