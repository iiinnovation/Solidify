import type { LoadedSkill } from '../skills/types'
import type { Tool } from '../tools/types'
import { toolRegistry } from '../tools'
import type { QueryContext } from './types'
import { enablePptdPipeline } from './pptd-context'

export interface ActivatedSkillRuntime {
  readonly skill: LoadedSkill
  readonly skillResources: QueryContext['skillResources']
  readonly tools: readonly Tool[]
}

/**
 * Resolve the capability surface for a newly activated Skill.
 *
 * Concrete delivery pipelines belong to this Skill integration boundary, not
 * to the generic Agent loop. Runtime-only caller tools are preserved when
 * they are not part of the global registry.
 */
export async function activateSkillRuntime(
  ctx: QueryContext,
  currentTools: readonly Tool[],
  skill: LoadedSkill,
): Promise<ActivatedSkillRuntime> {
  const skillResources = await ctx.skillRegistry?.resources?.(skill.metadata.name)
  const resolved = toolRegistry.resolve({
    platform: ctx.platform ?? 'web',
    skillAllowedTools: skill.metadata.allowedTools,
    skillActive: true,
    skillResourceAccess: Boolean(skillResources),
    hasAttachments: Boolean(ctx.attachments?.length),
    userDisabledTools: ctx.settings?.disabledTools ?? [],
    isOnline: typeof navigator === 'undefined' || navigator.onLine,
  }).filter((tool) => tool.name !== 'activate_skill'
    && (!isAttachmentReader(tool.name) || Boolean(ctx.attachments?.length)))

  const resolvedNames = new Set(resolved.map((tool) => tool.name))
  const runtimeTools = currentTools.filter((tool) => !toolRegistry.get(tool.name) && !resolvedNames.has(tool.name))
  const activated = enablePptdPipeline({
    ...ctx,
    skill,
    skillResources,
    tools: [...resolved, ...runtimeTools],
  })
  return { skill, skillResources, tools: activated.tools }
}

function isAttachmentReader(name: string): boolean {
  return name === 'search_attachments'
    || name === 'read_attachment'
    || name === 'prepare_attachment_evidence'
}
