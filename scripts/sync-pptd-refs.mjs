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

const adaptedWorkflow = [
  '> Solidify adaptation note: this file keeps the upstream design and QA',
  '> principles that remain valid inside the app. External commands, network',
  '> services, filesystem paths and dual-delivery promises are intentionally',
  '> removed. The parent `SKILL.md` and the local `generate_pptd` tool own',
  '> execution, validation, preview and artifact delivery.',
  '',
  '# PPTD production workflow',
  '',
  'The design references cover creating, editing, replicating and reviewing',
  'presentations. Solidify runs the supported subset in the local PPTD engine;',
  'it does not delegate work to an upstream editor or exporter.',
  '',
  '## Before generation',
  '',
  '1. Determine purpose, audience, input type, page count and design direction.',
  '2. Use the user material as the source of truth; do not expand with external search.',
  '3. For a new deck, select one scenario reference and one compatible design system.',
  '4. For an edit or replication, preserve the requested structure and change only the',
  '   requested scope. Ask only questions that materially change the result.',
  '',
  '## Generation and review',
  '',
  '1. Let `generate_pptd` build the outline, pages, source index and artifact in one',
  '   bounded pipeline call. Do not handwrite page YAML or wrap the returned artifact.',
  '2. Respect `reference/pptd.md` and `reference/solidify-pptd-support.md`; fields',
  '   outside the local support matrix must not be emitted.',
  '3. Review structure, bounds, text overflow, contrast, hierarchy and source coverage.',
  '   Use visual preview only when the app exposes it; otherwise perform the local',
  '   structural checks and report that visual review was unavailable.',
  '4. Prefer a finite repair pass with concrete validation errors over full regeneration.',
  '',
  '## Delivery boundaries',
  '',
  '- The chat delivers the single `type="slides"` artifact produced by Solidify.',
  '- Do not claim unsupported PPTX features such as animations, embedded fonts or',
  '  external editor compatibility. Use the local support reference as the boundary.',
  '- Keep user media and source IDs self-contained in the artifact; never expose',
  '  private attachment text in diagnostics or instructions.',
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
