import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const cases = JSON.parse(await readFile(resolve(root, 'benchmarks/agent-pipeline/cases.json'), 'utf8'))
const args = process.argv.slice(2)

if (args.includes('--help') || args.length === 0) {
  console.log('Usage: node scripts/check-agent-pipeline-benchmark.mjs --results <results.json> [--baseline <baseline.json>] [--max-failure-rate <0..1>] [--max-duration-p95 <ms>] [--max-first-chunk-p95 <ms>]')
  process.exit(args.includes('--help') ? 0 : 2)
}

const resultsPath = valueAfter('--results')
const baselinePath = valueAfter('--baseline')
const maxFailureRate = numberAfter('--max-failure-rate')
const maxDurationP95 = numberAfter('--max-duration-p95')
const maxFirstChunkP95 = numberAfter('--max-first-chunk-p95')
if (!resultsPath) fail('--results is required')
if (maxFailureRate !== undefined && (maxFailureRate < 0 || maxFailureRate > 1)) fail('--max-failure-rate must be between 0 and 1')
if (maxDurationP95 !== undefined && maxDurationP95 < 0) fail('--max-duration-p95 must be non-negative')
if (maxFirstChunkP95 !== undefined && maxFirstChunkP95 < 0) fail('--max-first-chunk-p95 must be non-negative')

const optimized = await readRows(resultsPath)
const summary = validateRows(optimized, 'optimized')
if (maxFailureRate !== undefined && summary.failureRate > maxFailureRate) {
  fail(`failure-rate gate failed: ${(summary.failureRate * 100).toFixed(2)}% > ${(maxFailureRate * 100).toFixed(2)}%`)
}
if (maxDurationP95 !== undefined && summary.latency.durationMs.p95 > maxDurationP95) {
  fail(`duration p95 gate failed: ${summary.latency.durationMs.p95}ms > ${maxDurationP95}ms`)
}
if (maxFirstChunkP95 !== undefined && summary.latency.firstChunkMs.p95 > maxFirstChunkP95) {
  fail(`first-chunk p95 gate failed: ${summary.latency.firstChunkMs.p95}ms > ${maxFirstChunkP95}ms`)
}
if (baselinePath) {
  const baseline = await readRows(baselinePath)
  const baselineSummary = validateRows(baseline, 'baseline')
  compareQuality(baselineSummary, summary)
}

console.log(JSON.stringify({
  cases: cases.cases.length,
  rows: optimized.length,
  providers: [...new Set(optimized.map((row) => row.provider))].sort(),
  averageQuality: Number((summary.quality / optimized.length).toFixed(3)),
  failureRate: Number(summary.failureRate.toFixed(4)),
  latency: summary.latency,
  status: 'pass',
}, null, 2))

function valueAfter(flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function numberAfter(flag) {
  const value = valueAfter(flag)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) fail(`${flag} must be a number`)
  return parsed
}

async function readRows(path) {
  try {
    const raw = JSON.parse(await readFile(resolve(process.cwd(), path), 'utf8'))
    if (!Array.isArray(raw)) fail(`${path} must contain a JSON array of result rows`)
    return raw
  } catch (error) {
    fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function validateRows(rows, label) {
  const known = new Set(cases.cases.map((item) => item.id))
  const seen = new Set()
  let quality = 0
  let failures = 0
  const durations = []
  const firstChunks = []
  const firstArtifacts = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') fail(`${label} contains a non-object row`)
    const key = `${row.provider ?? ''}:${row.caseId ?? ''}`
    if (seen.has(key)) fail(`${label} duplicates ${key}`)
    seen.add(key)
    if (typeof row.provider !== 'string' || !row.provider.trim()) fail(`${label} row is missing provider`)
    if (typeof row.caseId !== 'string' || !known.has(row.caseId)) fail(`${label} contains unknown caseId ${row.caseId}`)
    for (const field of ['runId', 'model', 'runtimeVersion', 'reviewerNotes']) {
      if (typeof row[field] !== 'string' || !row[field].trim()) fail(`${label} ${key} is missing ${field}`)
    }
    if (row.status !== 'completed' && row.status !== 'failed') fail(`${label} ${key} has invalid status (expected completed or failed)`)
    if (row.status === 'failed') {
      failures += 1
      if (typeof row.failureClass !== 'string' || !row.failureClass.trim()) fail(`${label} ${key} failed row is missing failureClass`)
    }
    for (const field of ['providerCalls', 'toolCalls', 'inputTokens', 'outputTokens', 'firstChunkMs', 'durationMs']) {
      if (!Number.isInteger(row[field]) || row[field] < 0) fail(`${label} ${key} has invalid ${field}`)
    }
    if (row.firstArtifactMs !== null && (!Number.isInteger(row.firstArtifactMs) || row.firstArtifactMs < 0)) {
      fail(`${label} ${key} has invalid firstArtifactMs (expected a non-negative integer or null)`)
    }
    for (const field of ['cacheReadTokens', 'cacheWriteTokens']) {
      if (row[field] !== undefined && (!Number.isInteger(row[field]) || row[field] < 0)) fail(`${label} ${key} has invalid ${field}`)
    }
    durations.push(row.durationMs)
    firstChunks.push(row.firstChunkMs)
    if (row.firstArtifactMs !== null) firstArtifacts.push(row.firstArtifactMs)
    const rubric = row.quality
    if (!rubric || typeof rubric !== 'object') fail(`${label} ${key} is missing quality rubric`)
    const score = ['coverage', 'factuality', 'acceptance', 'format', 'usability'].reduce((sum, field) => {
      if (!Number.isFinite(rubric[field]) || rubric[field] < 0 || rubric[field] > 4) fail(`${label} ${key} has invalid quality.${field}`)
      return sum + rubric[field]
    }, 0)
    quality += score
  }
  if (rows.length === 0) fail(`${label} is empty`)
  const providers = [...new Set(rows.map((row) => row.provider))]
  for (const provider of providers) {
    for (const item of cases.cases) {
      if (!seen.has(`${provider}:${item.id}`)) fail(`${label} is missing ${provider}:${item.id}`)
    }
  }
  return {
    rows,
    quality,
    failureRate: failures / rows.length,
    latency: {
      durationMs: percentileSummary(durations),
      firstChunkMs: percentileSummary(firstChunks),
      firstArtifactMs: firstArtifacts.length ? percentileSummary(firstArtifacts) : null,
    },
  }
}

function percentileSummary(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  }
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  return sorted[index]
}

function compareQuality(baseline, optimized) {
  const baselineByKey = new Map(baseline.rows.map((row) => [`${row.provider}:${row.caseId}`, row]))
  const optimizedByKey = new Map(optimized.rows.map((row) => [`${row.provider}:${row.caseId}`, row]))
  for (const [key, base] of baselineByKey) {
    const next = optimizedByKey.get(key)
    if (!next) fail(`optimized results missing baseline row ${key}`)
    const baseScore = rubricScore(base.quality)
    const nextScore = rubricScore(next.quality)
    if (baseScore > 0 && nextScore < baseScore * 0.95) {
      fail(`quality gate failed for ${key}: ${nextScore}/${baseScore}`)
    }
  }
}

function rubricScore(rubric) {
  return ['coverage', 'factuality', 'acceptance', 'format', 'usability']
    .reduce((sum, field) => sum + rubric[field], 0)
}

function fail(message) {
  console.error(`benchmark gate failed: ${message}`)
  process.exit(1)
}
