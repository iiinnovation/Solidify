import { createGeneratePptdTool } from '../tools/builtin/generate-pptd'
import type { Tool } from '../tools/types'
import type { QueryContext } from './types'

const WORKSPACE_READ_TOOLS = new Set(['read_file', 'list_dir', 'search_files'])
const INITIAL_PPTD_BLOCKED_TOOLS = new Set(['capture_preview'])
// PPTD receives selected attachment text through generate_pptd's attachmentIds
// contract. Exposing the generic attachment readers here causes the model to
// spend several turns searching/reading the same document before it can start
// the deck pipeline, which is both slower and more expensive. Keep these tools
// out of the PPTD turn; a standalone chat can still inspect excerpts on demand.
const PPTD_ATTACHMENT_TOOLS = new Set(['search_attachments', 'read_attachment', 'prepare_attachment_evidence'])

/** Attach the PPTD pipeline for the canonical Skill. */
export function enablePptdPipeline(base: QueryContext): QueryContext {
  const skillName = base.skill?.metadata.name
  if (skillName !== 'pptd-deck') return base

  // The chat artifact is materialized only after generate_pptd returns and the
  // run completes. capture_preview therefore cannot succeed in this model turn.
  // Enforce that lifecycle structurally, including for stale workspace Skills.
  const allowedTools = base.skill?.metadata.allowedTools?.filter((name) =>
    !INITIAL_PPTD_BLOCKED_TOOLS.has(name) && !PPTD_ATTACHMENT_TOOLS.has(name),
  )
  const tools = base.tools.filter((candidate) => {
    if (INITIAL_PPTD_BLOCKED_TOOLS.has(candidate.name) || PPTD_ATTACHMENT_TOOLS.has(candidate.name)) return false
    // A bundled Skill can expose read_file without a selected workspace. Keep
    // that narrow virtual-resource capability, but continue hiding tools that
    // would access the user's filesystem outside an explicit workspace.
    if (candidate.name === 'read_file' && base.skillResources) return true
    return Boolean(base.workspace) || !WORKSPACE_READ_TOOLS.has(candidate.name)
  })
  const sanitized: QueryContext = tools.length === base.tools.length
    && allowedTools?.length === base.skill?.metadata.allowedTools?.length
    ? base
    : {
        ...base,
        tools,
        ...(base.skill ? {
          skill: {
            ...base.skill,
            metadata: { ...base.skill.metadata, allowedTools },
          },
        } : {}),
      }
  if (!sanitized.skill?.metadata.allowedTools?.includes('generate_pptd')) return sanitized
  if (sanitized.settings?.disabledTools.includes('generate_pptd')) return sanitized
  if (typeof navigator !== 'undefined' && !navigator.onLine) return sanitized
  if (sanitized.tools.some((tool) => tool.name === 'generate_pptd')) return sanitized

  const holder: { current?: QueryContext } = {}
  const tool = createGeneratePptdTool(() => {
    if (!holder.current) throw new Error('PPTD pipeline context is not initialized')
    return holder.current
  }) as Tool
  const context: QueryContext = {
    ...sanitized,
    // The generated tool closes over the run's selected attachment resources;
    // attachmentIds refer to that bounded manifest, never to filesystem paths.
    tools: [...sanitized.tools, tool],
  }
  holder.current = context
  return context
}
