const STORAGE_KEY = 'solidify-disabled-skills'

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
