import PptxGenJS from 'pptxgenjs'
import type { PptdElement, PptdProject } from './types'
import { pageInches, toPptxBounds } from './geometry'
import { chartPptxData, chartToSvg, getPptdChartSpec, isImagePptdChartType, isNativePptdChartType, svgDataUri } from './chart'
import { createPptdDegradationReport, type PptdDegradationReport } from './report'
import { pptdMediaDataUrl } from './media'
import { validatePptdProject } from './validate'
import { pptdAbsoluteLinePoints, pptdLineArrow } from './line'

export interface PptdExportResult { blob: Blob; degradations: string[]; report: PptdDegradationReport }

const POINTS_PER_INCH = 72
const CSS_PIXELS_PER_INCH = 96
const CSS_PX_TO_PT = POINTS_PER_INCH / CSS_PIXELS_PER_INCH

/**
 * Only defects that leave nothing worth writing block the download. Layout
 * diagnostics — overlap, out-of-bounds, duplicate ids — describe an imperfect
 * deck, not an unexportable one, and every element path below already degrades
 * gracefully. They travel in the degradation report instead, so the user still
 * gets a file and still learns what was wrong. The model-facing review loop in
 * `review.ts` keeps treating every error as a repair trigger.
 */
const EXPORT_BLOCKING_CODES = new Set(['empty-pages'])

export async function exportPptdAsPptx(project: PptdProject): Promise<PptdExportResult> {
  const validation = validatePptdProject(project)
  const blocking = validation.errors.filter((item) => EXPORT_BLOCKING_CODES.has(item.code ?? ''))
  if (blocking.length > 0) {
    throw new Error(`PPTD 校验失败，已阻止导出：\n${blocking.map((item) => `${item.path}: ${item.message}`).join('\n')}`)
  }
  const presentation = new PptxGenJS()
  const [width, height] = pageInches(project.size)
  presentation.defineLayout({ name: 'PPTD', width, height })
  presentation.layout = 'PPTD'
  presentation.title = project.title
  presentation.author = 'Solidify'
  const degradations: string[] = validation.errors
    .filter((item) => !EXPORT_BLOCKING_CODES.has(item.code ?? ''))
    .map((item) => `校验：${item.path}: ${item.message}`)
  for (const [pageIndex, page] of project.pages.entries()) {
    const slide = presentation.addSlide()
    await applyBackground(slide, page.background, project, pageIndex, degradations, width, height)
    if (page.animations !== undefined) degradations.push(`第 ${pageIndex + 1} 页 animations 已丢弃（PPTX 导出不支持）`)
    for (const element of orderedElements(page.elements)) {
      if (element.animation !== undefined || element.animations !== undefined) degradations.push(`第 ${pageIndex + 1} 页 "${element.elementId}" 的动画已丢弃（PPTX 导出不支持）`)
      await renderElement(slide, element, project, presentation, degradations, pageIndex)
    }
  }
  const blob = await presentation.write({ outputType: 'blob' }) as Blob
  return { blob, degradations, report: createPptdDegradationReport(project.title, degradations) }
}

async function applyBackground(slide: PptxGenJS.Slide, background: Record<string, unknown> | undefined, project: PptdProject, pageIndex: number, degradations: string[], width: number, height: number) {
  const stops = Array.isArray(background?.stops) ? background.stops : []
  const firstStop = stops[0] && typeof stops[0] === 'object' ? (stops[0] as Record<string, unknown>).color : undefined
  const sourceColor = background?.color ?? firstStop ?? project.theme.colors.bg ?? '#ffffff'
  const color = normalizeColor(sourceColor, '#ffffff', (value) => degradations.push(`第 ${pageIndex + 1} 页背景颜色 ${JSON.stringify(value)} 不是受支持的 hex 格式，已回退为 #FFFFFF`))
  slide.background = { color }
  if (background?.type === 'image') {
    const path = typeof background.src === 'string' ? background.src : undefined
    const media = path ? pptdMediaDataUrl(project.media[path], path) : undefined
    if (!media) {
      degradations.push(`第 ${pageIndex + 1} 页背景图片不可用，已回退为纯色 #${color}`)
      return
    }
    const fit = record(background.fit)
    slide.addImage({
      data: media, x: 0, y: 0, w: width, h: height,
      sizing: { type: fit.mode === 'contain' ? 'contain' : 'cover', w: width, h: height },
    })
    return
  }
  if (background?.type === 'gradient') degradations.push(`第 ${pageIndex + 1} 页背景渐变已转为纯色 #${color}`)
}

