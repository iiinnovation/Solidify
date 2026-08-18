import { chartToSvg, getPptdChartSpec } from './chart'
import type { PptdElement, PptdProject, PptdValidationResult } from './types'
import { validatePptdProject } from './validate'

export interface PptdReviewImage {
  pageIndex: number
  imageDataUrl: string
}

export interface PptdReviewLoopOptions {
  maxRounds?: number
  visionAvailable?: boolean
  /** Override for adapters/tests; production reviews use the local validator. */
  validate?: (project: PptdProject) => PptdValidationResult | Promise<PptdValidationResult>
  capture: (project: PptdProject, pageIndexes: number[]) => Promise<PptdReviewImage[]>
  review: (images: PptdReviewImage[], project: PptdProject) => Promise<{ approved: boolean; feedback: string }>
  repair: (project: PptdProject, feedback: string, validation: PptdValidationResult) => Promise<PptdProject>
}

/**
 * Render a deterministic, self-contained page image for the visual reviewer.
 * The production browser path rasterizes this SVG to PNG; the SVG fallback is
 * useful for tests and non-DOM hosts and still contains the page geometry.
 */
export async function capturePptdPageImages(project: PptdProject, pageIndexes: number[]): Promise<PptdReviewImage[]> {
  return Promise.all(pageIndexes.map(async (pageIndex) => ({
    pageIndex,
    imageDataUrl: await rasterizePptdPage(project, pageIndex),
  })))
}

