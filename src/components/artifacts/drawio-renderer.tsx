import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { ZoomIn, ZoomOut, Maximize, Edit3, Eye } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/stores/toast-store'

interface DrawioRendererProps {
  content: string
  streaming?: boolean
  onContentChange?: (content: string) => void
}

// ============================================================
// XML Utility Functions
// ============================================================

/**
 * 去除 AI 可能包裹的 markdown 代码围栏（```xml ... ```）
 */
function stripCodeFences(raw: string): string {
  if (!raw) return ''
  const trimmed = raw.trim()
  const patterns = [
    /^```(?:xml|drawio|mxfile)?\s*\n([\s\S]*?)\n?```$/,
    /^```\s*\n([\s\S]*?)\n?```$/,
    /^`([\s\S]*?)`$/,
  ]
  for (const pattern of patterns) {
    const match = trimmed.match(pattern)
    if (match) return match[1].trim()
  }
  return trimmed
}

/**
 * 尝试补全不完整的 Draw.io XML，使其可以被渲染
 */
function completePartialXml(partialXml: string): string {
  if (!partialXml) return ''
  const cleanXml = stripCodeFences(partialXml).trim()

  if (cleanXml.includes('</mxfile>')) return cleanXml
  if (!cleanXml.includes('<mxfile')) return cleanXml

  let completed = cleanXml
  const tagRegex = /<(\/?)([\w-]+)([^>]*?)(\/?)>/g
  const tagStack: string[] = []
  let match
  while ((match = tagRegex.exec(completed)) !== null) {
    const isClosing = match[1] === '/'
    const tagName = match[2]
    const isSelfClosing = match[4] === '/' || match[3].includes('/>')
    if (isClosing) {
      if (tagStack.length > 0 && tagStack[tagStack.length - 1] === tagName) tagStack.pop()
    } else if (!isSelfClosing) {
      tagStack.push(tagName)
    }
  }

  const hasRoot = completed.includes('<root>')
  const hasGraphModel = completed.includes('<mxGraphModel')
  const hasDiagram = completed.includes('<diagram')
  const hasMxfile = completed.includes('<mxfile')

  if (hasMxfile && !hasDiagram) {
    const m = completed.match(/<mxfile[^>]*>/)
    if (m) {
      completed = completed.replace(m[0], `${m[0]}
  <diagram name="流程图" id="diagram-1">
    <mxGraphModel dx="1422" dy="794" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169">
      <root><mxCell id="0" /><mxCell id="1" parent="0" /></root>
    </mxGraphModel>
  </diagram>`)
      return completed + '\n</mxfile>'
    }
  }

  if (hasDiagram && !hasGraphModel) {
    const m = completed.match(/<diagram[^>]*>/)
    if (m) {
      completed = completed.replace(m[0], `${m[0]}
    <mxGraphModel dx="1422" dy="794" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169">
      <root><mxCell id="0" /><mxCell id="1" parent="0" /></root>
    </mxGraphModel>`)
    }
  }

  if (hasGraphModel && !hasRoot) {
    const m = completed.match(/<mxGraphModel[^>]*>/)
    if (m) {
      completed = completed.replace(m[0], `${m[0]}
      <root><mxCell id="0" /><mxCell id="1" parent="0" /></root>`)
    }
  }

  const tagsToClose = [...tagStack].reverse()
  for (const tag of tagsToClose) completed += `\n</${tag}>`
  return completed
}

// ============================================================
// Local SVG Renderer — 解析 mxGraph XML 并生成 SVG，无需网络
// ============================================================

const SVG_PADDING = 30
const DEFAULT_FILL = '#ffffff'
const DEFAULT_STROKE = '#333333'
const DEFAULT_FONT_SIZE = 12
const DEFAULT_FONT_COLOR = '#333333'
const ARROW_W = 10
const ARROW_H = 7

interface CellInfo {
  id: string
  value: string
  isVertex: boolean
  isEdge: boolean
  parentId: string
  sourceId?: string
  targetId?: string
  style: Record<string, string>
  x: number
  y: number
  width: number
  height: number
  points: Array<{ x: number; y: number }>
  sourcePoint?: { x: number; y: number }
  targetPoint?: { x: number; y: number }
  absX: number
  absY: number
}

