import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const refsRoot = resolve(repositoryRoot, '../Solidify-refs/open-kimi-ppt/skills/open-kimi-ppt')
const skillRoot = resolve(repositoryRoot, 'src/lib/skills/builtin/pptd-deck')
const checkOnly = process.argv.includes('--check')

const mappings = [
  ['reference/pptd.md', 'reference/pptd.md'],
  ['reference/fonts.md', 'reference/fonts.md'],
  ['reference/shapes.md', 'reference/shapes.md'],
  ['reference/general-poster.md', 'reference/general-poster.md'],
]

for (const file of await filesUnder(resolve(refsRoot, 'reference/slides_categories'))) {
  const name = relative(resolve(refsRoot, 'reference/slides_categories'), file)
  mappings.push([`reference/slides_categories/${name}`, `reference/slide-categories/${name}`])
}
for (const file of await filesUnder(resolve(refsRoot, 'reference/design_system'))) {
  if (file.split(/[\\/]/).at(-1) !== 'design.md') continue
  const name = relative(resolve(refsRoot, 'reference/design_system'), file)
  mappings.push([`reference/design_system/${name}`, `reference/design-system/${name}`])
}

const expectedManagedPaths = new Set(mappings.map(([, destinationPath]) => destinationPath))
let drift = false
for (const managedRoot of ['reference/slide-categories', 'reference/design-system']) {
  for (const file of await filesUnder(resolve(skillRoot, managedRoot))) {
    const destinationPath = relative(skillRoot, file).replaceAll('\\', '/')
    if (expectedManagedPaths.has(destinationPath)) continue
    if (checkOnly) {
      drift = true
      process.stderr.write(`Stale PPTD reference: ${destinationPath}\n`)
    } else {
      await rm(file)
      process.stdout.write(`Removed stale ${destinationPath}\n`)
    }
  }
}
const allowedTopLevelReferences = new Set([
  ...mappings.map(([, destinationPath]) => destinationPath).filter((path) => dirname(path) === 'reference'),
  'reference/slide-categories.md',
  'reference/open-kimi-workflow.md',
  'reference/index.md',
  'reference/solidify-pptd-support.md',
])
for (const entry of await readdir(resolve(skillRoot, 'reference'), { withFileTypes: true })) {
  if (!entry.isFile()) continue
  const destinationPath = `reference/${entry.name}`
  if (allowedTopLevelReferences.has(destinationPath)) continue
  if (checkOnly) {
    drift = true
    process.stderr.write(`Stale PPTD reference: ${destinationPath}\n`)
  } else {
    await rm(resolve(skillRoot, destinationPath))
    process.stdout.write(`Removed stale ${destinationPath}\n`)
  }
}

for (const [sourcePath, destinationPath] of mappings) {
  const source = resolve(refsRoot, sourcePath)
  const destination = resolve(skillRoot, destinationPath)
  if (checkOnly) {
    const [expected, actual] = await Promise.all([readFile(source), readFile(destination)])
    if (!expected.equals(actual)) {
      drift = true
      process.stderr.write(`PPTD reference drift: ${destinationPath}\n`)
    }
    continue
  }
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
  process.stdout.write(`Synced ${destinationPath}\n`)
}

const upstreamSkill = await readFile(resolve(refsRoot, 'SKILL.md'), 'utf8')
const upstreamBody = upstreamSkill.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, '').trim()
const adaptedWorkflow = [
  '> Solidify adaptation note: this is the complete upstream workflow preserved',
  '> as an authoritative capability and quality reference. Commands, paths,',
  '> prerequisite checks and dual-delivery behavior described below apply only',
  '> when the corresponding Solidify tool or UI capability is available. For an',
  '> in-chat generation run, the execution contract in the parent `SKILL.md`',
  '> takes precedence: use `generate_pptd` once and let the app own rendering,',
  '> validation, artifact delivery and export UI integration.',
  '',
  '# Upstream open-kimi-ppt workflow',
  '',
  'The upstream capability covers creating, editing, replicating, reading and',
  'exporting presentations, with both an editable PPTD project and a local PPTX as',
  'its default deliverables.',
  '',
  upstreamBody
    .replace(/^# Definition/m, '## Definition')
    .replaceAll('reference/design_system/', 'reference/design-system/')
    .replaceAll('reference/slides_categories', 'reference/slide-categories'),
  '',
].join('\n')
const workflowDestinationPath = 'reference/open-kimi-workflow.md'
const workflowDestination = resolve(skillRoot, workflowDestinationPath)
if (checkOnly) {
  const currentWorkflow = await readFile(workflowDestination, 'utf8')
  if (currentWorkflow !== adaptedWorkflow) {
    drift = true
    process.stderr.write(`PPTD reference drift: ${workflowDestinationPath}\n`)
  }
} else {
  await mkdir(dirname(workflowDestination), { recursive: true })
  await writeFile(workflowDestination, adaptedWorkflow)
  process.stdout.write(`Synced ${workflowDestinationPath}\n`)
}

const slideCategoryIndex = (await readFile(resolve(refsRoot, 'reference/slides_categories.md'), 'utf8'))
  .replaceAll('reference/slides_categories/', 'reference/slide-categories/')
const slideCategoryDestinationPath = 'reference/slide-categories.md'
const slideCategoryDestination = resolve(skillRoot, slideCategoryDestinationPath)
if (checkOnly) {
  const currentSlideCategoryIndex = await readFile(slideCategoryDestination, 'utf8')
  if (currentSlideCategoryIndex !== slideCategoryIndex) {
    drift = true
    process.stderr.write(`PPTD reference drift: ${slideCategoryDestinationPath}\n`)
  }
} else {
  await writeFile(slideCategoryDestination, slideCategoryIndex)
  process.stdout.write(`Synced ${slideCategoryDestinationPath}\n`)
}

if (checkOnly && drift) process.exitCode = 1

async function filesUnder(root) {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...await filesUnder(path))
    else if (entry.isFile()) result.push(path)
  }
  return result.sort()
}
