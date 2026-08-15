import DOMPurify from 'dompurify'
import { useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import type { PptdElement, PptdProject, PptdTextStyle } from './types'

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
    position: 'relative', width, height, overflow: 'hidden', background: resolveBackground(page.background, project),
    transform: `scale(${scale})`, transformOrigin: 'top left',
  }
  return (
    <div ref={frameRef} className={className} data-pptd-project={project.title} data-pptd-page={pageIndex} style={{ width: '100%', aspectRatio: `${width} / ${height}`, overflow: 'hidden' }}>
      <div style={pageStyle} data-artifact-content data-pptd-page={pageIndex}>
        {page.elements.map((element) => (
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
  const style: CSSProperties = { position: 'absolute', left: x, top: y, width, height, boxSizing: 'border-box', zIndex: 1 }
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
  const css: CSSProperties = {
    ...style, color: color(textStyle.color, '#000000'), background: color(textStyle.backgroundColor, 'transparent'),
    fontFamily: typeof textStyle.fontFamily === 'string' ? textStyle.fontFamily : undefined,
    fontSize: number(textStyle.fontSize, 18), fontWeight: textStyle.bold ? 700 : 400, fontStyle: textStyle.italic ? 'italic' : 'normal',
    lineHeight: number(textStyle.lineHeightPx, 0) || number(textStyle.lineHeight, 1), letterSpacing: number(textStyle.letterSpacing, 0),
    textAlign: alignment(content.align, 0), whiteSpace: content.wrap === false ? 'nowrap' : 'normal', padding: 0,
  }
  return <div style={css} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}

function ShapeElement({ element, project, style, onClick }: ElementRenderProps) {
  const fill = resolveFill(element.fill, project)
  const stroke = element.stroke as Record<string, unknown> | undefined
  const shapeName = typeof element.shapeName === 'string' ? element.shapeName : 'rect'
  const css: CSSProperties = { ...style, background: fill, border: stroke ? `${number(stroke.width, 1)}px solid ${color(stroke.color, '#000000')}` : undefined, borderRadius: shapeName === 'ellipse' ? '50%' : shapeName === 'roundRect' ? 12 : undefined, clipPath: shapeName === 'triangle' ? 'polygon(50% 0%, 100% 100%, 0% 100%)' : undefined }
  return <div style={css} onClick={onClick} />
}

function ImageElement({ element, project, style, onClick }: ElementRenderProps) {
  const src = typeof element.src === 'string' ? project.media[element.src] ?? element.src : undefined
  if (typeof src !== 'string') return <div style={{ ...style, background: '#e5e7eb' }} onClick={onClick} />
  const fit = element.fit && typeof element.fit.mode === 'string' ? element.fit.mode : 'contain'
  const crop = element.fit as Record<string, unknown> | undefined
  return <img src={src} alt="" style={{ ...style, objectFit: fit === 'cover' ? 'cover' : 'contain', objectPosition: typeof crop?.position === 'string' ? crop.position : '50% 50%' }} onClick={onClick} />
}

function LineElement({ element, style, onClick }: ElementRenderProps) {
  const stroke = color((element.stroke as Record<string, unknown> | undefined)?.color, '#000000')
  return <svg style={style} onClick={onClick} viewBox="0 0 100 100" preserveAspectRatio="none"><line x1="0" y1="50" x2="100" y2="50" stroke={stroke} strokeWidth={number((element.stroke as Record<string, unknown> | undefined)?.width, 1)} vectorEffect="non-scaling-stroke" /></svg>
}

function IconElement({ element, style, onClick }: ElementRenderProps) {
  const name = typeof element.icon === 'string' ? element.icon : typeof element.name === 'string' ? element.name : '•'
  return <div style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center', color: color(element.color, '#000000'), fontSize: number(element.fontSize, 24) }} onClick={onClick}>{name}</div>
}

function TableElement({ element, style, onClick }: ElementRenderProps) {
  const rows = Array.isArray(element.rows) ? element.rows : []
  return <table style={{ ...style, borderCollapse: 'collapse', color: color(element.color, '#000000'), fontSize: number(element.fontSize, 12) }} onClick={onClick}><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{(Array.isArray(row) ? row : []).map((cell, cellIndex) => <td key={cellIndex} style={{ border: '1px solid #999', padding: 4 }}>{String(cell)}</td>)}</tr>)}</tbody></table>
}

function ChartElement({ element, style, onClick }: ElementRenderProps) {
  return <div style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed #999', color: '#666', fontSize: 12 }} onClick={onClick}>{typeof element.chartType === 'string' ? `${element.chartType} chart` : 'chart'}</div>
}

interface ElementRenderProps { element: PptdElement; project: PptdProject; style: CSSProperties; onClick: (event?: MouseEvent) => void }

function resolveTextStyle(content: Record<string, unknown>, project: PptdProject): PptdTextStyle {
  const named = typeof content.style === 'string' ? project.theme.textStyles[content.style] : undefined
  return { ...(named ?? {}), ...content } as PptdTextStyle
}

function resolveBackground(background: Record<string, unknown> | undefined, project: PptdProject): string {
  if (!background) return color(project.theme.colors.bg, '#ffffff')
  if (background.type === 'solid') return color(background.color, color(project.theme.colors.bg, '#ffffff'))
  if (background.type === 'gradient') return `linear-gradient(${number(background.angle, 180)}deg, ${gradientStops(background.stops)})`
  return color(project.theme.colors.bg, '#ffffff')
}

function resolveFill(fill: Record<string, unknown> | undefined, project: PptdProject): string {
  if (!fill || fill.type === 'none') return 'transparent'
  if (fill.type === 'solid') return color(fill.color, 'transparent')
  if (fill.type === 'gradient') return `linear-gradient(${number(fill.angle, 180)}deg, ${gradientStops(fill.stops)})`
  return color(project.theme.colors.bg, 'transparent')
}

function gradientStops(value: unknown): string {
  if (!Array.isArray(value)) return '#00000000, #00000000'
  return value.map((stop) => { const item = stop as Record<string, unknown>; return `${color(item.color, '#000000')} ${number(item.position, 0) * 100}%` }).join(', ')
}

function alignment(value: unknown, index: number): CSSProperties['textAlign'] {
  return Array.isArray(value) && typeof value[index] === 'string' ? value[index] as CSSProperties['textAlign'] : index === 0 ? 'left' : undefined
}

function number(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }
function color(value: unknown, fallback: string): string { return typeof value === 'string' && value.trim() ? value : fallback }
