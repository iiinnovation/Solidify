import type { PptdElement } from './types'

export const PPTD_NATIVE_CHART_TYPES = ['bar', 'line', 'area', 'pie', 'doughnut', 'scatter', 'bubble', 'radar'] as const
export const PPTD_IMAGE_CHART_TYPES = ['waterfall', 'heatmap', 'treemap', 'sunburst', 'sankey', 'candlestick'] as const
export type PptdNativeChartType = typeof PPTD_NATIVE_CHART_TYPES[number]
export type PptdImageChartType = typeof PPTD_IMAGE_CHART_TYPES[number]
export type PptdChartType = PptdNativeChartType | PptdImageChartType

export interface PptdChartRecord { [key: string]: unknown }
export interface PptdChartSeries { key: string; label?: string; color?: string }
export interface PptdChartSpec {
  chartType: PptdChartType
  data: PptdChartRecord[]
  xKey: string
  yKey: string
  title?: string
  series: PptdChartSeries[]
}

const DEFAULT_COLORS = ['#2563eb', '#d97706', '#059669', '#dc2626', '#7c3aed', '#0891b2']
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/

export function getPptdChartSpec(element: PptdElement): PptdChartSpec {
  const content = element.content ?? {}
  const dataValue = Array.isArray(element.data) ? element.data : Array.isArray(content.data) ? content.data : []
  const chartType = String(element.chartType ?? content.chartType ?? 'bar') as PptdChartType
  const xKey = String(element.xKey ?? content.xKey ?? 'name')
  const yKey = String(element.yKey ?? content.yKey ?? 'value')
  const configured = Array.isArray(element.series) ? element.series : Array.isArray(content.series) ? content.series : []
  const series = configured.length > 0
    ? configured.map((item, index) => {
      const value = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {}
      return {
        key: String(value.key ?? value.name ?? yKey),
        label: typeof value.label === 'string' ? value.label : undefined,
        color: safeChartColor(value.color, DEFAULT_COLORS[index % DEFAULT_COLORS.length]),
      }
    })
    : [{ key: yKey, label: yKey, color: DEFAULT_COLORS[0] }]
  return { chartType, data: dataValue.filter((item): item is PptdChartRecord => Boolean(item && typeof item === 'object' && !Array.isArray(item))), xKey, yKey, title: typeof element.title === 'string' ? element.title : typeof content.title === 'string' ? content.title : undefined, series }
}

export function isNativePptdChartType(value: string): value is PptdNativeChartType {
  return (PPTD_NATIVE_CHART_TYPES as readonly string[]).includes(value)
}

export function isImagePptdChartType(value: string): value is PptdImageChartType {
  return (PPTD_IMAGE_CHART_TYPES as readonly string[]).includes(value)
}

export function chartPptxData(spec: PptdChartSpec): Array<{ name: string; labels: string[]; values: number[]; sizes?: number[] }> {
  const labels = spec.data.map((row, index) => String(row[spec.xKey] ?? index + 1))
  return spec.series.map((series) => ({
    name: series.label ?? series.key,
    labels,
    values: spec.data.map((row) => numeric(row[series.key])),
    ...(spec.chartType === 'bubble' ? { sizes: spec.data.map((row) => Math.max(1, numeric(row.size ?? row[series.key]))) } : {}),
  }))
}

export function chartToSvg(spec: PptdChartSpec, width: number, height: number): string {
  const safeWidth = Math.max(1, width)
  const safeHeight = Math.max(1, height)
  const margin = { top: spec.title ? 34 : 14, right: 18, bottom: 28, left: 34 }
  const plotWidth = Math.max(1, safeWidth - margin.left - margin.right)
  const plotHeight = Math.max(1, safeHeight - margin.top - margin.bottom)
  const labels = spec.data.map((row, index) => escapeXml(String(row[spec.xKey] ?? index + 1)))
  const values = spec.data.flatMap((row) => spec.series.map((series) => numeric(row[series.key])))
  const max = Math.max(1, ...values.map((value) => Math.abs(value)))
  const min = Math.min(0, ...values)
  const range = Math.max(1, max - min)
  const valueY = (value: number) => margin.top + plotHeight - ((value - min) / range) * plotHeight
  const xAt = (index: number) => margin.left + (labels.length <= 1 ? plotWidth / 2 : (index / (labels.length - 1)) * plotWidth)
  const axis = `<line x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${margin.left + plotWidth}" y2="${margin.top + plotHeight}" stroke="#94a3b8" stroke-width="1"/><line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}" stroke="#94a3b8" stroke-width="1"/>`
  let body = ''
  if (spec.chartType === 'pie' || spec.chartType === 'doughnut') body = pieSvg(spec, margin.left, margin.top, plotWidth, plotHeight)
  else if (spec.chartType === 'radar') body = radarSvg(spec, margin.left, margin.top, plotWidth, plotHeight, max)
  else if (isImagePptdChartType(spec.chartType)) body = imageChartSvg(spec, margin.left, margin.top, plotWidth, plotHeight, min, range)
  else if (spec.chartType === 'scatter' || spec.chartType === 'bubble') body = scatterSvg(spec, xAt, valueY)
  else if (spec.chartType === 'bar') body = barSvg(spec, margin.left, margin.top, plotWidth, plotHeight, min, range)
  else {
    body = spec.series.map((series) => {
      const points = spec.data.map((row, index) => `${xAt(index)},${valueY(numeric(row[series.key]))}`).join(' ')
      const seriesColor = safeChartColor(series.color, DEFAULT_COLORS[0])
      const area = spec.chartType === 'area' ? `<polygon points="${points} ${xAt(labels.length - 1)},${margin.top + plotHeight} ${xAt(0)},${margin.top + plotHeight}" fill="${seriesColor}" opacity="0.18"/>` : ''
      return `${area}<polyline points="${points}" fill="none" stroke="${seriesColor}" stroke-width="2"/>`
    }).join('')
  }
  const labelSvg = labels.map((label, index) => `<text x="${xAt(index)}" y="${safeHeight - 8}" text-anchor="middle" font-size="10" fill="#475569">${label}</text>`).join('')
  const title = spec.title ? `<text x="${safeWidth / 2}" y="20" text-anchor="middle" font-size="14" font-weight="600" fill="#0f172a">${escapeXml(spec.title)}</text>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${safeWidth} ${safeHeight}" width="${safeWidth}" height="${safeHeight}">${title}${spec.chartType === 'pie' || spec.chartType === 'doughnut' || spec.chartType === 'radar' ? '' : axis}${body}${spec.chartType === 'pie' || spec.chartType === 'doughnut' || spec.chartType === 'radar' ? '' : labelSvg}</svg>`
}