async function renderElement(slide: PptxGenJS.Slide, element: PptdElement, project: PptdProject, presentation: PptxGenJS, degradations: string[], pageIndex: number) {
  const [x, y, w, h] = toPptxBounds(element.bounds)
  const content = element.content ?? {}
  const degrade = (message: string) => degradations.push(`第 ${pageIndex + 1} 页 "${element.elementId}" ${message}`)
  if (element.elementType === 'text') {
    const style = resolveStyle(content, project)
    const runs = richTextRuns(typeof content.text === 'string' ? content.text : '', (value) => degrade(`富文本颜色 ${JSON.stringify(value)} 不是受支持的 hex 格式，已回退为 #000000`))
    const alignment = Array.isArray(content.align) ? content.align : [content.align, content.valign]
    const textFill = style.fill && typeof style.fill === 'object' ? style.fill as Record<string, unknown> : undefined
    const textStops = Array.isArray(textFill?.stops) ? textFill.stops : []
    const textFallback = textStops[0] && typeof textStops[0] === 'object' ? (textStops[0] as Record<string, unknown>).color : undefined
    const requestedFontSize = number(style.fontSize, 18)
    const lineHeight = number(style.lineHeight, 1)
    const fontSize = fittedFontSize(requestedFontSize, w * POINTS_PER_INCH, h * POINTS_PER_INCH, lineHeight, runs)
    const lineHeightPx = positiveNumber(style.lineHeightPx)
    const lineSpacing = lineHeightPx === undefined ? fontSize * lineHeight : lineHeightPx * CSS_PX_TO_PT
    const textColorSource = textFallback ?? style.color ?? '#000000'
    const textColor = normalizeColor(textColorSource, '#000000', (value) => degrade(`文字颜色 ${JSON.stringify(value)} 不是受支持的 hex 格式，已回退为 #000000`))
    if (fontSize < requestedFontSize - 0.5) degrade(`字号由 ${requestedFontSize}pt 自动缩至 ${fontSize.toFixed(1)}pt 以避免溢出`)
    if (textFill?.type === 'gradient') degrade(`文字渐变已转为纯色 ${String(textFallback ?? style.color ?? '#000000')}`)
    slide.addText(runs.length > 0 ? runs : [{ text: '', options: {} }], {
      x, y, w, h, fontSize, fontFace: string(style.fontFamily) ?? 'Arial',
      color: textColor, bold: Boolean(style.bold), italic: Boolean(style.italic),
      align: string(alignment[0]) as 'left' | 'center' | 'right' | undefined,
      valign: pptxVAlign(alignment[1]), margin: 0,
      charSpacing: number(style.letterSpacing, 0), lineSpacing, paraSpaceBefore: 0, paraSpaceAfter: 0, fit: 'shrink',
      shadow: pptxShadow(style.shadow, (value) => degrade(`阴影颜色 ${JSON.stringify(value)} 不是受支持的 hex 格式，已回退为 #000000`)),
      rotate: elementRotation(element),
    } as never)
    return
  }
  if (element.elementType === 'image') {
    const media = typeof element.src === 'string' ? pptdMediaDataUrl(project.media[element.src], element.src) : undefined
    if (typeof media === 'string' && media.startsWith('data:')) {
      const crop = cropRect(element)
      const cropped = crop ? await preCropDataUrl(media, crop) : media
      if (crop && cropped === media) degrade('图片裁剪不可用，已使用原图')
      const fit = record(element.fit)
      slide.addImage({
        data: cropped, x, y, w, h,
        sizing: { type: fit.mode === 'cover' ? 'cover' : 'contain', w, h },
        rotate: elementRotation(element), transparency: opacityTransparency(element.opacity),
      })
    }
    else { degrade('图片源不可用，已使用占位符'); slide.addText('[image]', { x, y, w, h, align: 'center', valign: 'mid', color: '666666' } as never) }
    return
  }
  if (element.elementType === 'line') {
    const stroke = lineStroke(element)
    const lineColor = normalizeColor(stroke.color ?? '#000000', '#000000', (value) => degrade(`线条颜色 ${JSON.stringify(value)} 不是受支持的 hex 格式，已回退为 #000000`))
    const points = pptdAbsoluteLinePoints(element)
    const hasExplicitPoints = Array.isArray((element as Record<string, unknown>).points)
      || typeof (element as Record<string, unknown>).points === 'string'
    const beginArrowType = pptxArrowType(pptdLineArrow(element, 'start'))
    const endArrowType = pptxArrowType(pptdLineArrow(element, 'end'))
    for (let index = 1; index < points.length; index++) {
      const [startX, startY] = points[index - 1]
      const [endX, endY] = points[index]
      slide.addShape(presentation.ShapeType.line, {
        x: startX / 96, y: startY / 96, w: (endX - startX) / 96, h: (endY - startY) / 96,
        rotate: hasExplicitPoints ? undefined : elementRotation(element),
        line: {
          color: lineColor, width: number(stroke.width, 1), transparency: opacityTransparency(element.opacity),
          beginArrowType: index === 1 ? beginArrowType : undefined,
          endArrowType: index === points.length - 1 ? endArrowType : undefined,
        },
      } as never)
    }
    return
  }
  if (element.elementType === 'table') {
    const rows = Array.isArray(element.rows) ? element.rows : []
    const tableStyle = record(element.style)
    const tableRows = rows.map((row) => {
      if (!Array.isArray(row)) return [{ text: String(row), options: {} }]
      return row.map((cell) => {
        const value = cellRecord(cell)
        const style = value.style ?? {}
        return {
          text: String(value.text ?? ''),
          options: {
            bold: Boolean(style.bold),
            color: normalizeColor(style.color ?? tableStyle.bodyColor ?? '#000000', '#000000', (invalid) => degrade(`表格文字颜色 ${JSON.stringify(invalid)} 不是受支持的 hex 格式，已回退为 #000000`)),
            fill: style.backgroundColor ? { color: normalizeColor(style.backgroundColor, '#FFFFFF', (invalid) => degrade(`表格填充颜色 ${JSON.stringify(invalid)} 不是受支持的 hex 格式，已回退为 #FFFFFF`)) } : undefined,
            align: Array.isArray(style.align) ? style.align[0] : style.align,
            valign: pptxVAlign(Array.isArray(style.align) ? style.align[1] : undefined),
          },
        }
      })
    })
    const columnWidths = scaledRatios(element.columnWidths, w)
    const rowHeights = scaledRatios(element.rowHeights, h)
    slide.addTable(tableRows as never, {
      x, y, w, h, border: { type: 'solid', color: normalizeColor(tableStyle.borderColor ?? '#999999'), pt: 1 },
      fontSize: number(tableStyle.fontSize ?? element.fontSize, 12),
      colW: columnWidths.length > 0 ? columnWidths : undefined,
      rowH: rowHeights.length > 0 ? rowHeights : undefined,
    } as never)
    return
  }
  if (element.elementType === 'chart') {
    const spec = getPptdChartSpec(element)
    if (isNativePptdChartType(spec.chartType)) {
      const chartType = presentation.ChartType[spec.chartType]
      slide.addChart(chartType, chartPptxData(spec), { x, y, w, h, showLegend: spec.series.length > 1, showTitle: Boolean(spec.title), title: spec.title, catAxisLabelFontSize: 10, valAxisLabelFontSize: 10, showValue: false } as never)
    } else if (isImagePptdChartType(spec.chartType)) {
      degrade(`${spec.chartType} 已作为静态图片导出`)
      slide.addImage({ data: svgDataUri(chartToSvg(spec, element.bounds[2], element.bounds[3])), x, y, w, h })
    } else {
      degrade(`不支持的图表类型 ${spec.chartType}`)
      slide.addText(`[${spec.chartType} chart]`, { x, y, w, h, align: 'center', valign: 'mid', color: '666666' } as never)
    }
    return
  }
  if (element.elementType === 'icon') {
    degrade(`${element.elementType} 已使用文本占位符导出`)
    slide.addText(String(element.icon ?? '•'), { x, y, w, h, align: 'center', valign: 'mid', color: '666666' } as never)
    return
  }
  const fill = (element.fill ?? {}) as Record<string, unknown>
  const shapeName = element.shapeName ?? 'rect'
  const shape = shapeName === 'ellipse' ? presentation.ShapeType.ellipse : shapeName === 'roundRect' ? presentation.ShapeType.roundRect : shapeName === 'triangle' ? presentation.ShapeType.triangle : shapeName === 'arrow' ? presentation.ShapeType.rightArrow : presentation.ShapeType.rect
  if (!['rect', 'ellipse', 'roundRect', 'triangle', 'arrow'].includes(shapeName)) degrade(`${shapeName} 已降级为矩形`)
  if (fill.type === 'gradient') degrade('渐变填充已转为第一个色标的纯色')
  const firstStop = Array.isArray(fill.stops) ? (fill.stops[0] as Record<string, unknown> | undefined)?.color : undefined
  const fillValue = fill.color ?? firstStop ?? 'FFFFFF'
  const fillColor = normalizeColor(fillValue, '#FFFFFF', (value) => degrade(`填充颜色 ${JSON.stringify(value)} 不是受支持的 hex 格式，已回退为 #FFFFFF`))
  const strokeValue = ((element.stroke ?? {}) as Record<string, unknown>).color ?? '#000000'
  const strokeColor = normalizeColor(strokeValue, '#000000', (value) => degrade(`边框颜色 ${JSON.stringify(value)} 不是受支持的 hex 格式，已回退为 #000000`))
  slide.addShape(shape, { x, y, w, h, rotate: elementRotation(element), fill: { color: fillColor, transparency: fill.type === 'none' ? 100 : combinedTransparency(fillValue, element.opacity) }, line: { color: strokeColor }, shadow: pptxShadow(element.shadow, (value) => degrade(`阴影颜色 ${JSON.stringify(value)} 不是受支持的 hex 格式，已回退为 #000000`)) } as never)
}

