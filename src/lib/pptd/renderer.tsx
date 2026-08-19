import DOMPurify from 'dompurify'
import { useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import type { PptdElement, PptdProject, PptdTextStyle } from './types'
import { chartToSvg, getPptdChartSpec } from './chart'
import { pptdMediaDataUrl } from './media'
import { pptdLineArrow, pptdLineGeometry } from './line'

export interface PptdRendererProps {
  project: PptdProject
  pageIndex?: number
  className?: string
  showDiagnostics?: boolean
  onSelectElement?: (element: PptdElement) => void
}

export function PptdRenderer({ project, pageIndex = 0, className, showDiagnostics = false, onSelectElement }: PptdRendererProps) {
  const frameRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [width, height] = project.size
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame || typeof ResizeObserver === 'undefined') return
    const update = () => setScale(Math.max(0.01, frame.clientWidth / width))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [width])
  const page = project.pages[Math.max(0, Math.min(pageIndex, project.pages.length - 1))]
  if (!page) return null
  const pageStyle: CSSProperties = {
    position: 'absolute', left: 0, top: 0, width, height, overflow: 'hidden',
    ...resolvePageBackground(page.background, project),
    transform: `scale(${scale})`, transformOrigin: 'top left',
  }
  return (
    <div ref={frameRef} className={className} data-pptd-project={project.title} style={{ position: 'relative', width: '100%', maxWidth: '100%', minWidth: 0, aspectRatio: `${width} / ${height}`, overflow: 'hidden' }}>
      <div style={pageStyle} data-artifact-content data-pptd-page={pageIndex}>
        {orderedElements(page.elements).map((element) => (
          <PptdElementView
            key={element.elementId}
            element={element}
            project={project}
            onClick={onSelectElement}
          />
        ))}
      </div>
      {showDiagnostics && <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/70 px-2 py-1 text-[10px] text-white">{project.title} · {pageIndex + 1}/{project.pages.length}</div>}
    </div>
  )
}

function PptdElementView({ element, project, onClick }: { element: PptdElement; project: PptdProject; onClick?: (element: PptdElement) => void }) {
  const [x, y, width, height] = element.bounds
  const rotation = finiteNumber(element.rotation) ?? finiteNumber(element.rotate)
  const style: CSSProperties = {
    position: 'absolute', left: x, top: y, width, height, boxSizing: 'border-box',
    zIndex: finiteNumber(element.zIndex) ?? 1,
    opacity: clampedNumber(element.opacity, 0, 1, 1),
    transform: rotation === undefined ? undefined : `rotate(${rotation}deg)`,
    transformOrigin: 'center center',
  }
  const handleClick = (event?: MouseEvent) => {
    if (!onClick) return
    event?.stopPropagation()
    onClick(element)
  }
  switch (element.elementType) {
    case 'text': return <TextElement element={element} project={project} style={style} onClick={handleClick} />
    case 'shape': return <ShapeElement element={element} project={project} style={style} onClick={handleClick} />
    case 'image': return <ImageElement element={element} project={project} style={style} onClick={handleClick} />
    case 'line': return <LineElement element={element} project={project} style={style} onClick={handleClick} />
    case 'icon': return <IconElement element={element} project={project} style={style} onClick={handleClick} />
    case 'table': return <TableElement element={element} project={project} style={style} onClick={handleClick} />
    case 'chart': return <ChartElement element={element} project={project} style={style} onClick={handleClick} />
  }
}

function TextElement({ element, project, style, onClick }: ElementRenderProps) {
  const content = element.content ?? {}
  const textStyle = resolveTextStyle(content, project)
  const text = typeof content.text === 'string' ? content.text : ''
  const html = DOMPurify.sanitize(text, { ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'span'], ALLOWED_ATTR: ['style'] })
  const lineHeightPx = finiteNumber(textStyle.lineHeightPx)
  const verticalAlign = verticalAlignment(content.valign ?? (Array.isArray(content.align) ? content.align[1] : undefined))
  const css: CSSProperties = {
    ...style, color: color(textStyle.color, '#000000'), background: resolveTextBackground(textStyle),
    fontFamily: typeof textStyle.fontFamily === 'string' ? textStyle.fontFamily : undefined,
    fontSize: number(textStyle.fontSize, 18), fontWeight: textStyle.bold ? 700 : 400, fontStyle: textStyle.italic ? 'italic' : 'normal',
    lineHeight: lineHeightPx === undefined ? number(textStyle.lineHeight, 1) : `${lineHeightPx}px`, letterSpacing: number(textStyle.letterSpacing, 0),
    textAlign: alignment(content.align, 0), whiteSpace: content.wrap === false ? 'nowrap' : whiteSpace(content.whiteSpace), padding: 0,
    display: 'flex', flexDirection: 'column', justifyContent: verticalAlign,
    textShadow: resolveShadow(textStyle.shadow),
  }
  return <div style={css} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}