function imageChartSvg(spec: PptdChartSpec, left: number, top: number, width: number, height: number, min: number, range: number): string {
  if (spec.chartType === 'heatmap') {
    const columns = Math.max(1, Math.ceil(Math.sqrt(spec.data.length)))
    const cell = Math.min(width / columns, height / columns)
    return spec.data.map((row, index) => {
      const value = Math.max(0, Math.min(1, (numeric(row[spec.series[0]?.key ?? spec.yKey]) - min) / range))
      return `<rect x="${left + (index % columns) * cell}" y="${top + Math.floor(index / columns) * cell}" width="${cell - 2}" height="${cell - 2}" fill="rgb(${Math.round(37 + value * 180)},${Math.round(99 + (1 - value) * 100)},${Math.round(235 - value * 120)})"/>`
    }).join('')
  }
  if (spec.chartType === 'candlestick') {
    const group = width / Math.max(1, spec.data.length)
    return spec.data.map((row, index) => {
      const open = numeric(row.open ?? row[spec.series[0]?.key ?? spec.yKey])
      const close = numeric(row.close ?? open)
      const high = Math.max(open, close, numeric(row.high ?? open))
      const low = Math.min(open, close, numeric(row.low ?? open))
      const y = (value: number) => top + height - ((value - min) / range) * height
      return `<line x1="${left + index * group + group / 2}" y1="${y(high)}" x2="${left + index * group + group / 2}" y2="${y(low)}" stroke="#475569"/><rect x="${left + index * group + group * 0.25}" y="${Math.min(y(open), y(close))}" width="${group * 0.5}" height="${Math.max(2, Math.abs(y(open) - y(close)))}" fill="${close >= open ? '#059669' : '#dc2626'}"/>`
    }).join('')
  }
  if (spec.chartType === 'treemap') {
    const total = Math.max(1, spec.data.reduce((sum, row) => sum + Math.max(0, numeric(row[spec.series[0]?.key ?? spec.yKey])), 0))
    let cursor = left
    return spec.data.map((row, index) => {
      const segment = width * Math.max(0, numeric(row[spec.series[0]?.key ?? spec.yKey])) / total
      const result = `<rect x="${cursor}" y="${top}" width="${Math.max(2, segment - 2)}" height="${height}" fill="${DEFAULT_COLORS[index % DEFAULT_COLORS.length]}" opacity="0.78"/><text x="${cursor + 4}" y="${top + 16}" font-size="10" fill="white">${escapeXml(String(row[spec.xKey] ?? index + 1))}</text>`
      cursor += segment
      return result
    }).join('')
  }
  if (spec.chartType === 'sunburst') return `${pieSvg({ ...spec, chartType: 'pie' }, left, top, width, height)}<circle cx="${left + width / 2}" cy="${top + height / 2}" r="${Math.min(width, height) * 0.18}" fill="#fff"/>`
  if (spec.chartType === 'sankey') {
    const group = height / Math.max(1, spec.data.length)
    return spec.data.map((_row, index) => {
      const y = top + group * index + group / 2
      return `<path d="M ${left + width * 0.15} ${y} C ${left + width * 0.4} ${y - group} ${left + width * 0.6} ${y + group} ${left + width * 0.85} ${y}" fill="none" stroke="${DEFAULT_COLORS[index % DEFAULT_COLORS.length]}" stroke-width="${Math.max(2, group * 0.4)}" opacity="0.55"/>`
    }).join('')
  }
  // waterfall: cumulative bars with a zero baseline.
  let cumulative = 0
  const group = width / Math.max(1, spec.data.length)
  return spec.data.map((row, index) => {
    const value = numeric(row[spec.series[0]?.key ?? spec.yKey])
    const start = cumulative
    cumulative += value
    const y = (point: number) => top + height - ((point - min) / range) * height
    return `<rect x="${left + index * group + group * 0.18}" y="${Math.min(y(start), y(cumulative))}" width="${group * 0.64}" height="${Math.max(2, Math.abs(y(start) - y(cumulative)))}" fill="${value >= 0 ? '#2563eb' : '#dc2626'}"/>`
  }).join('')
}

