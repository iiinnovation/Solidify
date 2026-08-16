import PptxGenJS from 'pptxgenjs'
import type { PptdElement, PptdProject } from './types'
import { pageInches, toPptxBounds } from './geometry'
import { chartPptxData, chartToSvg, getPptdChartSpec, isImagePptdChartType, isNativePptdChartType, svgDataUri } from './chart'
import { createPptdDegradationReport, type PptdDegradationReport } from './report'
import { pptdMediaDataUrl } from './media'

export interface PptdExportResult { blob: Blob; degradations: string[]; report: PptdDegradationReport }

export async function exportPptdAsPptx(project: PptdProject): Promise<PptdExportResult> {
  const presentation = new PptxGenJS()
  const [width, height] = pageInches(project.size)
  presentation.defineLayout({ name: 'PPTD', width, height })
  presentation.layout = 'PPTD'
  presentation.title = project.title
  presentation.author = 'Solidify'
  const degradations: string[] = []
  for (const [pageIndex, page] of project.pages.entries()) {
    const slide = presentation.addSlide()
    applyBackground(slide, page.background, project, pageIndex, degradations)
    if (page.animations !== undefined) degradations.push(`第 ${pageIndex + 1} 页 animations 已丢弃（PPTX 导出不支持）`)
    for (const element of page.elements) {
      if (element.animation !== undefined || element.animations !== undefined) degradations.push(`第 ${pageIndex + 1} 页 "${element.elementId}" 的动画已丢弃（PPTX 导出不支持）`)
      await renderElement(slide, element, project, presentation, degradations, pageIndex)
    }
  }
  const blob = await presentation.write({ outputType: 'blob' }) as Blob
  return { blob, degradations, report: createPptdDegradationReport(project.title, degradations) }
}

function applyBackground(slide: PptxGenJS.Slide, background: Record<string, unknown> | undefined, project: PptdProject, pageIndex: number, degradations: string[]) {
  const stops = Array.isArray(background?.stops) ? background.stops : []
  const firstStop = stops[0] && typeof stops[0] === 'object' ? (stops[0] as Record<string, unknown>).color : undefined
  const color = normalizeColor(background?.color ?? firstStop ?? project.theme.colors.bg ?? '#ffffff')
  slide.background = { color }
  if (background?.type === 'gradient') degradations.push(`第 ${pageIndex + 1} 页背景渐变已转为纯色 #${color}`)
}

