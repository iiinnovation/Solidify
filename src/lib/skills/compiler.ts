import type { LoadedSkill, SkillMetadata } from './types'

export interface CompiledSkill {
  metadata: SkillMetadata
  coreInstructions: string
  referenceRoutes: string[]
  allowedTools: string[]
  fingerprint: string
  estimatedTokens: number
  /** Stable source path used by diagnostics and generated manifests. */
  path: string
}

/** Compile the stable Skill surface once so runtime requests need no markdown scan. */
export function compileSkill(skill: LoadedSkill): CompiledSkill {
  const coreInstructions = skill.content.trim()
  const referenceRoutes = [...new Set([
    ...coreInstructions.matchAll(/(?:`|\()((?:reference|examples|assets)\/[^`\s)]+)(?:`|\))/g),
  ].map((match) => match[1]).filter((path): path is string => typeof path === 'string' && !/[<>]/.test(path)))]
  const allowedTools = [...(skill.metadata.allowedTools ?? [])]
  const fingerprint = stableFingerprint(`${skill.metadata.name}\0${skill.metadata.version}\0${coreInstructions}\0${allowedTools.join(',')}`)
  return {
    metadata: { ...skill.metadata },
    coreInstructions,
    referenceRoutes,
    allowedTools,
    fingerprint,
    estimatedTokens: estimateTokens(coreInstructions),
    path: skill.path,
  }
}

export function compileSkillIndex(skills: readonly LoadedSkill[]): CompiledSkill[] {
  return [...skills].sort((left, right) => left.metadata.name.localeCompare(right.metadata.name)).map(compileSkill)
}

function estimateTokens(text: string): number {
  let cjk = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) cjk++
  }
  return Math.ceil(cjk + ([...text].length - cjk) / 4)
}

function stableFingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193)
  return `skill-${(hash >>> 0).toString(16).padStart(8, '0')}`
}
