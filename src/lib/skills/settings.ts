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
 * and activate a Skill automatically. On by default: the layer-0 Skill index is
 * useless without something that can act on it. Opting out restores manual-only
 * selection for users who would rather not pay the extra classification call.
 */
export function isSkillAutoRouteEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true
  return localStorage.getItem(AUTO_ROUTE_KEY) !== 'false'
}

export function setSkillAutoRouteEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return
  if (enabled) localStorage.removeItem(AUTO_ROUTE_KEY)
  else localStorage.setItem(AUTO_ROUTE_KEY, 'false')
}
