/**
 * Deterministic control flow for contract-backed deliverables.
 *
 * The bounded Agent loop owns provider/tool transport. This controller owns
 * only staged-delivery decisions: retrieval closure, tool isolation hints,
 * local validation and bounded repair. It is artifact-agnostic; concrete
 * formats live behind DeliverableContract.
 *
 * @module lib/engine/staged-delivery
 */

import type { Message, QueryContext, QueryEvent, RunError } from './types'
import type { RunPlan, RunPhase } from './run-plan'
import type { PhaseController } from './phase-controller'
import type { DeliverableContract } from './deliverables/types'
import type { HarnessRuntime } from '../harness/builtin-hooks'
import type { ToolCall, ToolResult } from '../tools/types'
import type { SimpleRunLogger } from './logger'
import { runBoundedLoop } from './loop-runtime'

export const STAGED_GENERATION_ONLY_CONTEXT = [
  'Evidence is already present in the conversation and all tools are intentionally unavailable.',
  'Do not emit any tool call, including tools mentioned in earlier turns.',
  'Use the evidence already present in the conversation and immediately return the deliverable.',
].join(' ')

export interface StagedDeliveryPorts {
  readonly transition: (next: RunPhase, reason: string) => void
  readonly closeRetrieval: () => void
  readonly harness?: HarnessRuntime
  readonly logger: SimpleRunLogger
}

export type StagedDeliveryFactory = (
  plan: RunPlan,
  phase: PhaseController,
  contract: DeliverableContract,
  ports: StagedDeliveryPorts,
) => StagedDeliveryController

export interface StagedModelPolicy {
  readonly emitText: false
  readonly temperatureCeiling?: number
  readonly extraHarnessContext: readonly string[]
  readonly recoverTextToolCalls: boolean
}

export type StagedNoToolDecision =
  | { kind: 'continue_generation'; messages: Message[] }
  | { kind: 'repair'; messages: Message[]; event: QueryEvent }
  | { kind: 'complete'; text: string }
  | { kind: 'failed'; error: RunError }

/**
 * One controller instance is tied to one RunPlan/PhaseController pair. Skill
 * activation or snapshot restoration creates a new instance rather than
 * carrying stale contract or phase state across plans.
 */
export class StagedDeliveryController {
  readonly plan: RunPlan

  private readonly phase: PhaseController
  private readonly contract: DeliverableContract
  private readonly ports: StagedDeliveryPorts

  constructor(
    plan: RunPlan,
    phase: PhaseController,
    contract: DeliverableContract,
    ports: StagedDeliveryPorts,
  ) {
    if (plan.mode !== 'staged-delivery' || !plan.contractId) {
      throw new Error('StagedDeliveryController requires a staged-delivery plan with a contract')
    }
    this.plan = plan
    this.phase = phase
    this.contract = contract
    this.ports = ports
  }

  /** Closed retrieval capabilities are monotonic and force generation. */
  prepareTurn(): void {
    if (this.phase.phase === 'retrieving' && this.phase.closedGroups.has('attachment-retrieval')) {
      this.ports.transition('generating', 'retrieval_group_closed')
    }
  }

  /** A retrieval phase with no leased readers cannot make progress; generate. */
  advancePastEmptyRetrievalLease(toolCount: number): boolean {
    if (this.phase.phase !== 'retrieving' || toolCount > 0) return false
    this.phase.markEvidenceComplete()
    this.ports.closeRetrieval()
    this.ports.transition('generating', 'retrieval_has_no_capabilities')
    return true
  }

  modelPolicy(): StagedModelPolicy {
    const generationStage = this.phase.phase === 'generating' || this.phase.phase === 'repairing'
    return {
      emitText: false,
      temperatureCeiling: generationStage ? 0.2 : undefined,
      extraHarnessContext: generationStage ? [STAGED_GENERATION_ONLY_CONTEXT] : [],
      recoverTextToolCalls: this.phase.phase === 'retrieving',
    }
  }

  /** Compact recovery must never reopen retrieval on its retry turn. */
  recoverFromReasoningExhaustion(): void {
    this.ports.closeRetrieval()
    if (this.phase.phase === 'retrieving') {
      this.ports.transition('generating', 'reasoning_recovery_generation')
    }
  }

