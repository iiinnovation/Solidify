import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const registry = await readFile(resolve(root, 'src/lib/skills/registry.ts'), 'utf8')
const manifest = await readFile(resolve(root, 'src/lib/skills/generated/manifest.ts'), 'utf8')
const budgetGate = await readFile(resolve(root, 'src/lib/engine/context-budget-gate.ts'), 'utf8')
const indexBudget = Number(registry.match(/DEFAULT_INDEX_TOKEN_BUDGET\s*=\s*(\d+)/)?.[1] ?? NaN)
const readBudget = (name) => {
  const raw = budgetGate.match(new RegExp(`${name}:\\s*([\\d_]+)`))?.[1]
  return raw ? Number(raw.replaceAll('_', '')) : NaN
}
const fixedSystemBudget = readBudget('fixedSystemTokens')
const systemBudget = readBudget('systemTokens')
const eagerSkillBudget = readBudget('eagerSkillTokens')
const manifestSkills = [...manifest.matchAll(/"estimatedTokens":\s*(\d+)/g)].map((match) => Number(match[1]))
const failures = []
if (!Number.isFinite(indexBudget) || indexBudget > 600) failures.push(`Skill metadata index hard limit must be <= 600 (got ${indexBudget})`)
if (!Number.isFinite(fixedSystemBudget) || fixedSystemBudget > 800) failures.push(`Fixed system prompt budget must be <= 800 tokens (got ${fixedSystemBudget})`)
if (!Number.isFinite(systemBudget) || !Number.isFinite(eagerSkillBudget) || systemBudget < fixedSystemBudget + eagerSkillBudget) {
  failures.push(`Total system prompt budget must cover fixed + eager Skill budgets (got ${systemBudget}, fixed ${fixedSystemBudget}, Skill ${eagerSkillBudget})`)
}
if (manifestSkills.length === 0) failures.push('Generated Skill manifest is empty')
for (const [index, tokens] of manifestSkills.entries()) {
  if (tokens > 2_000) failures.push(`Compiled Skill ${index} exceeds the eager 2,000-token core budget (${tokens})`)
}
if (/time=\$\{new Date\(\)\.toISOString\(\)\}/.test(await readFile(resolve(root, 'src/lib/harness/builtin-hooks.ts'), 'utf8'))) {
  failures.push('Dynamic timestamp remains in the cacheable environment prompt')
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log(JSON.stringify({ version: 'm4r-14.3', metadataIndexHardLimit: indexBudget, systemBudget, fixedSystemBudget, compiledSkills: manifestSkills.length, maxEagerSkillTokens: Math.max(...manifestSkills), status: 'pass' }, null, 2))
}
