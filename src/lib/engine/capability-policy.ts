/**
 * Capability policy and lease resolution
 * @module lib/engine/capability-policy
 */

import type { Tool } from '../tools/types'
import type { LoadedSkill } from '../skills/types'
import type { AttachmentResource } from '../attachments/types'
import type { RunPlan, RunPhase } from './run-plan'
import type { DeliverableContract } from './deliverables/types'

export interface CapabilityPolicyContext {
  readonly plan: RunPlan
  readonly phase: RunPhase
  readonly skill?: LoadedSkill
  readonly attachments?: readonly AttachmentResource[]
  readonly closedGroups?: ReadonlySet<string>
  readonly platform?: 'web' | 'tauri'
  readonly contract?: DeliverableContract
}

export interface CapabilityLease {
  readonly phase: RunPhase
  readonly tools: readonly Tool[]
  readonly toolChoice: 'auto' | 'none'
  readonly allowedGroups: ReadonlySet<string>
  readonly fingerprint: string
}

const ATTACHMENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'search_attachments',
  'read_attachment',
  'prepare_attachment_evidence',
  'read_handle',
])

function isAttachmentRetrievalTool(tool: Tool): boolean {
  return ATTACHMENT_TOOL_NAMES.has(tool.name) || tool.loopGroup === 'attachment-retrieval'
}

function leaseFingerprint(ctx: CapabilityPolicyContext, tools: readonly Tool[], toolChoice: string): string {
  const schemas = tools
    .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
    .sort((left, right) => left.name.localeCompare(right.name))
  let hash = 0x811c9dc5
  const str = canonicalJson({
    mode: ctx.plan.mode,
    phase: ctx.phase,
    contractId: ctx.contract?.id ?? ctx.plan.contractId ?? null,
    contractVersion: ctx.contract?.version ?? null,
    toolChoice,
    schemas,
  })
  for (let i = 0; i < str.length; i++) {
    hash = Math.imul(hash ^ str.charCodeAt(i), 0x01000193)
  }
  return `lease-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function resolveCapabilityLease(
  ctx: CapabilityPolicyContext,
  allTools: readonly Tool[],
): CapabilityLease {
  const closed = ctx.closedGroups ?? new Set<string>()
  const phase = ctx.phase
  const mode = ctx.plan.mode

  // 1. Direct mode: strictly no tools
  if (mode === 'direct' || phase === 'completed' || phase === 'failed' || phase === 'exhausted') {
    return {
      phase,
      tools: [],
      toolChoice: 'none',
      allowedGroups: new Set(),
      fingerprint: leaseFingerprint(ctx, [], 'none'),
    }
  }

  // 2. Staged delivery mode: dynamic physical tool isolation
  if (mode === 'staged-delivery') {
    if (phase === 'retrieving') {
      if (closed.has('attachment-retrieval')) {
        return {
          phase,
          tools: [],
          toolChoice: 'none',
          allowedGroups: new Set(),
          fingerprint: leaseFingerprint(ctx, [], 'none'),
        }
      }
      const tools = allTools.filter((tool) => isAttachmentRetrievalTool(tool))
      const toolChoice = tools.length > 0 ? 'auto' : 'none'
      return {
        phase,
        tools,
        toolChoice,
        allowedGroups: new Set(['attachment-retrieval']),
        fingerprint: leaseFingerprint(ctx, tools, toolChoice),
      }
    }

    const declaredCapabilities = phase === 'generating'
      ? ctx.contract?.generationCapabilities ?? []
      : phase === 'repairing'
        ? ctx.contract?.repairCapabilities ?? []
        : []
    const allowedNames = new Set(declaredCapabilities)
    const tools = allTools.filter((tool) => allowedNames.has(tool.name)
      && (!tool.loopGroup || !closed.has(tool.loopGroup)))
    const toolChoice = tools.length > 0 ? 'auto' : 'none'
    const allowedGroups = new Set(tools.map((tool) => tool.loopGroup).filter((group): group is string => Boolean(group)))

    // Validation has no model call. Generation and repair receive exactly the
    // capabilities declared by the deliverable contract.
    return {
      phase,
      tools,
      toolChoice,
      allowedGroups,
      fingerprint: leaseFingerprint(ctx, tools, toolChoice),
    }
  }

  // 3. Agent mode: bounded open-ended loop
  const tools = allTools.filter((tool) => {
    if (!tool.loopGroup) return true
    return !closed.has(tool.loopGroup)
  })
  const toolChoice = tools.length > 0 ? 'auto' : 'none'
  const allowedGroups = new Set(tools.map((t) => t.loopGroup).filter((g): g is string => Boolean(g)))

  return {
    phase,
    tools,
    toolChoice,
    allowedGroups,
    fingerprint: leaseFingerprint(ctx, tools, toolChoice),
  }
}