function resolveStyle(content: Record<string, unknown>, project: PptdProject): Record<string, unknown> {
  // Exact `$title` tokens are expanded by the parser into style objects;
  // direct PPTD files may still use a string style name.
  const named = typeof content.style === 'string' ? project.theme.textStyles[content.style] : record(content.style)
  return { ...(named ?? {}), ...content }
}

function richTextRuns(value: string, onInvalidColor?: (value: unknown) => void): Array<{ text: string; options: Record<string, unknown> }> {
  if (typeof DOMParser === 'undefined' || !/[<][a-z]/i.test(value)) {
    const lines = value.split(/\r?\n/)
    return value ? lines.map((text, index) => ({ text, options: index < lines.length - 1 ? { breakLine: true } : {} })) : []
  }
  const document = new DOMParser().parseFromString(`<div>${value}</div>`, 'text/html')
  const runs: Array<{ text: string; options: Record<string, unknown> }> = []
  const breakLine = () => {
    const previous = runs[runs.length - 1]
    if (previous) previous.options.breakLine = true
    else runs.push({ text: '', options: { breakLine: true } })
  }
  const visit = (node: Node, options: Record<string, unknown>) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.parentElement?.tagName === 'DIV' && !node.textContent?.trim()) return
      if (node.textContent) runs.push({ text: node.textContent, options: { ...options } })
      return
    }
    if (!(node instanceof Element)) return
    const next = { ...options }
    const tag = node.tagName.toLowerCase()
    if (tag === 'p' && runs.length > 0) breakLine()
    if (tag === 'br') { breakLine(); return }
    if (tag === 'strong' || tag === 'b') next.bold = true
    if (tag === 'em' || tag === 'i') next.italic = true
    if (tag === 'u') next.underline = { style: 'sng' }
    if (tag === 's') next.strike = true
    if (tag === 'span') Object.assign(next, parseInlineStyle(node.getAttribute('style'), onInvalidColor))
    node.childNodes.forEach((child) => visit(child, next))
  }
  document.body.firstElementChild?.childNodes.forEach((node) => visit(node, {}))
  return runs
}

