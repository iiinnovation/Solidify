import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'

const args = process.argv.slice(2)
if (args.includes('--help') || args.length === 0) {
  console.log('Usage: node scripts/prepare-agent-pipeline-results.mjs --observations <observations.json> --reviews <reviews.json> --output <results.json>')
  process.exit(args.includes('--help') ? 0 : 2)
}

const observationsPath = valueAfter('--observations')
const reviewsPath = valueAfter('--reviews')
const outputPath = valueAfter('--output')
if (!observationsPath || !reviewsPath || !outputPath) fail('--observations, --reviews and --output are required')

const observations = await readRows(observationsPath, 'observations', 'observations')
const reviews = await readRows(reviewsPath, 'reviews', 'rows')
const byKey = new Map()
for (const review of reviews) {
  const key = keyOf(review)
  if (byKey.has(key)) fail(`duplicate review ${key}`)
  byKey.set(key, review)
}

const result = observations.map((observation) => {
  const key = keyOf(observation)
  const review = byKey.get(key)
  if (!review) fail(`missing review ${key}`)
  const quality = review.quality
  if (!quality || typeof quality !== 'object' || Array.isArray(quality)) fail(`${key} is missing quality`)
  for (const field of ['coverage', 'factuality', 'acceptance', 'format', 'usability']) {
    if (!Number.isInteger(quality[field]) || quality[field] < 0 || quality[field] > 4) fail(`${key} quality.${field} must be an integer from 0 to 4`)
  }
  if (typeof review.reviewerNotes !== 'string' || !review.reviewerNotes.trim()) fail(`${key} is missing reviewerNotes`)
  // Review files may contain generated text for human inspection, but the
  // gate input is deliberately metrics-only and never carries that transcript.
  return { ...observation, quality, reviewerNotes: review.reviewerNotes }
})

for (const key of byKey.keys()) {
  if (!observations.some((observation) => keyOf(observation) === key)) fail(`review has no matching observation ${key}`)
}

const target = resolve(process.cwd(), outputPath)
await mkdir(dirname(target), { recursive: true })
await writeFile(target, JSON.stringify(result, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ rows: result.length, output: target, status: 'prepared' }, null, 2))

function readRows(path, label, field) {
  return readFile(resolve(process.cwd(), path), 'utf8')
    .then((raw) => JSON.parse(raw))
    .then((value) => {
      const rows = Array.isArray(value) ? value : value?.[field]
      if (!Array.isArray(rows)) fail(`${label} must be an array or an object containing ${field}`)
      return rows
    })
    .catch((error) => fail(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`))
}

function keyOf(row) {
  if (!row || typeof row !== 'object' || typeof row.provider !== 'string' || typeof row.caseId !== 'string') fail('row is missing provider/caseId')
  return `${row.provider}:${row.caseId}`
}

function valueAfter(flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function fail(message) {
  console.error(`benchmark preparation failed: ${message}`)
  process.exit(1)
}
