import type { LoadedSkill } from './types'
import { parseSkillDocument } from './parse'
import { builtinSkills } from '@/lib/skills'

const documents = import.meta.glob('./builtin/*/SKILL.md', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
const resources = import.meta.glob('./builtin/*/{reference,examples,assets}/**/*', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>

/** Parse bundled directories once; Vite embeds these for the Web fallback. */
export function loadBundledSkills(): LoadedSkill[] {
  return Object.entries(documents).flatMap(([file, content]) => {
    const match = file.match(/^\.\/builtin\/([^/]+)\/SKILL\.md$/)
    if (!match) return []
    const name = match[1]
    try {
      const skill = parseSkillDocument(content, `builtin://${name}/SKILL.md`, 'builtin')
      const legacyGuidance = builtinSkills.find((item) => item.id === name)?.systemPrompt
      return [{
        ...skill,
        resourceFiles: {
          'SKILL.md': content,
          ...(legacyGuidance ? { 'reference/legacy-guidance.md': legacyGuidance } : {}),
          ...collectResources(name),
        },
      }]
    } catch (error) {
      console.error(`[skills] Invalid bundled Skill ${name}:`, error)
      return []
    }
  })
}

function collectResources(name: string): Record<string, string> {
  const prefix = `./builtin/${name}/`
  return Object.fromEntries(Object.entries(resources)
    .filter(([file]) => file.startsWith(prefix))
    .map(([file, content]) => [file.slice(prefix.length), content]))
}