interface CropRect { x: number; y: number; width: number; height: number }

function cropRect(element: PptdElement): CropRect | undefined {
  const fit = element.fit as Record<string, unknown> | undefined
  const crop = (fit?.crop ?? element.crop) as Record<string, unknown> | undefined
  if (!crop) return undefined
  const x = number(crop.x, 0)
  const y = number(crop.y, 0)
  const width = number(crop.width, 1)
  const height = number(crop.height, 1)
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) return undefined
  return { x, y, width, height }
}

async function preCropDataUrl(source: string, crop: CropRect): Promise<string> {
  if (typeof Image === 'undefined' || typeof document === 'undefined') return source
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.naturalWidth * crop.width))
      canvas.height = Math.max(1, Math.round(image.naturalHeight * crop.height))
      const context = canvas.getContext('2d')
      if (!context) return resolve(source)
      context.drawImage(image, image.naturalWidth * crop.x, image.naturalHeight * crop.y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/png'))
    }
    image.onerror = () => resolve(source)
    image.src = source
  })
}

function parseInlineStyle(value: string | null, onInvalidColor?: (value: unknown) => void): Record<string, unknown> {
  if (!value) return {}
  const result: Record<string, unknown> = {}
  for (const declaration of value.split(';')) {
    const [property, raw] = declaration.split(':', 2)
    const normalized = raw?.trim()
    if (!normalized) continue
    if (property.trim() === 'color') result.color = normalizeColor(normalized, '#000000', onInvalidColor)
    if (property.trim() === 'font-weight' && normalized === 'bold') result.bold = true
    if (property.trim() === 'font-style' && normalized === 'italic') result.italic = true
  }
  return result
}

