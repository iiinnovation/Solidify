import { isSkillEnabled } from '@/lib/skills/settings'
import type { SkillRegistryApi } from '@/lib/skills/types'
import { failure, success } from './helpers'
import type { Tool } from '../types'

interface ActivateSkillInput { skillName: string }

export interface ActivateSkillResult { skillName: string }

/** Runtime-only activation; the query loop applies the registry result safely. */
export const activateSkillTool: Tool<ActivateSkillInput, ActivateSkillResult> = {
  name: 'activate_skill',
  description: 'Activate one trusted Skill only when the user explicitly asks for that Skill\'s specialized deliverable or workflow. Do not activate for definitions, explanations, discussions, comparisons, or topic-only questions; answer those directly.',
  inputSchema: {
    type: 'object',
    properties: { skillName: { type: 'string', minLength: 1, maxLength: 100 } },
    required: ['skillName'],
    additionalProperties: false,
  },
  readOnly: true,
  concurrencySafe: false,
  destructive: false,
  requiresConfirmation: false,
  availability: 'always',
  permissions: [],
  async execute(input, ctx) {
    const registry = ctx.skillRegistry as SkillRegistryApi | undefined
    if (!registry) return failure<ActivateSkillResult>('runtime', '当前运行没有可用的 Skill 注册表，不能激活 Skill。', false)
    if (!isSkillEnabled(input.skillName)) return failure<ActivateSkillResult>('permission_denied', `Skill ${input.skillName} 已被用户禁用。`, false)
    const skill = await registry.resolve(input.skillName)
    if (!skill) return failure<ActivateSkillResult>('not_found', `不存在可激活的 Skill：${input.skillName}。`, true)
    return success(`已准备激活 Skill：${skill.metadata.displayName ?? skill.metadata.name}。下一轮将应用其工作流和工具白名单。`, { skillName: skill.metadata.name })
  },
  renderCall: (input) => `激活 Skill ${input.skillName}`,
}
