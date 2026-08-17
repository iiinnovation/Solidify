import { createGeneratePptdTool } from '../tools/builtin/generate-pptd'
import type { Tool } from '../tools/types'
import type { QueryContext } from './types'

const LEGACY_PRESENTATION_OVERRIDE = `

## Solidify PPTD compatibility override

The legacy slides JSON format is retired. Do not read legacy-format.md, handwrite a slides JSON artifact, or call write_file for the final deck. Collect the user's brief and materials, then call generate_pptd exactly once. The tool owns page generation, validation, bounded repair, and the final slides artifact.`

const WORKSPACE_READ_TOOLS = new Set(['read_file', 'list_dir', 'search_files'])
const INITIAL_PPTD_BLOCKED_TOOLS = new Set(['capture_preview'])

/** Attach the PPTD pipeline for the canonical Skill and its legacy alias. */
export function enablePptdPipeline(base: QueryContext): QueryContext {
  const skillName = base.skill?.metadata.name
  const legacyPresentation = skillName === 'presentation'
  if (skillName !== 'pptd-deck' && !legacyPresentation) return base

  // The chat artifact is materialized only after generate_pptd returns and the
  // run completes. capture_preview therefore cannot succeed in this model turn.
  // Enforce that lifecycle structurally, including for stale workspace Skills.
  const allowedTools = base.skill?.metadata.allowedTools?.filter((name) => !INITIAL_PPTD_BLOCKED_TOOLS.has(name))
  const tools = base.tools.filter((candidate) =>
    !INITIAL_PPTD_BLOCKED_TOOLS.has(candidate.name)
    && (base.workspace || !WORKSPACE_READ_TOOLS.has(candidate.name)),
  )
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
  // Old workspace presentation v2.1 Skills predate generate_pptd and cannot
  // declare it. Treat that reserved Skill name as a migration alias.
  if (!legacyPresentation && !sanitized.skill?.metadata.allowedTools?.includes('generate_pptd')) return sanitized
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
    ...(legacyPresentation && sanitized.skill ? {
      skill: {
        ...sanitized.skill,
        metadata: {
          ...sanitized.skill.metadata,
          allowedTools: [...new Set([...(sanitized.skill.metadata.allowedTools ?? []), 'generate_pptd'])],
        },
        content: sanitized.skill.content.includes('Solidify PPTD compatibility override')
          ? sanitized.skill.content
          : `${sanitized.skill.content}${LEGACY_PRESENTATION_OVERRIDE}`,
      },
    } : {}),
    // Chat attachments are already present in the conversation. Without a
    // selected workspace these tools can only read bundled Skill resources,
    // so exposing them invites futile attempts to open attachment filenames.
    tools: [...sanitized.tools, tool],
  }
  holder.current = context
  return context
}
