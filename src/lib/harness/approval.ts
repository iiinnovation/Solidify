import type { ConfirmationPrompt } from './policy'

export type ApprovalOutcome = 'allowed_once' | 'rejected' | 'cancelled' | 'unavailable'

export interface ApprovalRequest {
  requestId: string
  runId: string
  callId: string
  toolName: string
  grantKey?: string
  reason: string
  prompt: ConfirmationPrompt
  signal: AbortSignal
}

export type ApprovalAnswer = 'allow' | 'allow_always_in_run' | 'deny'
export type ApprovalResponder = (request: ApprovalRequest) => ApprovalAnswer | Promise<ApprovalAnswer>
type ApprovalRequestInput = Omit<ApprovalRequest, 'requestId'> & {
  requestId?: string
  askedAlready?: boolean
}

export interface ApprovalServiceOptions {
  respond?: ApprovalResponder
  onEvent?: (event: { type: 'approval.asked' | 'approval.decided'; request: ApprovalRequest; outcome?: ApprovalOutcome }) => void | Promise<void>
  onSessionGrant?: (request: ApprovalRequest) => void | Promise<void>
  idFactory?: () => string
}

export class ApprovalService {
  private responder?: ApprovalResponder
  private readonly pending = new Map<string, { settle: (outcome: ApprovalOutcome, addGrant?: boolean) => void; request: ApprovalRequest }>()
  private readonly sessionGrants = new Set<string>()
  private readonly onEvent?: ApprovalServiceOptions['onEvent']
  private readonly onSessionGrant?: ApprovalServiceOptions['onSessionGrant']
  private readonly idFactory: () => string

  constructor(options: ApprovalServiceOptions = {}) {
    this.responder = options.respond
    this.onEvent = options.onEvent
    this.onSessionGrant = options.onSessionGrant
    this.idFactory = options.idFactory ?? (() => `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
  }

  setResponder(responder: ApprovalResponder | undefined): void { this.responder = responder }
  hasSessionGrant(grantKey: string): boolean { return this.sessionGrants.has(grantKey) }

  answer(requestId: string, answer: ApprovalAnswer): boolean {
    const pending = this.pending.get(requestId)
    if (!pending || !['allow', 'allow_always_in_run', 'deny'].includes(answer)) return false
    pending.settle(answer === 'deny' ? 'rejected' : 'allowed_once', answer === 'allow_always_in_run')
    return true
  }

  cancelAll(): void {
    for (const pending of this.pending.values()) pending.settle('cancelled')
    this.pending.clear()
  }

  async request(input: ApprovalRequestInput): Promise<{ requestId: string; outcome: ApprovalOutcome }> {
    const { askedAlready = false, ...requestInput } = input
    const request: ApprovalRequest = { ...requestInput, requestId: input.requestId ?? this.idFactory() }
    if (!askedAlready) {
      try {
        await this.onEvent?.({ type: 'approval.asked', request })
      } catch {
        try { await this.onEvent?.({ type: 'approval.decided', request, outcome: 'unavailable' }) } catch { /* fail closed */ }
        return { requestId: request.requestId, outcome: 'unavailable' }
      }
    }
    let addSessionGrant = false
    let outcome: ApprovalOutcome
    if (request.signal.aborted) {
      outcome = 'cancelled'
    } else if (!this.responder) {
      outcome = 'unavailable'
    } else outcome = await new Promise<ApprovalOutcome>((resolve) => {
      let settled = false
      const settle = (value: ApprovalOutcome, addGrant = false) => {
        if (settled) return
        settled = true
        addSessionGrant = addGrant
        request.signal.removeEventListener('abort', onAbort)
        this.pending.delete(request.requestId)
        resolve(value)
      }
      const onAbort = () => settle('cancelled')
      this.pending.set(request.requestId, { settle, request })
      request.signal.addEventListener('abort', onAbort, { once: true })
      Promise.resolve().then(() => this.responder!(request)).then((answer) => {
        if (answer === 'allow' || answer === 'allow_always_in_run' || answer === 'deny') this.answer(request.requestId, answer)
        else settle('unavailable')
      }, () => settle('unavailable'))
    })
    try { await this.onEvent?.({ type: 'approval.decided', request, outcome }) } catch { return { requestId: request.requestId, outcome: 'unavailable' } }
    if (outcome === 'allowed_once' && addSessionGrant) {
      try {
        await this.onSessionGrant?.(request)
        this.sessionGrants.add(request.grantKey ?? request.toolName)
      } catch { /* current call remains allowed once, broader grant is withheld */ }
    }
    return { requestId: request.requestId, outcome }
  }
}
