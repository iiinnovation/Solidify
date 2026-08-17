import { createGeneratePptdTool } from '../tools/builtin/generate-pptd'
import type { Tool } from '../tools/types'
import type { QueryContext } from './types'
import { SharedTaskTreeBudget } from './sub-agent/budget'

const LEGACY_PRESENTATION_OVERRIDE = `

## Solidify PPTD compatibility override

The legacy slides JSON format is retired. Do not read legacy-format.md, handwrite a slides JSON artifact, or call write_file for the final deck. Collect the user's brief and materials, then call generate_pptd exactly once. The tool owns page generation, validation, bounded repair, and the final slides artifact.`

const WORKSPACE_READ_TOOLS = new Set(['read_file', 'list_dir', 'search_files'])

/** Attach the PPTD pipeline for the canonical Skill and its legacy alias. */
export function enablePptdPipeline(base: QueryContext): QueryContext {
  const skillName = base.skill?.metadata.name
  const legacyPresentation = skillName === 'presentation'
  if (skillName !== 'pptd-deck' && !legacyPresentation) return base
  // Old workspace presentation v2.1 Skills predate generate_pptd and cannot
  // declare it. Treat that reserved Skill name as a migration alias.
  if (!legacyPresentation && !base.skill?.metadata.allowedTools?.includes('generate_pptd')) return base
  if (base.settings?.disabledTools.includes('generate_pptd')) return base
  if (typeof navigator !== 'undefined' && !navigator.onLine) return base
  if (base.tools.some((tool) => tool.name === 'generate_pptd')) return base

  const budget = base.taskTree?.budget ?? new SharedTaskTreeBudget(base.limits.maxTokens, base.signal)
  const holder: { current?: QueryContext } = {}
  const tool = createGeneratePptdTool(() => {
    if (!holder.current) throw new Error('PPTD pipeline context is not initialized')
    return holder.current
  }) as Tool
  const context: QueryContext = {
    ...base,
    ...(legacyPresentation && base.skill ? {
      skill: {
        ...base.skill,
        metadata: {
          ...base.skill.metadata,
          allowedTools: [...new Set([...(base.skill.metadata.allowedTools ?? []), 'generate_pptd'])],
        },
        content: base.skill.content.includes('Solidify PPTD compatibility override')
          ? base.skill.content
          : `${base.skill.content}${LEGACY_PRESENTATION_OVERRIDE}`,
      },
    } : {}),
    ...(!base.taskTree ? {
      signal: budget.signal,
      taskTree: { rootRunId: base.runId, depth: 0 as const, budget },
    } : {}),
    // Chat attachments are already present in the conversation. Without a
    // selected workspace these tools can only read bundled Skill resources,
    // so exposing them invites futile attempts to open attachment filenames.
    tools: [
      ...base.tools.filter((candidate) => base.workspace || !WORKSPACE_READ_TOOLS.has(candidate.name)),
      tool,
    ],
  }
  holder.current = context
  return context
}