function ShapeElement({ element, project, style, onClick }: ElementRenderProps) {
  const fill = resolveFill(element.fill, project)
  const stroke = element.stroke as Record<string, unknown> | undefined
  const shapeName = typeof element.shapeName === 'string' ? element.shapeName : 'rect'
  const css: CSSProperties = { ...style, background: fill, border: stroke ? `${number(stroke.width, 1)}px solid ${color(stroke.color, '#000000')}` : undefined, borderRadius: shapeName === 'ellipse' ? '50%' : shapeName === 'roundRect' ? 12 : undefined, clipPath: shapeName === 'triangle' ? 'polygon(50% 0%, 100% 100%, 0% 100%)' : shapeName === 'arrow' ? 'polygon(0 25%, 60% 25%, 60% 0, 100% 50%, 60% 100%, 60% 75%, 0 75%)' : undefined, boxShadow: resolveShadow(element.shadow) }
  return <div style={css} onClick={onClick} />
}

function ImageElement({ element, project, style, onClick }: ElementRenderProps) {
  const sourcePath = typeof element.src === 'string' ? element.src : undefined
  const media = sourcePath ? project.media[sourcePath] : undefined
  const src = pptdMediaDataUrl(media, sourcePath)
  if (typeof src !== 'string') return <div style={{ ...style, background: '#e5e7eb' }} onClick={onClick} />
  const fit = element.fit && typeof element.fit.mode === 'string' ? element.fit.mode : 'contain'
  const crop = element.fit as Record<string, unknown> | undefined
  return <img src={src} alt="" style={{ ...style, display: 'block', objectFit: fit === 'cover' ? 'cover' : 'contain', objectPosition: typeof crop?.position === 'string' ? crop.position : '50% 50%' }} onClick={onClick} />
}

function LineElement({ element, style, onClick }: ElementRenderProps) {
  const lineStyle = lineStroke(element)
  const geometry = pptdLineGeometry(element)
  const points = geometry.points.map(([x, y]) => `${x},${y}`).join(' ')
  const markerId = `pptd-arrow-${element.elementId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  const arrow = pptdLineArrow(element, 'end')
  const first = geometry.points[0]
  const last = geometry.points.at(-1)
  return <svg style={{ ...style, overflow: 'visible' }} onClick={onClick} viewBox={`0 0 ${geometry.viewBox[0]} ${geometry.viewBox[1]}`} preserveAspectRatio="none">
    {arrow && <defs><marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L8,4 L0,8 Z" fill={color(lineStyle.color, '#000000')} /></marker></defs>}
    {geometry.points.length === 2 && first && last
      ? <line x1={first[0]} y1={first[1]} x2={last[0]} y2={last[1]} stroke={color(lineStyle.color, '#000000')} strokeWidth={number(lineStyle.width, 1)} strokeDasharray={lineStyle.style === 'dashed' || lineStyle.style === 'dash' ? '6 4' : undefined} markerEnd={arrow ? `url(#${markerId})` : undefined} vectorEffect="non-scaling-stroke" />
      : <polyline points={points} fill="none" stroke={color(lineStyle.color, '#000000')} strokeWidth={number(lineStyle.width, 1)} strokeDasharray={lineStyle.style === 'dashed' || lineStyle.style === 'dash' ? '6 4' : undefined} markerEnd={arrow ? `url(#${markerId})` : undefined} vectorEffect="non-scaling-stroke" />}
  </svg>
}

