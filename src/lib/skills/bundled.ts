import type { LoadedSkill } from './types'
import { compiledBuiltinSkills } from './generated/manifest'

const documents = import.meta.glob('./builtin/*/SKILL.md', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
const resources = import.meta.glob('./builtin/*/{reference,examples,assets}/**/*', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>

/** Load the generated bundled manifest; Vite embeds resource files for the Web fallback. */
export function loadBundledSkills(): LoadedSkill[] {
  return compiledBuiltinSkills.flatMap((compiled) => {
    const name = compiled.metadata.name
    const content = documents[`./builtin/${name}/SKILL.md`]
    if (!content) return []
    return [{
      metadata: compiled.metadata,
      content: compiled.coreInstructions,
      path: compiled.path,
      source: 'builtin' as const,
      virtualRoot: `.solidify/skills/${name}`,
      resourceFiles: {
        'SKILL.md': content,
        ...collectResources(name),
      },
    }]
  })
}

function collectResources(name: string): Record<string, string> {
  const prefix = `./builtin/${name}/`
  return Object.fromEntries(Object.entries(resources)
    .filter(([file]) => file.startsWith(prefix))
    .map(([file, content]) => [file.slice(prefix.length), content]))
}