async function renderElement(slide: PptxGenJS.Slide, element: PptdElement, project: PptdProject, presentation: PptxGenJS, degradations: string[], pageIndex: number) {
  const [x, y, w, h] = toPptxBounds(element.bounds)
  const content = element.content ?? {}
  const degrade = (message: string) => degradations.push(`第 ${pageIndex + 1} 页 "${element.elementId}" ${message}`)
  if (element.elementType === 'text') {
    const style = resolveStyle(content, project)
    const runs = richTextRuns(typeof content.text === 'string' ? content.text : '')
    const alignment = Array.isArray(content.align) ? content.align : [content.align, content.valign]
    const textFill = style.fill && typeof style.fill === 'object' ? style.fill as Record<string, unknown> : undefined
    const textStops = Array.isArray(textFill?.stops) ? textFill.stops : []
    const textFallback = textStops[0] && typeof textStops[0] === 'object' ? (textStops[0] as Record<string, unknown>).color : undefined
    const requestedFontSize = number(style.fontSize, 18)
    const lineHeight = number(style.lineHeight, 1)
    const fontSize = fittedFontSize(requestedFontSize, w * 96, h * 96, lineHeight, runs)
    const lineSpacing = number(style.lineHeightPx, 0) || fontSize * lineHeight
    if (fontSize < requestedFontSize - 0.5) degrade(`字号由 ${requestedFontSize}pt 自动缩至 ${fontSize.toFixed(1)}pt 以避免溢出`)
    if (textFill?.type === 'gradient') degrade(`文字渐变已转为纯色 ${String(textFallback ?? style.color ?? '#000000')}`)
    slide.addText(runs.length > 0 ? runs : [{ text: '', options: {} }], {
      x, y, w, h, fontSize, fontFace: string(style.fontFamily) ?? 'Arial',
      color: normalizeColor(textFallback ?? style.color ?? '#000000'), bold: Boolean(style.bold), italic: Boolean(style.italic),
      align: string(alignment[0]) as 'left' | 'center' | 'right' | undefined,
      valign: string(alignment[1]) as 'top' | 'mid' | 'bottom' | undefined, margin: 0,
      charSpacing: number(style.letterSpacing, 0), lineSpacing, paraSpaceBefore: 0, paraSpaceAfter: 0, fit: 'shrink',
      shadow: pptxShadow(style.shadow),
    } as never)
    return
  }
  if (element.elementType === 'image') {
    const media = typeof element.src === 'string' ? pptdMediaDataUrl(project.media[element.src], element.src) : undefined
    if (typeof media === 'string' && media.startsWith('data:')) {
      const crop = cropRect(element)
      const cropped = crop ? await preCropDataUrl(media, crop) : media
      if (crop && cropped === media) degrade('图片裁剪不可用，已使用原图')
      slide.addImage({ data: cropped, x, y, w, h })
    }
    else { degrade('图片源不可用，已使用占位符'); slide.addText('[image]', { x, y, w, h, align: 'center', valign: 'mid', color: '666666' } as never) }
    return
  }
  if (element.elementType === 'line') {
    const stroke = (element.stroke ?? {}) as Record<string, unknown>
    slide.addShape(presentation.ShapeType.line, { x, y, w, h, line: { color: normalizeColor(stroke.color ?? '#000000'), width: number(stroke.width, 1) } } as never)
    return
  }
  if (element.elementType === 'table') {
    const rows = Array.isArray(element.rows) ? element.rows : []
    const tableRows = rows.map((row) => {
      if (!Array.isArray(row)) return [{ text: String(row), options: {} }]
      return row.map((cell) => {
        const value = cellRecord(cell)
        const style = value.style ?? {}
        return {
          text: String(value.text ?? ''),
          options: {
            bold: Boolean(style.bold),
            color: style.color ? normalizeColor(style.color) : undefined,
            fill: style.backgroundColor ? { color: normalizeColor(style.backgroundColor) } : undefined,
          },
        }
      })
    })
    slide.addTable(tableRows as never, { x, y, w, h, border: { type: 'solid', color: '999999', pt: 1 }, fontSize: number(element.fontSize, 12) } as never)
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
  slide.addShape(shape, { x, y, w, h, fill: { color: normalizeColor(fillValue), transparency: fill.type === 'none' ? 100 : colorTransparency(fillValue) }, line: { color: normalizeColor(((element.stroke ?? {}) as Record<string, unknown>).color ?? '000000') }, shadow: pptxShadow(element.shadow) } as never)
}

function resolveStyle(content: Record<string, unknown>, project: PptdProject): Record<string, unknown> {
  const named = typeof content.style === 'string' ? project.theme.textStyles[content.style] : undefined
  return { ...(named ?? {}), ...content }
}

function richTextRuns(value: string): Array<{ text: string; options: Record<string, unknown> }> {
  if (typeof DOMParser === 'undefined' || !/[<][a-z]/i.test(value)) return value ? [{ text: value, options: {} }] : []
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
    if (tag === 'span') Object.assign(next, parseInlineStyle(node.getAttribute('style')))
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

function parseInlineStyle(value: string | null): Record<string, unknown> {
  if (!value) return {}
  const result: Record<string, unknown> = {}
  for (const declaration of value.split(';')) {
    const [property, raw] = declaration.split(':', 2)
    const normalized = raw?.trim()
    if (!normalized) continue
    if (property.trim() === 'color') result.color = normalizeColor(normalized)
    if (property.trim() === 'font-weight' && normalized === 'bold') result.bold = true
    if (property.trim() === 'font-style' && normalized === 'italic') result.italic = true
  }
  return result
}

function cellRecord(value: unknown): { text?: unknown; style?: Record<string, unknown> } {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as { text?: unknown; style?: Record<string, unknown> }
  return { text: value }
}

function pptxShadow(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const shadow = value as Record<string, unknown>
  return { type: 'outer', color: normalizeColor(shadow.color ?? '#000000'), opacity: number(shadow.opacity, 0.25), blur: number(shadow.blur, 4), angle: number(shadow.angle, 45), distance: number(shadow.distance, 2) }
}

function fittedFontSize(requested: number, width: number, height: number, lineHeight: number, runs: Array<{ text: string; options: Record<string, unknown> }>): number {
  const explicitLines = 1 + runs.filter((run) => run.options.breakLine === true).length
  const characters = runs.reduce((sum, run) => sum + run.text.replace(/\s+/g, '').length, 0)
  const estimatedPerLine = Math.max(1, Math.floor(width / Math.max(1, requested * 0.72)))
  const estimatedLines = Math.max(explicitLines, Math.ceil(characters / estimatedPerLine))
  const safeMaximum = height / Math.max(1, estimatedLines * Math.max(0.8, lineHeight) * 1.25)
  return Math.max(6, Math.min(requested, safeMaximum))
}

function normalizeColor(value: unknown): string {
  let hex = String(value ?? '#000000').replace(/^#/, '').slice(0, 8)
  if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((char) => `${char}${char}`).join('')
  return hex.slice(0, 6).padEnd(6, '0').toUpperCase()
}
function colorTransparency(value: unknown): number {
  let hex = String(value ?? '').replace(/^#/, '')
  if (hex.length === 4) hex = hex.split('').map((char) => `${char}${char}`).join('')
  if (hex.length !== 8) return 0
  return Math.max(0, Math.min(100, Math.round((1 - Number.parseInt(hex.slice(6, 8), 16) / 255) * 100)))
}
function number(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }
function string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
