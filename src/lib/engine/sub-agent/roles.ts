import type { SubAgentSpec } from './types'

export interface SubAgentRoleDefinition {
  role: string
  description: string
  systemPrompt: string
  allowedTools: string[]
}

export const SUB_AGENT_ROLES: Readonly<Record<string, SubAgentRoleDefinition>> = Object.freeze({
  researcher: {
    role: 'researcher',
    description: '从材料中提取事实、主题和证据。',
    systemPrompt: 'Prioritize source-grounded facts. Mark unknowns explicitly and do not invent missing details.',
    allowedTools: ['list_dir', 'read_file', 'search_files', 'read_handle'],
  },
  fact_checker: {
    role: 'fact_checker',
    description: '核对事实、发现矛盾并标注风险。',
    systemPrompt: 'Check claims against available source material. Report contradictions and confidence, not unsupported conclusions.',
    allowedTools: ['list_dir', 'read_file', 'search_files', 'read_handle'],
  },
  analyst: {
    role: 'analyst',
    description: '将材料归纳为结构化结论和决策项。',
    systemPrompt: 'Produce a structured analysis with evidence, implications, and unresolved questions.',
    allowedTools: ['list_dir', 'read_file', 'search_files', 'read_handle'],
  },
  formatter: {
    role: 'formatter',
    description: '把独立结果整理成统一的交付格式。',
    systemPrompt: 'Preserve source meaning while producing concise, consistent, machine-readable output.',
    allowedTools: ['read_file', 'read_handle'],
  },
})

export function resolveSubAgentRole(role: string): SubAgentRoleDefinition | undefined {
  const key = role.trim().toLowerCase()
  return Object.hasOwn(SUB_AGENT_ROLES, key) ? SUB_AGENT_ROLES[key] : undefined
}

export function applyRoleDefaults(spec: SubAgentSpec): SubAgentSpec {
  const preset = resolveSubAgentRole(spec.role)
  if (!preset) return spec
  return {
    ...spec,
    role: preset.role,
    systemPrompt: [preset.systemPrompt, spec.systemPrompt].filter(Boolean).join('\n'),
    allowedTools: spec.allowedTools ?? preset.allowedTools,
  }
}