function barSvg(spec: PptdChartSpec, left: number, top: number, width: number, height: number, min: number, range: number): string {
  const groupWidth = width / Math.max(1, spec.data.length)
  const barWidth = Math.max(2, groupWidth / Math.max(1, spec.series.length) * 0.72)
  return spec.data.flatMap((row, index) => spec.series.map((series, seriesIndex) => {
    const value = numeric(row[series.key])
    const y = top + height - ((value - min) / range) * height
    const zero = top + height - ((0 - min) / range) * height
    return `<rect x="${left + index * groupWidth + seriesIndex * (groupWidth / spec.series.length) + 2}" y="${Math.min(y, zero)}" width="${barWidth}" height="${Math.max(1, Math.abs(zero - y))}" fill="${safeChartColor(series.color, DEFAULT_COLORS[0])}" rx="2"/>`
  })).join('')
}

function pieSvg(spec: PptdChartSpec, left: number, top: number, width: number, height: number): string {
  const values = spec.data.map((row) => Math.max(0, numeric(row[spec.series[0]?.key ?? spec.yKey])))
  const total = Math.max(1, values.reduce((sum, value) => sum + value, 0))
  const cx = left + width / 2
  const cy = top + height / 2
  const radius = Math.max(2, Math.min(width, height) * 0.34)
  let angle = -Math.PI / 2
  return values.map((value, index) => {
    const next = angle + (value / total) * Math.PI * 2
    const large = next - angle > Math.PI ? 1 : 0
    const x1 = cx + radius * Math.cos(angle)
    const y1 = cy + radius * Math.sin(angle)
    const x2 = cx + radius * Math.cos(next)
    const y2 = cy + radius * Math.sin(next)
    const path = `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z" fill="${DEFAULT_COLORS[index % DEFAULT_COLORS.length]}"/>`
    angle = next
    return path
  }).join('') + (spec.chartType === 'doughnut' ? `<circle cx="${cx}" cy="${cy}" r="${radius * 0.5}" fill="white"/>` : '')
}

function scatterSvg(spec: PptdChartSpec, xAt: (index: number) => number, valueY: (value: number) => number): string {
  return spec.data.flatMap((row, index) => spec.series.map((series) => {
    const value = numeric(row[series.key])
    const radius = spec.chartType === 'bubble' ? Math.max(3, Math.min(18, Math.sqrt(Math.abs(numeric(row.size ?? value))))) : 4
    return `<circle cx="${xAt(index)}" cy="${valueY(value)}" r="${radius}" fill="${safeChartColor(series.color, DEFAULT_COLORS[0])}" opacity="0.75"/>`
  })).join('')
}

function radarSvg(spec: PptdChartSpec, left: number, top: number, width: number, height: number, max: number): string {
  const cx = left + width / 2
  const cy = top + height / 2
  const radius = Math.max(2, Math.min(width, height) * 0.36)
  const count = Math.max(3, spec.data.length)
  const point = (index: number, value: number) => {
    const angle = -Math.PI / 2 + (index / count) * Math.PI * 2
    return `${cx + Math.cos(angle) * radius * (value / max)},${cy + Math.sin(angle) * radius * (value / max)}`
  }
  const grid = `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#cbd5e1"/><circle cx="${cx}" cy="${cy}" r="${radius * 0.5}" fill="none" stroke="#e2e8f0"/>`
  const polygons = spec.series.map((series) => {
    const seriesColor = safeChartColor(series.color, DEFAULT_COLORS[0])
    return `<polygon points="${spec.data.map((row, index) => point(index, numeric(row[series.key]))).join(' ')}" fill="${seriesColor}" opacity="0.22" stroke="${seriesColor}"/>`
  }).join('')
  return `${grid}${polygons}`
}

function numeric(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/**
 * Chart colours are inserted into an SVG attribute.  Keep this deliberately
 * narrower than CSS colour syntax: accepting only hex colours both makes the
 * output deterministic and prevents an untrusted value from closing the
 * attribute and injecting markup.
 */
function safeChartColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value) ? value : fallback
}

export function svgDataUri(svg: string): string {
  if (typeof TextEncoder === 'undefined' || typeof btoa === 'undefined') return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const bytes = new TextEncoder().encode(svg)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:image/svg+xml;base64,${btoa(binary)}`
}