export function buildPptdPageSvgDataUrl(project: PptdProject, pageIndex: number): string {
  const [width, height] = project.size
  const page = project.pages[pageIndex]
  if (!page) return ''
  const background = svgBackground(page.background, project)
  const elements = orderedElements(page.elements).map((element) => svgElement(element, project)).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${background}${elements}</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

export interface PptdReviewResult {
  project: PptdProject
  approved: boolean
  rounds: number
  validation: PptdValidationResult
  feedback: string[]
}

/** Stable self-check prompt used by model adapters that support vision. */
export function buildPptdReviewPrompt(pageIndex: number, pageCount: number): string {
  return `请审阅 PPTD 第 ${pageIndex + 1}/${pageCount} 页截图。只报告可观察到的排版问题：文本重叠或溢出、元素越界、对比度不足、对齐/留白失衡、图片裁切异常、层级遮挡、图表是否只有坐标轴/空数据，以及图形是否错误表达了本应使用节点和连线的架构关系。若页面只有标题和少量裸文本、没有形成大纲要求的证据结构或视觉层级，也必须报告；封面页可例外。若没有问题，返回 APPROVED；若有问题，按 elementId 给出最小可执行修复建议。`
}

/**
 * Local orchestration primitive for M5's visual QA loop. The model adapter is
 * injected by the caller, so the PPTD engine never depends on a remote editor.
 */
export async function runPptdReviewLoop(project: PptdProject, options: PptdReviewLoopOptions): Promise<PptdReviewResult> {
  const maxRounds = Math.max(1, options.maxRounds ?? 3)
  const validate = options.validate ?? validatePptdProject
  let current = project
  let validation = await validate(current)
  const feedback: string[] = []

  if (options.visionAvailable === false) {
    feedback.push('模型不支持 vision，已跳过截图审阅，仅执行结构校验')
    return { project: current, approved: validation.valid, rounds: 0, validation, feedback }
  }

  for (let round = 1; round <= maxRounds; round++) {
    if (!validation.valid) {
      const message = validation.errors.map((item) => `${item.path}: ${item.message}`).join('\n')
      feedback.push(`结构/版式校验第 ${round} 轮：${message}`)
      current = await options.repair(current, message, validation)
      validation = await validate(current)
      continue
    }
    const images = await options.capture(current, current.pages.map((_page, index) => index))
    const result = await options.review(images, current)
    if (result.feedback) feedback.push(`视觉审阅第 ${round} 轮：${result.feedback}`)
    if (result.approved) return { project: current, approved: true, rounds: round, validation, feedback }
    current = await options.repair(current, result.feedback, validation)
    validation = await validate(current)
  }

  return { project: current, approved: false, rounds: maxRounds, validation, feedback }
}

async function rasterizePptdPage(project: PptdProject, pageIndex: number): Promise<string> {
  const svg = buildPptdPageSvgDataUrl(project, pageIndex)
  if (typeof document === 'undefined' || typeof Image === 'undefined' || !svg) return svg
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return svg
  const canvas = document.createElement('canvas')
  canvas.width = project.size[0]
  canvas.height = project.size[1]
  let context: CanvasRenderingContext2D | null = null
  try { context = canvas.getContext('2d') } catch { return svg }
  if (!context) return svg
  return new Promise((resolve) => {
    const image = new Image()
    const finish = (value: string) => { image.onload = null; image.onerror = null; resolve(value) }
    image.onload = () => {
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      try { finish(canvas.toDataURL('image/png')) } catch { finish(svg) }
    }
    image.onerror = () => finish(svg)
    image.src = svg
  })
}

function svgBackground(background: Record<string, unknown> | undefined, project: PptdProject): string {
  const fallback = svgColor(project.theme.colors.bg, '#ffffff')
  if (!background) return `<rect width="100%" height="100%" fill="${fallback}"/>`
  if (background.type === 'image' && typeof background.src === 'string') {
    const value = project.media[background.src]
    const dataUrl = mediaDataUrl(value, background.src)
    if (dataUrl) return `<image href="${escapeXml(dataUrl)}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="${record(background.fit).mode === 'contain' ? 'xMidYMid meet' : 'xMidYMid slice'}"/>`
  }
  if (background.type === 'gradient' && Array.isArray(background.stops)) {
    const id = 'pptd-background-gradient'
    const stops = background.stops.map((stop) => { const item = record(stop); return `<stop offset="${number(item.position, 0) * 100}%" stop-color="${svgColor(item.color, '#ffffff')}"/>` }).join('')
    return `<defs><linearGradient id="${id}" gradientTransform="rotate(${number(background.angle, 180)})">${stops}</linearGradient></defs><rect width="100%" height="100%" fill="url(#${id})"/>`
  }
  return `<rect width="100%" height="100%" fill="${svgColor(background.color, fallback)}"/>`
}

function svgElement(element: PptdProject['pages'][number]['elements'][number], project: PptdProject): string {
  const [x, y, width, height] = element.bounds
  const opacity = clamped(element.opacity, 0, 1, 1)
  const rotation = number(element.rotation ?? element.rotate, 0)
  const transform = rotation ? ` transform="rotate(${rotation} ${x + width / 2} ${y + height / 2})"` : ''
  if (element.elementType === 'image') {
    const src = typeof element.src === 'string' ? mediaDataUrl(project.media[element.src], element.src) : undefined
    return src ? `<image href="${escapeXml(src)}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="${record(element.fit).mode === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet'}" opacity="${opacity}"${transform}/>` : ''
  }
  if (element.elementType === 'line') {
    const stroke = record(element.stroke ?? element.border)
    const geometry = lineGeometry(element)
    return `<line x1="${geometry.x1}" y1="${geometry.y1}" x2="${geometry.x2}" y2="${geometry.y2}" stroke="${svgColor(stroke.color, '#000000')}" stroke-width="${number(stroke.width, 1)}" stroke-dasharray="${stroke.style === 'dashed' || stroke.style === 'dash' ? '6 4' : ''}" opacity="${opacity}"${transform}/>`
  }
  if (element.elementType === 'shape') {
    const fill = record(element.fill)
    const color = fill.type === 'none' ? 'none' : svgColor(fill.color, '#e5e7eb')
    const stroke = record(element.stroke ?? element.border)
    const strokeValue = stroke.color ? ` stroke="${svgColor(stroke.color, '#000000')}" stroke-width="${number(stroke.width, 1)}"` : ''
    const radius = element.shapeName === 'ellipse' ? '50%' : element.shapeName === 'roundRect' ? '12' : '0'
    if (radius === '50%') return `<ellipse cx="${x + width / 2}" cy="${y + height / 2}" rx="${width / 2}" ry="${height / 2}" fill="${color}"${strokeValue} opacity="${opacity}"${transform}/>`
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${color}"${strokeValue} opacity="${opacity}"${transform}/>`
  }
  if (element.elementType === 'icon') {
    const name = typeof element.icon === 'string' ? element.icon : typeof element.name === 'string' ? element.name : '•'
    const size = number(element.fontSize, 24)
    return `<text x="${x + width / 2}" y="${y + height / 2 + size * 0.35}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${size}" fill="${svgColor(element.color, '#111111')}" opacity="${opacity}"${transform}>${escapeXml(name)}</text>`
  }
  if (element.elementType === 'table') {
    return svgTable(element, opacity, transform)
  }
  if (element.elementType === 'chart') {
    const inner = chartToSvg(getPptdChartSpec(element), width, height).replace(/^<svg[^>]*>|<\/svg>$/g, '')
    return `<g transform="translate(${x} ${y})" opacity="${opacity}">${inner}</g>`
  }
  if (element.elementType === 'text') {
    const content = record(element.content)
    const textStyle = resolveSvgTextStyle(content, project)
    const text = stripMarkup(typeof content.text === 'string' ? content.text : '')
    const size = number(textStyle.fontSize, 18)
    const lineHeight = number(textStyle.lineHeightPx, size * number(textStyle.lineHeight, 1))
    const lines = wrapSvgText(text, width, size).slice(0, Math.max(1, Math.floor(height / Math.max(1, lineHeight))))
    const fill = svgColor(textStyle.color, '#111111')
    const family = typeof textStyle.fontFamily === 'string' ? textStyle.fontFamily : 'Arial, sans-serif'
    const align = textAlignment(content.align)
    const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'
    const textX = align === 'center' ? x + width / 2 : align === 'right' ? x + width : x
    const valign = textVerticalAlignment(content.valign ?? (Array.isArray(content.align) ? content.align[1] : undefined))
    const firstY = valign === 'bottom'
      ? y + height - Math.max(size, lines.length * lineHeight) + size
      : valign === 'middle'
        ? y + (height - lines.length * lineHeight) / 2 + size
        : y + size
    return `<text x="${textX}" y="${firstY}" text-anchor="${anchor}" font-family="${escapeXml(family)}" font-size="${size}" font-weight="${textStyle.bold ? 700 : 400}" fill="${fill}" opacity="${opacity}"${transform}>${lines.map((line, index) => `<tspan x="${textX}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`).join('')}</text>`
  }
  return ''
}

function svgTable(element: PptdElement, opacity: number, transform: string): string {
  const [x, y, width, height] = element.bounds
  const rows = Array.isArray(element.rows) ? element.rows : []
  const columnCount = rows.reduce((maximum, row) => Math.max(maximum, Array.isArray(row) ? row.length : 0), 0)
  if (rows.length === 0 || columnCount === 0) return ''
  const style = record(element.style)
  const configuredWidths = (element as Record<string, unknown>).columnWidths
  const ratios = Array.isArray(configuredWidths) && configuredWidths.length === columnCount
    ? configuredWidths.map((value) => number(value, 1) / Math.max(1, configuredWidths.reduce((sum, item) => sum + number(item, 1), 0)))
    : Array.from({ length: columnCount }, () => 1 / columnCount)
  const rowHeight = height / rows.length
  let output = `<g opacity="${opacity}"${transform}>`
  rows.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) return
    let cursor = x
    row.forEach((cell, cellIndex) => {
      const cellValue = record(cell)
      const content = record(cellValue.content)
      const cellStyle = { ...record(cellValue.style), ...content }
      const cellWidth = width * (ratios[cellIndex] ?? 1 / columnCount)
      const background = svgColor(cellStyle.backgroundColor ?? cellStyle.fill, rowIndex === 0 ? '#E2E8F0' : '#FFFFFF')
      const color = svgColor(cellStyle.color ?? (cellIndex === 0 ? style.firstColumnColor : style.bodyColor), '#111827')
      const rawText = cellStyle.text ?? cellValue.text ?? (typeof cell === 'string' || typeof cell === 'number' ? cell : '')
      const text = String(rawText)
      output += `<rect x="${cursor}" y="${y + rowIndex * rowHeight}" width="${cellWidth}" height="${rowHeight}" fill="${background}" stroke="${svgColor(style.borderColor, '#CBD5E1')}" stroke-width="1"/>`
      output += svgTableText(text, cursor + 4, y + rowIndex * rowHeight + 4, cellWidth - 8, rowHeight - 8, color, number(cellStyle.fontSize ?? style.fontSize, 12), cellStyle.bold === true)
      cursor += cellWidth
    })
  })
  return `${output}</g>`
}

