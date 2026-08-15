/**
 * Skill system types
 * @see docs/specs/skill-format.md
 */

export interface SkillMetadata {
  name: string
  version: string
  description: string
  displayName?: string
  icon?: string
  placeholder?: string
  skipConfirmation?: boolean
  author?: string
  allowedTools?: string[]
  recommendedModels?: string[]
  tags?: string[]
  stage?: string
  source?: SkillSource
  directory?: string
}

export type SkillSource = 'project' | 'user' | 'builtin'

export interface LoadedSkill {
  metadata: SkillMetadata
  content: string
  path: string
  source?: SkillSource
  /** Stable model-visible path, independent of the real source directory. */
  virtualRoot?: string
  /** Embedded reference/examples/assets for built-in Web fallback. */
  resourceFiles?: Record<string, string>
}

export interface SkillRegistryApi {
  load(path: string): Promise<LoadedSkill>
  list(): Promise<SkillMetadata[]>
  resolve(name: string): Promise<LoadedSkill | null>
}

export interface SkillLoadError {
  path: string
  message: string
}

export interface SkillLoadResult {
  skills: LoadedSkill[]
  errors: SkillLoadError[]
}

export interface SkillResourceRead {
  content: string
  bytes: number
  truncated: boolean
}

/** Read-only access to resources belonging to the selected Skill only. */
export interface SkillResourceResolver {
  virtualRoot: string
  canRead(path: string): boolean
  read(path: string, offset?: number, limit?: number): Promise<SkillResourceRead>
}
