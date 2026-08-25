/**
 * RunPlan definition and resolution
 * @module lib/engine/run-plan
 */

import type { QueryContext } from './types'

export type RunMode =
  | 'direct'
  | 'agent'
  | 'staged-delivery'

export type RunPhase =
  | 'preparing'
  | 'retrieving'
  | 'generating'
  | 'validating'
  | 'repairing'
  | 'completed'
  | 'failed'
  | 'exhausted'

export interface RunPlan {
  readonly mode: RunMode
  readonly initialPhase: RunPhase
  readonly contractId?: string
  readonly attachmentMode: 'none' | 'inline' | 'retrieval'
  readonly maxRepairAttempts: number
  readonly reason: string
}

export interface RunPlanContractResolver {
  get(id: string): { readonly maxRepairAttempts: number }
  has?(id: string): boolean
}

export function createRunPlan(
  ctx: QueryContext,
  contracts?: RunPlanContractResolver,
  stagedRuntimeEnabled = true,
): RunPlan {
  const hasAttachments = Boolean(ctx.attachments && ctx.attachments.length > 0)
  const hasReadableAttachments = Boolean(ctx.attachments?.some((attachment) => attachment.text?.trim()))
  const attachmentMode: 'none' | 'inline' | 'retrieval' = !hasAttachments
    ? 'none'
    : (ctx.attachmentMode === 'inline' || !hasReadableAttachments ? 'inline' : 'retrieval')

  const contractId = ctx.skill?.metadata.deliverableContract

  // Skills opt into deterministic delivery through contract metadata. The
  // Runtime never needs to recognize a concrete Skill or artifact format.
  if (contractId && stagedRuntimeEnabled) {
    const isRetrieval = attachmentMode === 'retrieval'
    return {
      mode: 'staged-delivery',
      initialPhase: isRetrieval ? 'retrieving' : 'generating',
      contractId,
      attachmentMode,
      maxRepairAttempts: contracts && (contracts.has?.(contractId) ?? true)
        ? contracts.get(contractId).maxRepairAttempts
        : 0,
      reason: isRetrieval ? 'structured_delivery_with_retrieval' : 'structured_delivery_generation',
    }
  }

  // Direct chat if no tools are available or required
  const hasTools = ctx.tools.length > 0
  if (!hasTools && !ctx.skill && attachmentMode !== 'retrieval') {
    return {
      mode: 'direct',
      initialPhase: 'generating',
      attachmentMode,
      maxRepairAttempts: 0,
      reason: 'direct_no_tools',
    }
  }

  // Open-ended agent execution
  const isRetrieval = attachmentMode === 'retrieval'
  return {
    mode: 'agent',
    initialPhase: isRetrieval ? 'retrieving' : 'generating',
    attachmentMode,
    maxRepairAttempts: 0,
    reason: isRetrieval ? 'agent_with_retrieval' : 'agent_open_ended',
  }
}