function parseCellStyle(raw: string | null): Record<string, string> {
  const s: Record<string, string> = {}
  if (!raw) return s
  for (const seg of raw.split(';')) {
    const t = seg.trim()
    if (!t) continue
    const eq = t.indexOf('=')
    if (eq > 0) {
      s[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
    } else {
      s._base = t
    }
  }
  return s
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function shapeOf(s: Record<string, string>): string {
  const base = (s._base || '').toLowerCase()
  const shape = (s.shape || '').toLowerCase()
  if (base === 'ellipse' || shape === 'ellipse' || shape.includes('ellipse')) return 'ellipse'
  if (base === 'rhombus' || shape === 'rhombus' || shape.includes('diamond')) return 'diamond'
  if (base === 'swimlane' || shape === 'swimlane') return 'swimlane'
  if (base === 'text' || shape === 'text') return 'text'
  if (base.includes('hexagon') || shape.includes('hexagon')) return 'hexagon'
  if (base.includes('cylinder') || shape.includes('cylinder')) return 'cylinder'
  if (base.includes('triangle') || shape.includes('triangle')) return 'triangle'
  if (base.includes('parallelogram') || shape.includes('parallelogram')) return 'parallelogram'
  if (base.includes('process') || shape.includes('process')) return 'process'
  if (base.includes('doubleArrow') || shape.includes('doubleArrow')) return 'rectangle'
  return 'rectangle'
}

/** 提取所有 mxCell 数据并解析到绝对坐标 */
function extractCells(xml: string): {
  cellMap: Map<string, CellInfo>
  vertices: CellInfo[]
  edges: CellInfo[]
} | null {
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    const els = doc.querySelectorAll('mxCell')
    if (els.length <= 2) return null

    const cellMap = new Map<string, CellInfo>()
    const vertices: CellInfo[] = []
    const edges: CellInfo[] = []

    for (const el of els) {
      const id = el.getAttribute('id') || ''
      if (id === '0' || id === '1') continue

      const geo = el.querySelector('mxGeometry')
      let x = 0, y = 0, width = 0, height = 0
      const points: Array<{ x: number; y: number }> = []
      let sourcePoint: { x: number; y: number } | undefined
      let targetPoint: { x: number; y: number } | undefined

      if (geo) {
        x = parseFloat(geo.getAttribute('x') || '0') || 0
        y = parseFloat(geo.getAttribute('y') || '0') || 0
        width = parseFloat(geo.getAttribute('width') || '0') || 0
        height = parseFloat(geo.getAttribute('height') || '0') || 0

        // Waypoints
        for (const arr of geo.querySelectorAll(':scope > Array')) {
          for (const pt of arr.querySelectorAll('mxPoint')) {
            points.push({
              x: parseFloat(pt.getAttribute('x') || '0') || 0,
              y: parseFloat(pt.getAttribute('y') || '0') || 0,
            })
          }
        }

        const srcEl = geo.querySelector('mxPoint[as="sourcePoint"]')
        if (srcEl) sourcePoint = { x: parseFloat(srcEl.getAttribute('x') || '0') || 0, y: parseFloat(srcEl.getAttribute('y') || '0') || 0 }
        const tgtEl = geo.querySelector('mxPoint[as="targetPoint"]')
        if (tgtEl) targetPoint = { x: parseFloat(tgtEl.getAttribute('x') || '0') || 0, y: parseFloat(tgtEl.getAttribute('y') || '0') || 0 }
      }

      const cell: CellInfo = {
        id,
        value: el.getAttribute('value') || '',
        isVertex: el.getAttribute('vertex') === '1',
        isEdge: el.getAttribute('edge') === '1',
        parentId: el.getAttribute('parent') || '1',
        sourceId: el.getAttribute('source') || undefined,
        targetId: el.getAttribute('target') || undefined,
        style: parseCellStyle(el.getAttribute('style')),
        x, y, width, height,
        points, sourcePoint, targetPoint,
        absX: x, absY: y,
      }

      cellMap.set(id, cell)
      if (cell.isVertex) vertices.push(cell)
      if (cell.isEdge) edges.push(cell)
    }

    // 解析父级偏移 → 绝对坐标
    for (const cell of [...vertices, ...edges]) {
      let cx = cell.x, cy = cell.y, pid = cell.parentId
      const visited = new Set<string>()
      while (pid && pid !== '0' && pid !== '1' && !visited.has(pid)) {
        visited.add(pid)
        const parent = cellMap.get(pid)
        if (!parent) break
        cx += parent.x
        cy += parent.y
        pid = parent.parentId
      }
      cell.absX = cx
      cell.absY = cy
    }

    return { cellMap, vertices, edges }
  } catch {
    return null
  }
}

/** 计算线段与形状边界的交点 */
function edgePoint(
  cell: CellInfo,
  tx: number, ty: number,
  shape: string,
): { x: number; y: number } {
  const cx = cell.absX + cell.width / 2
  const cy = cell.absY + cell.height / 2
  if (cell.width === 0 && cell.height === 0) return { x: cx, y: cy }

  const dx = tx - cx
  const dy = ty - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy - cell.height / 2 }

  if (shape === 'ellipse') {
    const a = Math.atan2(dy, dx)
    return { x: cx + (cell.width / 2) * Math.cos(a), y: cy + (cell.height / 2) * Math.sin(a) }
  }

  if (shape === 'diamond') {
    const a = Math.atan2(dy, dx)
    const hw = cell.width / 2, hh = cell.height / 2
    const r = (Math.abs(Math.cos(a)) * hh > Math.abs(Math.sin(a)) * hw)
      ? hw / Math.abs(Math.cos(a))
      : hh / Math.abs(Math.sin(a))
    return { x: cx + r * 0.95 * Math.cos(a), y: cy + r * 0.95 * Math.sin(a) }
  }

  // Rectangle (default)
  const hw = cell.width / 2, hh = cell.height / 2
  const ax = Math.abs(dx), ay = Math.abs(dy)
  if (ax * hh > ay * hw) {
    const sign = dx > 0 ? 1 : -1
    return { x: cx + sign * hw, y: cy + (ax > 0 ? dy * hw / ax : 0) }
  } else {
    const sign = dy > 0 ? 1 : -1
    return { x: cx + (ay > 0 ? dx * hh / ay : 0), y: cy + sign * hh }
  }
}