  /**
   * Interpret a model turn without tool calls. Retrieval stopping is an
   * evidence-complete signal; generation is validated locally before any text
   * becomes visible to the UI.
   */
  handleNoToolResponse(input: {
    readonly text: string
    readonly messages: readonly Message[]
    readonly turn: number
    readonly maxTurns: number
  }): StagedNoToolDecision {
    if (this.phase.phase === 'retrieving') {
      this.phase.markEvidenceComplete()
      this.ports.closeRetrieval()
      this.ports.transition('generating', 'retrieval_model_stopped_tools')
      this.ports.logger.log('retrieval.completed', { turn: input.turn, reason: 'model_stopped_tools' })
      return { kind: 'continue_generation', messages: [...input.messages] }
    }

    this.ports.transition('validating', 'delivery_generated')
    const validation = this.contract.validate(input.text)
    if (validation.valid) {
      this.ports.harness?.ledger.append('deliverable.validated', {
        contractId: this.contract.id,
        version: this.contract.version,
      })
      this.ports.transition('completed', 'delivery_validated')
      return { kind: 'complete', text: input.text }
    }

    this.ports.harness?.ledger.append('artifact.parse_failed', {
      artifactId: null,
      kind: `${this.contract.id}_delivery`,
      issues: validation.issues,
      textLength: input.text.length,
    })

    if (this.phase.repairAttempts < this.plan.maxRepairAttempts && input.turn < input.maxTurns) {
      this.phase.incrementRepair()
      this.ports.transition('repairing', 'invalid_delivery')
      this.ports.harness?.ledger.append('deliverable.repairing', {
        contractId: this.contract.id,
        version: this.contract.version,
        attempt: this.phase.repairAttempts,
      })
      const detail = validation.issues.map((issue) => issue.message).join('; ')
      this.ports.harness?.ledger.append('model.retrying', {
        turn: input.turn,
        reason: 'invalid_delivery',
        detail,
        strategy: 'contract_repair',
      })
      this.ports.logger.warn('model.retrying', {
        reason: 'invalid_delivery',
        detail,
        strategy: 'contract_repair',
      })
      this.ports.closeRetrieval()
      const repairMessages = this.contract.buildRepairMessages({
        originalTask: input.messages[0],
        invalidOutput: input.text,
        issues: validation.issues,
        attempt: this.phase.repairAttempts,
      })
      return {
        kind: 'repair',
        messages: [...input.messages, ...repairMessages],
        event: {
          type: 'run.phase',
          phase: 'repairing',
          detail: `正在修复 ${this.contract.id} 交付格式`,
        },
      }
    }

    const issueSummary = validation.issues.map((issue) => issue.message).join('；')
    const error: RunError = {
      kind: 'internal',
      message: `模型未生成有效的 ${this.contract.displayName} 交付物：${issueSummary}`,
    }
    this.ports.transition('failed', 'delivery_validation_failed')
    return { kind: 'failed', error }
  }

  /** A complete evidence-pack result closes retrieval without another model turn. */
  observeToolResults(
    calls: readonly ToolCall[],
    results: readonly (ToolResult & { callId: string })[],
    turn: number,
  ): void {
    if (this.phase.phase !== 'retrieving') return
    const completeEvidencePack = results.some((result) => {
      if (!result.success) return false
      const call = calls.find((candidate) => candidate.id === result.callId)
      if (call?.name !== 'prepare_attachment_evidence') return false
      return Boolean(
        result.data
        && typeof result.data === 'object'
        && !Array.isArray(result.data)
        && (result.data as { truncated?: unknown }).truncated === false,
      )
    })
    if (!completeEvidencePack) return

    this.phase.markEvidenceComplete()
    this.ports.closeRetrieval()
    this.ports.transition('generating', 'complete_evidence_pack')
    this.ports.logger.log('retrieval.completed', { turn, reason: 'complete_evidence_pack' })
  }
}

export function createStagedDeliveryController(
  plan: RunPlan,
  phase: PhaseController,
  contract: DeliverableContract,
  ports: StagedDeliveryPorts,
): StagedDeliveryController {
  return new StagedDeliveryController(plan, phase, contract, ports)
}

/** Fixed-workflow entry selected by query.ts for an initial staged plan. */
export async function* runStagedDelivery(
  ctx: QueryContext,
  plan: RunPlan,
): AsyncGenerator<QueryEvent> {
  yield* runBoundedLoop(ctx, plan, createStagedDeliveryController)
}