function IconElement({ element, style, onClick }: ElementRenderProps) {
  const name = typeof element.icon === 'string' ? element.icon : typeof element.name === 'string' ? element.name : '•'
  return <div style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center', color: color(element.color, '#000000'), fontSize: number(element.fontSize, 24) }} onClick={onClick}>{name}</div>
}

function TableElement({ element, style, onClick }: ElementRenderProps) {
  const rows = Array.isArray(element.rows) ? element.rows : []
  const tableStyle = record(element.style)
  const columnWidths = normalizedRatios(element.columnWidths, rows.reduce((maximum, row) => Math.max(maximum, Array.isArray(row) ? row.length : 0), 0))
  const rowHeights = normalizedRatios(element.rowHeights, rows.length)
  return <table style={{ ...style, tableLayout: 'fixed', borderCollapse: 'collapse', color: color(tableStyle.bodyColor ?? element.color, '#000000'), fontSize: number(tableStyle.fontSize ?? element.fontSize, 12) }} onClick={onClick}>
    {columnWidths.length > 0 && <colgroup>{columnWidths.map((value, index) => <col key={index} style={{ width: `${value * 100}%` }} />)}</colgroup>}
    <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex} style={rowHeights[rowIndex] ? { height: `${rowHeights[rowIndex] * 100}%` } : undefined}>{(Array.isArray(row) ? row : []).map((cell, cellIndex) => {
    const cellValue = cellRecord(cell)
    const cellStyle = cellValue.style ?? {}
    const cellColor = cellStyle.color ?? (cellIndex === 0 ? tableStyle.firstColumnColor : tableStyle.bodyColor)
    return <td key={cellIndex} style={{ borderBottom: `1px solid ${color(tableStyle.borderColor, '#999999')}`, padding: 4, color: optionalColor(cellColor), background: optionalColor(cellStyle.backgroundColor ?? cellStyle.fill), fontWeight: cellStyle.bold ? 700 : undefined, textAlign: alignment(cellStyle.align, 0), verticalAlign: tableVerticalAlignment(cellStyle.align) }}>{String(cellValue.text ?? '')}</td>
  })}</tr>)}</tbody></table>
}

function ChartElement({ element, style, onClick }: ElementRenderProps) {
  const [width, height] = element.bounds.slice(2) as [number, number]
  const spec = getPptdChartSpec(element)
  const svg = chartToSvg(spec, width, height)
  const safeSvg = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true } })
  return <div data-pptd-chart-type={spec.chartType} style={{ ...style, overflow: 'hidden' }} onClick={onClick} dangerouslySetInnerHTML={{ __html: safeSvg }} />
}

interface ElementRenderProps { element: PptdElement; project: PptdProject; style: CSSProperties; onClick: (event?: MouseEvent) => void }

function resolveTextStyle(content: Record<string, unknown>, project: PptdProject): PptdTextStyle {
  // The parser expands an exact `$title` token to the style object itself,
  // while hand-authored pages may keep `style: title` as a string name.
  const named = typeof content.style === 'string'
    ? project.theme.textStyles[content.style]
    : record(content.style) as PptdTextStyle
  return { ...(named ?? {}), ...content } as PptdTextStyle
}

function resolvePageBackground(background: Record<string, unknown> | undefined, project: PptdProject): CSSProperties {
  const fallback = color(project.theme.colors.bg, '#ffffff')
  if (!background) return { background: fallback }
  if (background.type === 'solid') return { background: color(background.color, fallback) }
  if (background.type === 'gradient') return { background: `linear-gradient(${number(background.angle, 180)}deg, ${gradientStops(background.stops)})` }
  if (background.type === 'image' && typeof background.src === 'string') {
    const source = pptdMediaDataUrl(project.media[background.src], background.src)
    if (source) {
      const fit = record(background.fit)
      return {
        backgroundColor: fallback,
        backgroundImage: `url("${source}")`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: fit.mode === 'contain' ? 'contain' : 'cover',
        backgroundPosition: typeof fit.position === 'string' ? fit.position : '50% 50%',
      }
    }
  }
  return { background: fallback }
}