function renderVertex(cell: CellInfo): string {
  const s = cell.style
  const shape = shapeOf(s)
  const fill = s.fillColor || (shape === 'text' ? 'none' : DEFAULT_FILL)
  const stroke = s.strokeColor || (shape === 'text' ? 'none' : DEFAULT_STROKE)
  const sw = parseFloat(s.strokeWidth || '1.5')
  const opacity = parseFloat(s.opacity || '100') / 100
  const rounded = s.rounded === '1'
  const dashed = s.dashed === '1'
  const fontSize = parseFloat(s.fontSize || String(DEFAULT_FONT_SIZE))
  const fontColor = s.fontColor || DEFAULT_FONT_COLOR
  const fontStyleBits = parseInt(s.fontStyle || '0')
  const bold = (fontStyleBits & 1) !== 0
  const italic = (fontStyleBits & 2) !== 0

  const { absX: x, absY: y, width: w, height: h } = cell
  const dash = dashed ? ' stroke-dasharray="6,3"' : ''
  const parts: string[] = []

  // Shape
  switch (shape) {
    case 'ellipse':
      parts.push(`<ellipse cx="${x+w/2}" cy="${y+h/2}" rx="${w/2}" ry="${h/2}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"${dash}/>`)
      break
    case 'diamond': {
      const mx = x+w/2, my = y+h/2
      parts.push(`<polygon points="${mx},${y} ${x+w},${my} ${mx},${y+h} ${x},${my}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"${dash}/>`)
      break
    }
    case 'hexagon': {
      const p = w*0.25
      parts.push(`<polygon points="${x+p},${y} ${x+w-p},${y} ${x+w},${y+h/2} ${x+w-p},${y+h} ${x+p},${y+h} ${x},${y+h/2}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"${dash}/>`)
      break
    }
    case 'cylinder': {
      const ry = Math.min(h*0.15, 15)
      parts.push(`<path d="M${x},${y+ry} A${w/2},${ry} 0 0,1 ${x+w},${y+ry} L${x+w},${y+h-ry} A${w/2},${ry} 0 0,1 ${x},${y+h-ry} Z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"${dash}/>`)
      parts.push(`<ellipse cx="${x+w/2}" cy="${y+ry}" rx="${w/2}" ry="${ry}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"/>`)
      break
    }
    case 'swimlane': {
      const hh = Math.min(h*0.12, 30)
      const hFill = s.fillColor || '#dae8fc'
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill === DEFAULT_FILL ? '#f8f9fa' : fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}" rx="3"${dash}/>`)
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${hh}" fill="${hFill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}" rx="3"/>`)
      parts.push(`<line x1="${x}" y1="${y+hh}" x2="${x+w}" y2="${y+hh}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"/>`)
      break
    }
    case 'parallelogram': {
      const offset = w * 0.15
      parts.push(`<polygon points="${x+offset},${y} ${x+w},${y} ${x+w-offset},${y+h} ${x},${y+h}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"${dash}/>`)
      break
    }
    case 'process': {
      const indent = Math.min(w*0.1, 15)
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"${dash} ${rounded ? 'rx="6"' : ''}/>`)
      parts.push(`<line x1="${x+indent}" y1="${y}" x2="${x+indent}" y2="${y+h}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"/>`)
      parts.push(`<line x1="${x+w-indent}" y1="${y}" x2="${x+w-indent}" y2="${y+h}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"/>`)
      break
    }
    case 'text':
      break
    default: {
      const rx = rounded ? Math.min(8, w/4, h/4) : 0
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"${dash} ${rx>0?`rx="${rx}"`:''}/>`)
    }
  }

  // Label
  if (cell.value) {
    const label = stripHtml(cell.value)
    if (label) {
      const cx = x + w / 2
      let cyText = y + h / 2
      if (shape === 'swimlane') cyText = y + Math.min(h*0.12, 30) / 2

      const lines = label.split('\n').filter(l => l.trim())
      const lh = fontSize * 1.3
      const startY = cyText - ((lines.length - 1) * lh) / 2

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (!line) continue
        const maxCh = Math.max(Math.floor(w / (fontSize * 0.55)), 4)
        const display = line.length > maxCh ? line.slice(0, maxCh - 1) + '\u2026' : line
        parts.push(`<text x="${cx}" y="${startY + i*lh}" text-anchor="middle" dominant-baseline="central" font-size="${fontSize}" fill="${fontColor}" ${bold?'font-weight="bold"':''} ${italic?'font-style="italic"':''}>${esc(display)}</text>`)
      }
    }
  }

  return parts.join('\n')
}

