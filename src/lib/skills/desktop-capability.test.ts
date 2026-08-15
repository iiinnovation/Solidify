import { describe, expect, it } from 'vitest'
import capability from '../../../src-tauri/capabilities/default.json'

describe('desktop Skill filesystem capability', () => {
  it('grants only the user Skill root the commands needed for package management', () => {
    const permissions = capability.permissions.filter((item): item is { identifier: string; allow: Array<{ path: string }> } => typeof item === 'object')
    const identifiers = new Set(permissions.map((item) => item.identifier))

    expect([...identifiers]).toEqual(expect.arrayContaining([
      'fs:allow-read-dir',
      'fs:allow-read-text-file',
      'fs:allow-read-file',
      'fs:allow-mkdir',
      'fs:allow-write-text-file',
      'fs:allow-write-file',
      'fs:allow-remove',
      'fs:allow-rename',
      'fs:allow-exists',
    ]))
    for (const permission of permissions) {
      expect(permission.allow.every(({ path }) => path === '$HOME/.solidify/skills' || path === '$HOME/.solidify/skills/**')).toBe(true)
    }
  })
})
