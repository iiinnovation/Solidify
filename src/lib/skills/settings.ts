import { isLegacySkillRuntimeRetired } from './migration'

const STORAGE_KEY = 'solidify-disabled-skills'
const AUTO_ROUTE_KEY = 'solidify-skill-auto-route'

export function getDisabledSkillNames(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

export function isSkillEnabled(name: string): boolean {
  return !getDisabledSkillNames().has(name)
}

export function setSkillEnabled(name: string, enabled: boolean): void {
  if (typeof localStorage === 'undefined') return
  const disabled = getDisabledSkillNames()
  if (enabled) disabled.delete(name)
  else disabled.add(name)
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...disabled].sort()))
}

/**
 * Whether a send with no Skill picked in the composer may classify the message
 * and activate a Skill automatically. It is opt-in during the migration window:
 * the main Agent can answer without paying a hidden classification call, while
 * existing deployments may explicitly enable the rollback path.
 */
export function isSkillAutoRouteEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  if (isLegacySkillRuntimeRetired()) return false
  return localStorage.getItem(AUTO_ROUTE_KEY) === 'true'
}

export function setSkillAutoRouteEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return
  if (isLegacySkillRuntimeRetired()) return
  if (enabled) localStorage.setItem(AUTO_ROUTE_KEY, 'true')
  else localStorage.removeItem(AUTO_ROUTE_KEY)
}