function cellRecord(value: unknown): { text?: unknown; style?: Record<string, unknown> } {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const cell = value as Record<string, unknown>
    const content = record(cell.content)
    return { text: content.text ?? cell.text, style: { ...record(cell.style), ...content } }
  }
  return { text: value }
}

function lineStroke(element: PptdElement): Record<string, unknown> {
  return record(element.stroke ?? element.border)
}

function pptxArrowType(value: string | undefined): 'none' | 'arrow' | 'diamond' | 'oval' | 'stealth' | 'triangle' | undefined {
  if (!value || value === 'none') return undefined
  return ['arrow', 'diamond', 'oval', 'stealth', 'triangle'].includes(value)
    ? value as 'arrow' | 'diamond' | 'oval' | 'stealth' | 'triangle'
    : 'triangle'
}

function orderedElements(elements: readonly PptdElement[]): PptdElement[] {
  if (!elements.some((element) => Number.isFinite(element.zIndex))) return [...elements]
  return elements.map((element, index) => ({ element, index })).sort((left, right) => {
    const z = number(left.element.zIndex, 0) - number(right.element.zIndex, 0)
    return z || left.index - right.index
  }).map(({ element }) => element)
}

function scaledRatios(value: unknown, total: number): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'number' || !Number.isFinite(item) || item <= 0)) return []
  const sum = value.reduce((result, item) => result + item, 0)
  return value.map((item) => total * item / sum)
}

function elementRotation(element: PptdElement): number | undefined {
  const value = typeof element.rotation === 'number' ? element.rotation : element.rotate
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function opacityTransparency(value: unknown): number {
  const opacity = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
  return Math.round((1 - opacity) * 100)
}

function combinedTransparency(color: unknown, opacity: unknown): number {
  const colorOpacity = 1 - colorTransparency(color) / 100
  return Math.round((1 - colorOpacity * (1 - opacityTransparency(opacity) / 100)) * 100)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function pptxShadow(value: unknown, onInvalidColor?: (value: unknown) => void): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const shadow = value as Record<string, unknown>
  return { type: 'outer', color: normalizeColor(shadow.color ?? '#000000', '#000000', onInvalidColor), opacity: number(shadow.opacity, 0.25), blur: number(shadow.blur, 4), angle: number(shadow.angle, 45), distance: number(shadow.distance, 2) }
}

function fittedFontSize(requested: number, width: number, height: number, lineHeight: number, runs: Array<{ text: string; options: Record<string, unknown> }>): number {
  const explicitLines = 1 + runs.filter((run) => run.options.breakLine === true).length
  const characters = runs.reduce((sum, run) => sum + run.text.replace(/\s+/g, '').length, 0)
  const estimatedPerLine = Math.max(1, Math.floor(width / Math.max(1, requested * 0.72)))
  const estimatedLines = Math.max(explicitLines, Math.ceil(characters / estimatedPerLine))
  const safeMaximum = height / Math.max(1, estimatedLines * Math.max(0.8, lineHeight) * 1.25)
  return Math.max(6, Math.min(requested, safeMaximum))
}

function normalizeColor(value: unknown, fallback = '#000000', onInvalid?: (value: unknown) => void): string {
  const normalized = parseHexColor(value)
  if (normalized) return normalized.slice(0, 6)
  onInvalid?.(value)
  return parseHexColor(fallback)?.slice(0, 6) ?? '000000'
}

function parseHexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  let hex = value.trim().replace(/^#/, '')
  if (!/^(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) return undefined
  if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((char) => `${char}${char}`).join('')
  return hex.toUpperCase()
}
function colorTransparency(value: unknown): number {
  const hex = parseHexColor(value)
  if (!hex || hex.length !== 8) return 0
  return Math.max(0, Math.min(100, Math.round((1 - Number.parseInt(hex.slice(6, 8), 16) / 255) * 100)))
}
function number(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }
function positiveNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined }
function string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
function pptxVAlign(value: unknown): 'top' | 'mid' | 'bottom' | undefined {
  if (value === 'top') return 'top'
  if (value === 'bottom') return 'bottom'
  if (value === 'mid' || value === 'middle' || value === 'center') return 'mid'
  return undefined
}