function svgTableText(text: string, x: number, y: number, width: number, height: number, color: string, size: number, bold: boolean): string {
  const lineHeight = size
  const lines = wrapSvgText(text, width, size).slice(0, Math.max(1, Math.floor(height / Math.max(1, lineHeight))))
  return `<text x="${x}" y="${y + size}" font-family="Arial, sans-serif" font-size="${size}" font-weight="${bold ? 700 : 400}" fill="${color}">${lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`).join('')}</text>`
}

function mediaDataUrl(value: string | Uint8Array | undefined, path: string): string | undefined {
  if (typeof value === 'string' && value.startsWith('data:image/')) return value
  if (!(value instanceof Uint8Array) || typeof btoa === 'undefined') return undefined
  const mime = path.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : path.toLowerCase().endsWith('.jpg') || path.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
  let binary = ''
  for (let index = 0; index < value.length; index += 0x8000) binary += String.fromCharCode(...value.subarray(index, index + 0x8000))
  return `data:${mime};base64,${btoa(binary)}`
}

function stripMarkup(value: string): string { return value.replace(/<br\s*\/?>(?=.)/gi, '\n').replace(/<[^>]*>/g, '') }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function resolveSvgTextStyle(content: Record<string, unknown>, project: PptdProject): Record<string, unknown> {
  const named = typeof content.style === 'string'
    ? project.theme.textStyles[content.style]
    : record(content.style)
  return { ...(named ?? {}), ...content }
}
function orderedElements(elements: readonly PptdElement[]): PptdElement[] {
  if (!elements.some((element) => Number.isFinite(element.zIndex))) return [...elements]
  return elements.map((element, index) => ({ element, index })).sort((left, right) => {
    const z = number(left.element.zIndex, 0) - number(right.element.zIndex, 0)
    return z || left.index - right.index
  }).map(({ element }) => element)
}
function lineGeometry(element: PptdElement): { x1: number; y1: number; x2: number; y2: number } {
  const [x, y, width, height] = element.bounds
  const rawPoints = (element as Record<string, unknown>).points
  const viewBox = Array.isArray(element.viewBox) && element.viewBox.length === 2
    ? [number(element.viewBox[0], width), number(element.viewBox[1], height)]
    : [100, 100]
  if (typeof rawPoints === 'string') {
    const points = rawPoints.trim().split(/\s+/).map((point) => point.split(',').map(Number))
    const first = points[0]
    const last = points.at(-1)
    if (first?.length === 2 && last?.length === 2 && [...first, ...last].every(Number.isFinite)) {
      return { x1: x + first[0] / viewBox[0] * width, y1: y + first[1] / viewBox[1] * height, x2: x + last[0] / viewBox[0] * width, y2: y + last[1] / viewBox[1] * height }
    }
  }
  return { x1: x, y1: y, x2: x + width, y2: y + height }
}
function wrapSvgText(value: string, width: number, size: number): string[] {
  const maxCharacters = Math.max(1, Math.floor(width / Math.max(6, size * 0.58)))
  return value.split(/\r?\n/).flatMap((line) => {
    if (!line) return ['']
    const words = line.includes(' ') ? line.split(/(\s+)/) : Array.from(line)
    const lines: string[] = []
    let current = ''
    for (const word of words) {
      if (current && current.length + word.length > maxCharacters) {
        lines.push(current.trimEnd())
        current = word.trimStart()
      } else current += word
    }
    if (current || lines.length === 0) lines.push(current.trimEnd())
    return lines
  })
}
function textAlignment(value: unknown): 'left' | 'center' | 'right' {
  const candidate = Array.isArray(value) ? value[0] : value
  return candidate === 'center' || candidate === 'right' ? candidate : 'left'
}
function textVerticalAlignment(value: unknown): 'top' | 'middle' | 'bottom' {
  return value === 'bottom' ? 'bottom' : value === 'middle' || value === 'mid' || value === 'center' ? 'middle' : 'top'
}
function number(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }
function clamped(value: unknown, min: number, max: number, fallback: number): number { return Math.max(min, Math.min(max, number(value, fallback))) }
function svgColor(value: unknown, fallback: string): string { return typeof value === 'string' && /^#(?:[\da-f]{3,8})$/i.test(value) ? value : fallback }
function escapeXml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char] ?? char)) }