function resolveFill(fill: Record<string, unknown> | undefined, project: PptdProject): string {
  if (!fill || fill.type === 'none') return 'transparent'
  if (fill.type === 'solid') return color(fill.color, color(project.theme.colors.bg, '#ffffff'))
  if (fill.type === 'gradient') return `linear-gradient(${number(fill.angle, 180)}deg, ${gradientStops(fill.stops)})`
  return color(project.theme.colors.bg, 'transparent')
}

function resolveTextBackground(style: Record<string, unknown>): string {
  const fill = style.fill
  if (fill && typeof fill === 'object') {
    const fillValue = fill as Record<string, unknown>
    if (fillValue.type === 'gradient') return `linear-gradient(${number(fillValue.angle, 180)}deg, ${gradientStops(fillValue.stops)})`
    return color(fillValue.color, 'transparent')
  }
  return color(style.backgroundColor, 'transparent')
}

function resolveShadow(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const shadow = value as Record<string, unknown>
  const x = number(shadow.offsetX, 0)
  const y = number(shadow.offsetY, 2)
  const blur = number(shadow.blur, 4)
  const opacity = number(shadow.opacity, 0.25)
  return `${x}px ${y}px ${blur}px ${color(shadow.color, `rgba(0,0,0,${opacity})`)}`
}

function cellRecord(value: unknown): { text?: unknown; style?: Record<string, unknown> } {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const cell = value as Record<string, unknown>
    const content = record(cell.content)
    return {
      text: content.text ?? cell.text,
      style: { ...record(cell.style), ...content },
    }
  }
  return { text: value }
}

function lineStroke(element: PptdElement): Record<string, unknown> {
  return record(element.stroke ?? element.border)
}

function normalizedRatios(value: unknown, expected: number): number[] {
  if (!Array.isArray(value) || value.length !== expected || value.some((item) => typeof item !== 'number' || !Number.isFinite(item) || item <= 0)) return []
  const total = value.reduce((sum, item) => sum + item, 0)
  return value.map((item) => item / total)
}

function tableVerticalAlignment(value: unknown): CSSProperties['verticalAlign'] {
  const vertical = Array.isArray(value) ? value[1] : undefined
  return vertical === 'bottom' ? 'bottom' : vertical === 'middle' || vertical === 'mid' || vertical === 'center' ? 'middle' : 'top'
}

function orderedElements(elements: readonly PptdElement[]): PptdElement[] {
  if (!elements.some((element) => finiteNumber(element.zIndex) !== undefined)) return [...elements]
  return elements.map((element, index) => ({ element, index })).sort((left, right) => {
    const z = number(left.element.zIndex, 0) - number(right.element.zIndex, 0)
    return z || left.index - right.index
  }).map(({ element }) => element)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function gradientStops(value: unknown): string {
  if (!Array.isArray(value)) return '#00000000, #00000000'
  return value.map((stop) => { const item = stop as Record<string, unknown>; return `${color(item.color, '#000000')} ${number(item.position, 0) * 100}%` }).join(', ')
}

function alignment(value: unknown, index: number): CSSProperties['textAlign'] {
  if (typeof value === 'string') return index === 0 ? value as CSSProperties['textAlign'] : undefined
  return Array.isArray(value) && typeof value[index] === 'string' ? value[index] as CSSProperties['textAlign'] : index === 0 ? 'left' : undefined
}

function verticalAlignment(value: unknown): CSSProperties['justifyContent'] {
  if (value === 'middle' || value === 'mid' || value === 'center') return 'center'
  if (value === 'bottom') return 'flex-end'
  return 'flex-start'
}

function whiteSpace(value: unknown): CSSProperties['whiteSpace'] {
  return value === 'normal' || value === 'nowrap' || value === 'pre' || value === 'pre-line' || value === 'break-spaces' ? value : 'pre-wrap'
}

function number(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }
function finiteNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
function clampedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number { return Math.max(minimum, Math.min(maximum, number(value, fallback))) }
function color(value: unknown, fallback: string): string { return typeof value === 'string' && isHexColor(value) ? value.trim() : fallback }
function optionalColor(value: unknown): string | undefined { return typeof value === 'string' && isHexColor(value) ? value.trim() : undefined }
function isHexColor(value: string): boolean { return /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value.trim()) }