function renderEdge(edge: CellInfo, cellMap: Map<string, CellInfo>): string {
  const s = edge.style
  const stroke = s.strokeColor || DEFAULT_STROKE
  const sw = parseFloat(s.strokeWidth || '1.5')
  const dashed = s.dashed === '1'
  const opacity = parseFloat(s.opacity || '100') / 100

  const srcCell = edge.sourceId ? cellMap.get(edge.sourceId) : undefined
  const tgtCell = edge.targetId ? cellMap.get(edge.targetId) : undefined

  const tgtCenter = tgtCell
    ? { x: tgtCell.absX + tgtCell.width/2, y: tgtCell.absY + tgtCell.height/2 }
    : edge.targetPoint || (edge.points.length > 0 ? edge.points[edge.points.length-1] : { x: edge.absX, y: edge.absY })

  const srcCenter = srcCell
    ? { x: srcCell.absX + srcCell.width/2, y: srcCell.absY + srcCell.height/2 }
    : edge.sourcePoint || (edge.points.length > 0 ? edge.points[0] : { x: edge.absX, y: edge.absY })

  const pts: Array<{ x: number; y: number }> = []

  // Start
  if (srcCell) {
    const nextPt = edge.points.length > 0 ? edge.points[0] : tgtCenter
    pts.push(edgePoint(srcCell, nextPt.x, nextPt.y, shapeOf(srcCell.style)))
  } else if (edge.sourcePoint) {
    pts.push(edge.sourcePoint)
  } else if (edge.points.length > 0) {
    pts.push(edge.points[0])
  }

  // Waypoints
  for (const p of edge.points) pts.push(p)

  // End
  if (tgtCell) {
    const prevPt = edge.points.length > 0 ? edge.points[edge.points.length-1] : srcCenter
    pts.push(edgePoint(tgtCell, prevPt.x, prevPt.y, shapeOf(tgtCell.style)))
  } else if (edge.targetPoint) {
    pts.push(edge.targetPoint)
  }

  if (pts.length < 2) return ''

  // Normalize arrow marker ID based on stroke color
  const colorKey = stroke.replace('#', '')
  const markerId = `arrow-${colorKey}`
  const noArrow = s.endArrow === 'none' || s.endArrow === '0'
  const markerAttr = noArrow ? '' : ` marker-end="url(#${markerId})"`
  const dash = dashed ? ' stroke-dasharray="6,3"' : ''

  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  const parts: string[] = []
  parts.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"${dash}${markerAttr}/>`)

  // Edge label
  if (edge.value) {
    const label = stripHtml(edge.value)
    if (label) {
      const mi = Math.floor(pts.length / 2)
      const mid = { x: (pts[mi-1].x + pts[mi].x) / 2, y: (pts[mi-1].y + pts[mi].y) / 2 }
      const fs = parseFloat(s.fontSize || '11')
      const fc = s.fontColor || DEFAULT_FONT_COLOR
      const tw = label.length * fs * 0.55
      const pad = 3
      parts.push(`<rect x="${mid.x-tw/2-pad}" y="${mid.y-fs/2-pad}" width="${tw+pad*2}" height="${fs+pad*2}" fill="white" opacity="0.9" rx="2"/>`)
      parts.push(`<text x="${mid.x}" y="${mid.y}" text-anchor="middle" dominant-baseline="central" font-size="${fs}" fill="${fc}">${esc(label)}</text>`)
    }
  }

  return parts.join('\n')
}

