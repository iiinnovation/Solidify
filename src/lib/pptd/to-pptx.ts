import PptxGenJS from 'pptxgenjs'
import type { PptdElement, PptdProject } from './types'
import { pageInches, toPptxBounds } from './geometry'

export interface PptdExportResult { blob: Blob; degradations: string[] }

export async function exportPptdAsPptx(project: PptdProject): Promise<PptdExportResult> {
  const presentation = new PptxGenJS()
  const [width, height] = pageInches(project.size)
  presentation.defineLayout({ name: 'PPTD', width, height })
  presentation.layout = 'PPTD'
  presentation.title = project.title
  presentation.author = 'Solidify'
  const degradations: string[] = []
  for (const page of project.pages) {
    const slide = presentation.addSlide()
    applyBackground(slide, page.background, project)
    for (const element of page.elements) renderElement(slide, element, project, presentation, degradations)
  }
  const blob = await presentation.write({ outputType: 'blob' }) as Blob
  return { blob, degradations }
}

function applyBackground(slide: PptxGenJS.Slide, background: Record<string, unknown> | undefined, project: PptdProject) {
  const color = normalizeColor(background?.color ?? project.theme.colors.bg ?? '#ffffff')
  slide.background = { color }
  if (background?.type === 'gradient') {
    // PPTX gradients vary by renderer; preserve a deterministic solid fallback.
  }
}

function renderElement(slide: PptxGenJS.Slide, element: PptdElement, project: PptdProject, presentation: PptxGenJS, degradations: string[]) {
  const [x, y, w, h] = toPptxBounds(element.bounds)
  const content = element.content ?? {}
  if (element.elementType === 'text') {
    const style = resolveStyle(content, project)
    const runs = richTextRuns(typeof content.text === 'string' ? content.text : '')
    slide.addText(runs.length > 0 ? runs : [{ text: '', options: {} }], {
      x, y, w, h, fontSize: number(style.fontSize, 18), fontFace: string(style.fontFamily),
      color: normalizeColor(style.color ?? '#000000'), bold: Boolean(style.bold), italic: Boolean(style.italic),
      align: string(content.align) as 'left' | 'center' | 'right' | undefined,
      valign: string(content.valign) as 'top' | 'mid' | 'bottom' | undefined, margin: 0,
    } as never)
    return
  }
  if (element.elementType === 'image') {
    const media = typeof element.src === 'string' ? project.media[element.src] : undefined
    if (typeof media === 'string' && media.startsWith('data:')) slide.addImage({ data: media, x, y, w, h })
    else { degradations.push(`${element.elementId}: image source unavailable`); slide.addText('[image]', { x, y, w, h, align: 'center', valign: 'mid', color: '666666' } as never) }
    return
  }
  if (element.elementType === 'line') {
    const stroke = (element.stroke ?? {}) as Record<string, unknown>
    slide.addShape(presentation.ShapeType.line, { x, y, w, h, line: { color: normalizeColor(stroke.color ?? '#000000'), width: number(stroke.width, 1) } } as never)
    return
  }
  if (element.elementType === 'table') {
    const rows = Array.isArray(element.rows) ? element.rows : []
    slide.addTable(rows.map((row) => (Array.isArray(row) ? row.map(String) : [String(row)])) as never, { x, y, w, h, border: { type: 'solid', color: '999999', pt: 1 }, fontSize: number(element.fontSize, 12) } as never)
    return
  }
  if (element.elementType === 'icon' || element.elementType === 'chart') {
    degradations.push(`${element.elementId}: ${element.elementType} rendered as placeholder`)
    slide.addText(element.elementType === 'icon' ? String(element.icon ?? '•') : `${String(element.chartType ?? 'chart')} chart`, { x, y, w, h, align: 'center', valign: 'mid', color: '666666' } as never)
    return
  }
  const fill = (element.fill ?? {}) as Record<string, unknown>
  const shape = element.shapeName === 'ellipse' ? presentation.ShapeType.ellipse : element.shapeName === 'roundRect' ? presentation.ShapeType.roundRect : presentation.ShapeType.rect
  if (fill.type === 'gradient') degradations.push(`${element.elementId}: gradient fill flattened to first stop`)
  const firstStop = Array.isArray(fill.stops) ? (fill.stops[0] as Record<string, unknown> | undefined)?.color : undefined
  slide.addShape(shape, { x, y, w, h, fill: { color: normalizeColor(fill.color ?? firstStop ?? 'FFFFFF'), transparency: fill.type === 'none' ? 100 : 0 }, line: { color: normalizeColor(((element.stroke ?? {}) as Record<string, unknown>).color ?? '000000') } } as never)
}

function resolveStyle(content: Record<string, unknown>, project: PptdProject): Record<string, unknown> {
  const named = typeof content.style === 'string' ? project.theme.textStyles[content.style] : undefined
  return { ...(named ?? {}), ...content }
}

function richTextRuns(value: string): Array<{ text: string; options: Record<string, unknown> }> {
  if (typeof DOMParser === 'undefined' || !/[<][a-z]/i.test(value)) return value ? [{ text: value, options: {} }] : []
  const document = new DOMParser().parseFromString(`<div>${value}</div>`, 'text/html')
  const runs: Array<{ text: string; options: Record<string, unknown> }> = []
  const visit = (node: Node, options: Record<string, unknown>) => {
    if (node.nodeType === Node.TEXT_NODE) { if (node.textContent) runs.push({ text: node.textContent, options: { ...options } }); return }
    if (!(node instanceof Element)) return
    const next = { ...options }
    const tag = node.tagName.toLowerCase()
    if (tag === 'br' || tag === 'p') { if (runs.length > 0 && tag === 'p') runs.push({ text: '\n', options: {} }); if (tag === 'br') runs.push({ text: '\n', options: {} }) }
    if (tag === 'strong' || tag === 'b') next.bold = true
    if (tag === 'em' || tag === 'i') next.italic = true
    if (tag === 'u') next.underline = { style: 'sng' }
    if (tag === 's') next.strike = true
    node.childNodes.forEach((child) => visit(child, next))
  }
  document.body.firstElementChild?.childNodes.forEach((node) => visit(node, {}))
  return runs
}

function normalizeColor(value: unknown): string { return String(value ?? '#000000').replace(/^#/, '').slice(0, 6).padEnd(6, '0') }
function number(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }
function string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
