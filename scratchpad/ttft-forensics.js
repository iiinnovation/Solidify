/*
 * Paste this file into a browser DevTools console while a Solidify run ledger
 * is available. It intentionally prints counts, timings and token buckets only
 *; attachment or prompt bodies are never printed.
 */
(() => {
  const rows = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (!key || !key.startsWith('solidify-ledger:')) continue
    let events
    try { events = JSON.parse(localStorage.getItem(key) || '[]') } catch { continue }
    if (!Array.isArray(events)) continue
    const called = new Map()
    for (const event of events) {
      if (event.type === 'model.called') called.set(event.payload?.turn, event)
      if (event.type !== 'model.completed') continue
      const payload = event.payload || {}
      const request = called.get(payload.turn)?.payload?.request
      const inputTokens = Number(payload.usage?.inputTokens ?? 0)
      const outputTokens = Number(payload.usage?.outputTokens ?? 0)
      const toolCalls = Array.isArray(payload.toolCalls) ? payload.toolCalls.length : 0
      const text = typeof payload.text === 'string' ? payload.text : ''
      const start = Date.parse(called.get(payload.turn)?.ts || '')
      const end = Date.parse(event.ts || '')
      const first = payload.firstChunkAt ? Date.parse(payload.firstChunkAt) : NaN
      if (!Number.isFinite(start) || !Number.isFinite(end) || !toolCalls || text.trim() || inputTokens <= 0) continue
      rows.push({
        runId: event.runId,
        turn: payload.turn,
        inputTokens,
        outputTokens,
        calls: toolCalls,
        roundMs: Math.max(0, end - start),
        firstChunkMs: Number.isFinite(first) ? Math.max(0, first - start) : null,
        decodeMs: Number.isFinite(first) ? Math.max(0, end - first) : null,
      })
    }
  }

  rows.sort((a, b) => a.inputTokens - b.inputTokens || a.roundMs - b.roundMs)
  const withFirst = rows.filter((row) => row.firstChunkMs !== null)
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  const regression = (items) => {
    if (items.length < 2) return null
    const x = items.map((item) => item.inputTokens)
    const y = items.map((item) => item.roundMs)
    const xBar = mean(x)
    const yBar = mean(y)
    const denominator = x.reduce((sum, value) => sum + (value - xBar) ** 2, 0)
    if (!denominator) return null
    const slope = x.reduce((sum, value, index) => sum + (value - xBar) * (y[index] - yBar), 0) / denominator
    const intercept = yBar - slope * xBar
    return { interceptMs: intercept, slopeMsPerToken: slope }
  }
  const buckets = new Map()
  for (const row of rows) {
    const bucket = Math.floor(row.inputTokens / 1000) * 1000
    const entry = buckets.get(bucket) || { bucket, count: 0, roundMs: [], firstChunkMs: [], decodeMs: [] }
    entry.count += 1
    entry.roundMs.push(row.roundMs)
    if (row.firstChunkMs !== null) entry.firstChunkMs.push(row.firstChunkMs)
    if (row.decodeMs !== null) entry.decodeMs.push(row.decodeMs)
    buckets.set(bucket, entry)
  }
  const percentile = (values, p) => {
    if (!values.length) return null
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
  }
  const summary = [...buckets.values()].map((entry) => ({
    inputTokenBucket: `${entry.bucket}-${entry.bucket + 999}`,
    n: entry.count,
    roundP50Ms: percentile(entry.roundMs, 0.5),
    roundP95Ms: percentile(entry.roundMs, 0.95),
    firstChunkP50Ms: percentile(entry.firstChunkMs, 0.5),
    decodeP50Ms: percentile(entry.decodeMs, 0.5),
  }))
  console.table(rows)
  console.table(summary)
  console.info('[ttft-forensics] pure tool rounds:', rows.length, 'with firstChunkAt:', withFirst.length)
  console.info('[ttft-forensics] regression:', regression(rows))
  return { rows, summary, regression: regression(rows) }
})()