/** 主入口：mxGraph XML → SVG 字符串 */
function generateLocalSvg(xml: string): string | null {
  const data = extractCells(xml)
  if (!data || (data.vertices.length === 0 && data.edges.length === 0)) return null

  const { cellMap, vertices, edges } = data

  // 收集所有 edge 的 stroke 颜色，为每个颜色生成 arrow marker
  const arrowColors = new Set<string>()
  for (const e of edges) {
    if (e.style.endArrow !== 'none' && e.style.endArrow !== '0') {
      arrowColors.add(e.style.strokeColor || DEFAULT_STROKE)
    }
  }

  // 计算边界
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const v of vertices) {
    if (v.width === 0 && v.height === 0) continue
    minX = Math.min(minX, v.absX)
    minY = Math.min(minY, v.absY)
    maxX = Math.max(maxX, v.absX + v.width)
    maxY = Math.max(maxY, v.absY + v.height)
  }
  for (const e of edges) {
    for (const pt of [e.sourcePoint, e.targetPoint, ...e.points].filter(Boolean) as Array<{x:number;y:number}>) {
      minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y)
      maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y)
    }
  }
  if (minX === Infinity) return null

  minX -= SVG_PADDING; minY -= SVG_PADDING
  maxX += SVG_PADDING; maxY += SVG_PADDING
  const w = maxX - minX, h = maxY - minY

  const parts: string[] = []

  // Arrow markers (one per unique stroke color)
  const markerDefs: string[] = []
  for (const color of arrowColors) {
    const key = color.replace('#', '')
    markerDefs.push(`<marker id="arrow-${key}" markerWidth="${ARROW_W}" markerHeight="${ARROW_H}" refX="${ARROW_W-1}" refY="${ARROW_H/2}" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L${ARROW_W},${ARROW_H/2} L0,${ARROW_H} Z" fill="${color}"/></marker>`)
  }
  if (markerDefs.length > 0) {
    parts.push(`<defs>${markerDefs.join('')}</defs>`)
  }

  // Edges first (behind vertices)
  for (const e of edges) parts.push(renderEdge(e, cellMap))
  // Vertices on top
  for (const v of vertices) {
    if (v.width > 0 || v.height > 0) parts.push(renderVertex(v))
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${w} ${h}" width="100%" height="100%" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',sans-serif">${parts.join('\n')}</svg>`
}

// ============================================================
// Zoom constants
// ============================================================

const ZOOM_STEP = 0.15
const ZOOM_MIN = 0.3
const ZOOM_MAX = 3

// ============================================================
// DrawioRenderer Component
// ============================================================

export function DrawioRenderer({ content, streaming, onContentChange }: DrawioRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [viewMode, setViewMode] = useState<'view' | 'edit'>('view')
  const [zoom, setZoom] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [iframeReady, setIframeReady] = useState(false)
  const [iframeLoading, setIframeLoading] = useState(false)
  const [renderableXml, setRenderableXml] = useState('')

  // 缩放控制
  const zoomIn = useCallback(() => setZoom(z => Math.min(z + ZOOM_STEP, ZOOM_MAX)), [])
  const zoomOut = useCallback(() => setZoom(z => Math.max(z - ZOOM_STEP, ZOOM_MIN)), [])
  const zoomReset = useCallback(() => setZoom(1), [])

  // Preconnect hint：提前建立与 diagrams.net 的连接
  useEffect(() => {
    const link = document.createElement('link')
    link.rel = 'preconnect'
    link.href = 'https://embed.diagrams.net'
    link.crossOrigin = 'anonymous'
    document.head.appendChild(link)

    const dnsPrefetch = document.createElement('link')
    dnsPrefetch.rel = 'dns-prefetch'
    dnsPrefetch.href = 'https://embed.diagrams.net'
    document.head.appendChild(dnsPrefetch)

    return () => {
      document.head.removeChild(link)
      document.head.removeChild(dnsPrefetch)
    }
  }, [])

  // 鼠标滚轮缩放
  useEffect(() => {
    const container = containerRef.current
    if (!container || viewMode === 'edit') return
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        setZoom(z => {
          const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP
          return Math.min(Math.max(z + delta, ZOOM_MIN), ZOOM_MAX)
        })
      }
    }
    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [viewMode])

  // 内容变化时重置
  useEffect(() => {
    setZoom(1)
    setViewMode('view')
    setError(null)
    setIframeReady(false)
  }, [content])

  // 实时处理内容
  useEffect(() => {
    if (!content.trim()) { setRenderableXml(''); return }
    setRenderableXml(streaming ? completePartialXml(content) : stripCodeFences(content))
  }, [content, streaming])

  // 本地 SVG 渲染（memoized）
  const localSvg = useMemo(() => {
    if (!renderableXml) return null
    return generateLocalSvg(renderableXml)
  }, [renderableXml])

  // 验证 XML（仅生成完成后）
  useEffect(() => {
    if (streaming || !renderableXml?.trim()) { setError(null); return }
    const timer = setTimeout(() => {
      const lower = renderableXml.toLowerCase()
      if (!lower.includes('<mxfile') || !lower.includes('<diagram') || !lower.includes('<mxgraphmodel')) {
        setError('Draw.io XML 格式不完整，缺少必要的结构（mxfile、diagram、mxGraphModel）')
        return
      }
      setError(null)
    }, 300)
    return () => clearTimeout(timer)
  }, [renderableXml, streaming])

  // 编辑模式：通过 postMessage 与 iframe 通信
  useEffect(() => {
    if (viewMode !== 'edit') return

    const handleMessage = (event: MessageEvent) => {
      if (!event.origin.includes('diagrams.net')) return
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data

        if (data.event === 'init') {
          // iframe 加载完成，发送 XML 数据
          iframeRef.current?.contentWindow?.postMessage(
            JSON.stringify({ action: 'load', autosave: 1, xml: renderableXml }),
            '*'
          )
          setIframeReady(true)
          setIframeLoading(false)
        }

        if (data.event === 'save' && data.xml && onContentChange) {
          onContentChange(data.xml)
        }

        if (data.event === 'exit') {
          setViewMode('view')
        }
      } catch (err) {
        console.error('[DrawioRenderer] postMessage error:', err)
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [viewMode, renderableXml, onContentChange])

  // 切换到编辑模式时加载 iframe
  const enterEditMode = useCallback(() => {
    setViewMode('edit')
    setIframeReady(false)
    setIframeLoading(true)
  }, [])

  // ── 流式生成中 ──
  if (streaming) {
    return (
      <div className="h-full flex flex-col" ref={containerRef}>
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-light bg-background-secondary shrink-0">
          <div className="flex items-center gap-1.5 text-xs text-accent">
            <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            生成中{localSvg ? '（实时预览）' : '…'}
          </div>
          {localSvg && (
            <span className="text-xs text-text-tertiary">{Math.round(zoom * 100)}%</span>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          {localSvg ? (
            <div
              className="h-full w-full flex items-center justify-center p-4"
              style={{ transform: `scale(${zoom})`, transformOrigin: 'center' }}
              dangerouslySetInnerHTML={{ __html: localSvg }}
            />
          ) : (
            <div className="relative h-full">
              <pre className="p-4 text-[13px] font-mono text-text-secondary leading-relaxed whitespace-pre-wrap break-words">
                {content}
              </pre>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── 格式错误 ──
  if (error && !streaming) {
    return (
      <div className="h-full flex flex-col">
        <div className="p-4 bg-error-light border-b border-error/20">
          <p className="text-sm text-error font-medium">{error}</p>
          <p className="text-xs text-text-tertiary mt-1">AI 生成的 XML 格式可能不完整或不正确</p>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-text-secondary">原始 XML 内容：</span>
            <button onClick={() => { navigator.clipboard.writeText(content); toast.success('已复制到剪贴板') }} className="text-xs text-accent hover:text-accent-dark">
              复制 XML
            </button>
          </div>
          <pre className="text-[13px] font-mono text-text-secondary leading-relaxed whitespace-pre-wrap break-words bg-surface p-3 rounded border border-border max-h-96 overflow-auto">
            {content}
          </pre>
          <div className="mt-4 p-3 bg-background-secondary rounded border border-border">
            <p className="text-sm font-medium text-text-primary mb-2">建议：</p>
            <ul className="text-sm text-text-secondary space-y-1 list-disc list-inside">
              <li>尝试重新生成图表</li>
              <li>使用 Mermaid 代替（输入 / 选择"方案设计"）</li>
              <li>检查网络连接是否正常</li>
            </ul>
          </div>
        </div>
      </div>
    )
  }

  // ── 无法识别格式 ──
  if (!localSvg && !streaming && viewMode === 'view') {
    const lower = (renderableXml || '').toLowerCase()
    const hasStructure = lower.includes('<mxfile') || lower.includes('<diagram') || lower.includes('<mxgraphmodel')
    if (!hasStructure) {
      return (
        <div className="h-full flex flex-col">
          <div className="p-4 bg-warning-light border-b border-warning/20">
            <p className="text-sm text-warning font-medium">无法识别 Draw.io 格式</p>
            <p className="text-xs text-text-tertiary mt-1">内容中缺少必要的 Draw.io XML 结构</p>
          </div>
          <div className="flex-1 overflow-auto p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-text-secondary">接收到的内容：</span>
              <button onClick={() => { navigator.clipboard.writeText(content); toast.success('已复制到剪贴板') }} className="text-xs text-accent hover:text-accent-dark">
                复制内容
              </button>
            </div>
            <pre className="text-[13px] font-mono text-text-secondary leading-relaxed whitespace-pre-wrap break-words bg-surface p-3 rounded border border-border max-h-96 overflow-auto">
              {content}
            </pre>
          </div>
        </div>
      )
    }
  }

  // ── 编辑模式（远程 iframe） ──
  if (viewMode === 'edit') {
    return (
      <div className="h-full flex flex-col" ref={containerRef}>
        {/* 工具栏 */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-light bg-background-secondary shrink-0">
          <div className="flex items-center gap-2">
            <ViewEditToggle viewMode={viewMode} onView={() => setViewMode('view')} onEdit={enterEditMode} />
            {iframeLoading && !iframeReady && (
              <>
                <div className="w-px h-4 bg-border-light" />
                <span className="text-xs text-text-tertiary flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                  加载编辑器...
                </span>
              </>
            )}
          </div>
        </div>

        {/* iframe */}
        <div className="flex-1 min-h-0 overflow-hidden relative">
          {iframeLoading && !iframeReady && (
            <div className="absolute inset-0 bg-background/80 flex items-center justify-center z-10">
              <div className="text-center space-y-3">
                <div className="w-12 h-12 border-4 border-accent/20 border-t-accent rounded-full animate-spin mx-auto" />
                <p className="text-sm text-text-secondary">加载 Draw.io 编辑器...</p>
                <p className="text-xs text-text-tertiary max-w-xs">编辑器需要连接 diagrams.net，请确保网络畅通</p>
              </div>
            </div>
          )}
          <iframe
            ref={iframeRef}
            src="https://embed.diagrams.net/?embed=1&ui=min&spin=1&proto=json&saveAndExit=1&noSaveBtn=0"
            className="w-full h-full border-0"
            title="Draw.io Editor"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            allow="clipboard-read; clipboard-write"
          />
        </div>
      </div>
    )
  }

  // ── 查看模式（本地 SVG 渲染） ──
  return (
    <div className="h-full flex flex-col" ref={containerRef}>
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-light bg-background-secondary shrink-0">
        <div className="flex items-center gap-2">
          <ViewEditToggle viewMode={viewMode} onView={() => setViewMode('view')} onEdit={enterEditMode} />
          <div className="w-px h-4 bg-border-light" />
          <span className="text-xs text-text-tertiary">{Math.round(zoom * 100)}%</span>
        </div>
        <div className="flex items-center gap-0.5">
          <button onClick={zoomOut} disabled={zoom <= ZOOM_MIN} className={cn("p-1.5 rounded-md transition-colors", zoom <= ZOOM_MIN ? "text-text-tertiary/40 cursor-not-allowed" : "text-text-tertiary hover:text-text-secondary hover:bg-surface-hover")} title="缩小 (Ctrl+滚轮)">
            <ZoomOut size={14} strokeWidth={1.75} />
          </button>
          <button onClick={zoomReset} className="px-2 py-1 rounded-md text-xs text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors" title="重置缩放">
            <Maximize size={14} strokeWidth={1.75} />
          </button>
          <button onClick={zoomIn} disabled={zoom >= ZOOM_MAX} className={cn("p-1.5 rounded-md transition-colors", zoom >= ZOOM_MAX ? "text-text-tertiary/40 cursor-not-allowed" : "text-text-tertiary hover:text-text-secondary hover:bg-surface-hover")} title="放大 (Ctrl+滚轮)">
            <ZoomIn size={14} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {/* 本地 SVG 渲染 */}
      <div className="flex-1 min-h-0 overflow-auto">
        {localSvg ? (
          <div
            className="h-full w-full flex items-center justify-center p-4"
            style={{ transform: `scale(${zoom})`, transformOrigin: 'center' }}
            dangerouslySetInnerHTML={{ __html: localSvg }}
          />
        ) : (
          /* SVG 生成失败，显示 XML 源码 + 提示 */
          <div className="p-4 space-y-3">
            <p className="text-sm text-text-tertiary">本地预览不可用，可切换到编辑模式查看完整图表</p>
            <pre className="text-[13px] font-mono text-text-secondary leading-relaxed whitespace-pre-wrap break-words bg-surface p-3 rounded border border-border max-h-96 overflow-auto">
              {renderableXml}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

// ── 查看/编辑切换按钮 ──
function ViewEditToggle({ viewMode, onView, onEdit }: { viewMode: 'view' | 'edit'; onView: () => void; onEdit: () => void }) {
  return (
    <div className="inline-flex items-center rounded-md border border-border-light bg-surface p-0.5 gap-0.5">
      <button
        onClick={onView}
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors",
          viewMode === 'view' ? "bg-background text-text-primary shadow-sm" : "text-text-tertiary hover:text-text-secondary"
        )}
      >
        <Eye size={12} strokeWidth={1.75} />
        查看
      </button>
      <button
        onClick={onEdit}
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors",
          viewMode === 'edit' ? "bg-background text-text-primary shadow-sm" : "text-text-tertiary hover:text-text-secondary"
        )}
      >
        <Edit3 size={12} strokeWidth={1.75} />
        编辑
      </button>
    </div>
  )
}
