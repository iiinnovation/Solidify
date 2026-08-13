/**
 * Skill system types
 * @see docs/specs/skill-format.md
 */

export interface SkillMetadata {
  name: string
  version: string
  description: string
  author?: string
  allowedTools?: string[]
  tags?: string[]
}

export interface LoadedSkill {
  metadata: SkillMetadata
  content: string
  path: string
}

export interface SkillRegistry {
  load(path: string): Promise<LoadedSkill>
  list(): Promise<SkillMetadata[]>
  resolve(name: string): Promise<LoadedSkill | null>
}
