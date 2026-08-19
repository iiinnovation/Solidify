import type { PptdDiagnostic, PptdElement, PptdPage, PptdProject, PptdValidationResult } from './types'
import { getPptdChartSpec, isImagePptdChartType, isNativePptdChartType } from './chart'
import { pptdAbsoluteLinePoints, pptdLineArrow, pptdLineIsOrthogonal } from './line'

export function validatePptdProject(project: PptdProject): PptdValidationResult {
  const errors: PptdDiagnostic[] = []
  const warnings: PptdDiagnostic[] = []
  const [width, height] = project.size
  if (project.pages.length === 0) errors.push(diagnostic('project', '至少需要一个页面', 'empty-pages'))
  checkUnresolvedTokens(project, warnings)
  checkInvalidColors(project, warnings)
  project.pages.forEach((page, pageIndex) => {
    const pagePath = project.pagePaths[pageIndex] ?? `pages/${pageIndex}.page`
    if (page.background?.type === 'image') {
      const src = typeof page.background.src === 'string' ? page.background.src : undefined
      if (!src) errors.push(diagnostic(pagePath, 'image 背景必须提供 src', 'invalid-field'))
      else if (!project.media[src]) errors.push(diagnostic(pagePath, `缺少背景 media 文件：${src}`, 'missing-media'))
    }
    const ids = new Set<string>()
    page.elements.forEach((element, index) => {
      const path = `${pagePath}: elements[${index}]`
      if (ids.has(element.elementId)) errors.push(diagnostic(path, `重复的 elementId：${element.elementId}`, 'duplicate-element-id'))
      ids.add(element.elementId)
      checkBounds(element, width, height, path, errors)
      checkElement(element, page, project, path, errors, warnings)
    })
    // Content pages need enough structure to carry evidence, not just a title
    // and a row of labels. Keep this as a warning so the repair model can add
    // structure without turning a quality problem into a hard pipeline error.
    const contentPageTypes = new Set(['content', 'comparison', 'timeline', 'diagram', 'chart', 'table', 'summary'])
    const hasNonTextElement = page.elements.some((element) => element.elementType !== 'text')
    if (contentPageTypes.has(page.pageType ?? '') && (page.elements.length < 6 || !hasNonTextElement)) {
      warnings.push(diagnostic(pagePath, '页面只包含少量文本标签，缺少证据或视觉结构', 'composition-sparse', 'warning'))
    }
    for (let i = 0; i < page.elements.length; i++) {
      for (let j = i + 1; j < page.elements.length; j++) {
        const a = page.elements[i]
        const b = page.elements[j]
        if (a.elementType === 'text' && b.elementType === 'text' && overlaps(a, b)) {
          errors.push(diagnostic(pagePath, `文本元素重叠：${a.elementId} 与 ${b.elementId}`, 'text-overlap'))
        }
        // Elements are painted in array order, so the later element is on top.
        // Warn only when that top element contains the earlier one.  Checking
        // contains(a, b) here would flag the harmless inverse (a background
        // below a smaller foreground element) and used to miss the real case.
        if (contains(b, a) && a.elementType !== 'text' && b.elementType !== 'text') {
          warnings.push(diagnostic(pagePath, `元素完全覆盖：${b.elementId} 可能遮挡 ${a.elementId}`, 'hidden-element', 'warning'))
        }
      }
    }
    checkDiagramGeometry(page, pagePath, warnings)
  })
  return { errors, warnings, valid: errors.length === 0 }
}

function checkDiagramGeometry(page: PptdPage, pagePath: string, warnings: PptdDiagnostic[]): void {
  const lines = page.elements.filter((element) => element.elementType === 'line')
  const nodes = page.elements.filter((element) => element.elementType === 'shape' && isDiagramNode(element))
  const pageType = String(page.pageType ?? '').toLowerCase()
  const diagramPage = /diagram|flow|process|architecture|sequence|dependency|pipeline|架构|流程|依赖|链路/.test(pageType)
    || (lines.length >= 2 && nodes.length >= 3)
  if (!diagramPage) return
  if (lines.length < 1 || nodes.length < 2) {
    warnings.push(diagnostic(pagePath, '关系图缺少必要结构，至少需要 2 个节点和 1 条连接线', 'diagram-missing-structure', 'warning'))
    return
  }

  const nodeOverlap = nodes.some((left, index) => nodes.slice(index + 1).some((right) => overlapArea(left, right) > Math.min(area(left), area(right)) * 0.08))
  if (nodeOverlap) warnings.push(diagnostic(pagePath, '关系图节点互相重叠，阅读顺序和边界不可判定', 'diagram-node-overlap', 'warning'))

  const absoluteLines = lines.map((line) => ({ line, points: pptdAbsoluteLinePoints(line) }))
  const allHaveArrows = absoluteLines.every(({ line }) => Boolean(pptdLineArrow(line, 'end')))
  if (!allHaveArrows) warnings.push(diagnostic(pagePath, '关系图连线缺少方向箭头，依赖或流程关系不可判定', 'diagram-missing-arrow', 'warning'))

  for (const { line, points } of absoluteLines) {
    if (!pptdLineIsOrthogonalSafe(line)) warnings.push(diagnostic(pagePath, `关系图连线 ${line.elementId} 使用斜线，容易穿过节点；请改为水平/垂直折线`, 'diagram-diagonal-connector', 'warning'))
    const endpointNodes = nodes.filter((node) => pointInRect(points[0], node.bounds) || pointInRect(points.at(-1) ?? points[0], node.bounds))
    const crossed = nodes.some((node) => !endpointNodes.includes(node) && polylineHitsRect(points, node.bounds))
    if (crossed) warnings.push(diagnostic(pagePath, `关系图连线 ${line.elementId} 穿过其他节点`, 'diagram-line-through-node', 'warning'))
    const attached = points.length >= 2 && [points[0], points.at(-1) as readonly [number, number]].every((point) => nodes.some((node) => nearRect(point, node.bounds, 18)))
    if (!attached) warnings.push(diagnostic(pagePath, `关系图连线 ${line.elementId} 没有连接到两个节点`, 'diagram-unattached-connector', 'warning'))
  }

  for (let i = 0; i < absoluteLines.length; i++) {
    for (let j = i + 1; j < absoluteLines.length; j++) {
      if (polylinesCross(absoluteLines[i].points, absoluteLines[j].points)) {
        warnings.push(diagnostic(pagePath, `关系图连线 ${absoluteLines[i].line.elementId} 与 ${absoluteLines[j].line.elementId} 相交`, 'diagram-crossing-connectors', 'warning'))
      }
    }
  }
}

function isDiagramNode(element: PptdElement): boolean {
  const [, , width, height] = element.bounds
  return width >= 72 && height >= 28 && width * height < 500_000
}

function pptdLineIsOrthogonalSafe(element: PptdElement): boolean {
  return pptdLineIsOrthogonal(pptdAbsoluteLinePoints(element))
}

function polylineHitsRect(points: readonly (readonly [number, number])[], rect: readonly [number, number, number, number]): boolean {
  if (points.length < 2) return false
  for (let index = 1; index < points.length; index++) {
    const [startX, startY] = points[index - 1]
    const [endX, endY] = points[index]
    for (let step = 1; step < 10; step++) {
      const t = step / 10
      if (pointInRect([startX + (endX - startX) * t, startY + (endY - startY) * t], rect)) return true
    }
  }
  return false
}

function polylinesCross(first: readonly (readonly [number, number])[], second: readonly (readonly [number, number])[]): boolean {
  for (let i = 1; i < first.length; i++) {
    for (let j = 1; j < second.length; j++) {
      if (segmentsCross(first[i - 1], first[i], second[j - 1], second[j])) return true
    }
  }
  return false
}

function segmentsCross(a: readonly [number, number], b: readonly [number, number], c: readonly [number, number], d: readonly [number, number]): boolean {
  const orient = (p: readonly [number, number], q: readonly [number, number], r: readonly [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const shared = distance(a, c) < 2 || distance(a, d) < 2 || distance(b, c) < 2 || distance(b, d) < 2
  if (shared) return false
  return orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0
}

function pointInRect(point: readonly [number, number], rect: readonly [number, number, number, number]): boolean {
  return point[0] > rect[0] + 2 && point[0] < rect[0] + rect[2] - 2 && point[1] > rect[1] + 2 && point[1] < rect[1] + rect[3] - 2
}

function nearRect(point: readonly [number, number], rect: readonly [number, number, number, number], tolerance: number): boolean {
  return point[0] >= rect[0] - tolerance && point[0] <= rect[0] + rect[2] + tolerance && point[1] >= rect[1] - tolerance && point[1] <= rect[1] + rect[3] + tolerance
}

function area(element: PptdElement): number { return element.bounds[2] * element.bounds[3] }

function overlapArea(left: PptdElement, right: PptdElement): number {
  return Math.max(0, Math.min(left.bounds[0] + left.bounds[2], right.bounds[0] + right.bounds[2]) - Math.max(left.bounds[0], right.bounds[0]))
    * Math.max(0, Math.min(left.bounds[1] + left.bounds[3], right.bounds[1] + right.bounds[3]) - Math.max(left.bounds[1], right.bounds[1]))
}

function distance(first: readonly [number, number], second: readonly [number, number]): number {
  return Math.hypot(first[0] - second[0], first[1] - second[1])
}

function checkBounds(element: PptdElement, width: number, height: number, path: string, errors: PptdDiagnostic[]) {
  const [x, y, w, h] = element.bounds
  if (![x, y, w, h].every((value) => Number.isFinite(value)) || w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > width || y + h > height) errors.push(diagnostic(path, `元素超出画布边界：${element.elementId}`, 'out-of-bounds'))
}

function checkElement(element: PptdElement, page: PptdPage, project: PptdProject, path: string, errors: PptdDiagnostic[], warnings: PptdDiagnostic[]) {
  if (element.elementType === 'image') {
    const src = typeof element.src === 'string' ? element.src : undefined
    if (!src) errors.push(diagnostic(path, 'image 元素必须提供 src', 'invalid-field'))
    else if (!project.media[src]) errors.push(diagnostic(path, `缺少 media 文件：${src}`, 'missing-media'))
  }
  if (element.elementType === 'shape') {
    const fillType = (element.fill as Record<string, unknown> | undefined)?.type
    if (fillType !== undefined && !['none', 'solid', 'gradient'].includes(String(fillType))) errors.push(diagnostic(path, `不支持的 shape fill.type：${String(fillType)}`, 'invalid-field'))
  }
  if (element.elementType === 'text') {
    const content = element.content
    if (!content || typeof content !== 'object' || Array.isArray(content)) errors.push(diagnostic(path, 'text 元素 content 必须是对象', 'invalid-field'))
    if (content?.text !== undefined && typeof content.text !== 'string') errors.push(diagnostic(path, 'text 元素 content.text 必须是字符串', 'invalid-field'))
    const configuredFontSize = typeof content?.fontSize === 'number' ? content.fontSize : undefined
    if (configuredFontSize !== undefined && configuredFontSize < 10) warnings.push(diagnostic(path, `正文字号过小：${configuredFontSize}pt`, 'small-font', 'warning'))
    const color = typeof content?.color === 'string' ? content.color : undefined
    const actualBackground = page.background?.color ?? project.theme.colors.bg
    const background = typeof actualBackground === 'string' ? actualBackground : undefined
    if (color && background) {
      const ratio = contrastRatio(color, background)
      if (ratio < 4.5) warnings.push(diagnostic(path, '文字与背景对比度低于 WCAG AA 建议值', 'low-contrast', 'warning'))
      // A ratio this low is not merely a style preference: the text is
      // effectively unreadable and must be repaired before delivery. Keep the
      // gate below the large-display threshold so existing branded accent
      // covers (for example white on warm orange) remain export-compatible.
      if (ratio < 2) errors.push(diagnostic(path, '文字与背景对比度过低，无法可靠阅读', 'illegible-contrast'))
    }
    const rawText = typeof content?.text === 'string' ? content.text : ''
    const text = rawText.replace(/<\/p\s*>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    const fontSize = Math.max(1, number(content?.fontSize, 18))
    const lineHeight = finiteNumber(content?.lineHeightPx) ?? fontSize * Math.max(0.8, number(content?.lineHeight, 1.2))
    const charsPerLine = Math.max(1, Math.floor(element.bounds[2] / (fontSize * 0.55)))
    const availableLines = Math.max(1, Math.floor(element.bounds[3] / lineHeight))
    const capacity = Math.max(1, charsPerLine * availableLines)
    const requiredLines = text ? text.split(/\r?\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0) : 0
    if (requiredLines > availableLines || text.length > capacity) warnings.push(diagnostic(path, `文本长度 ${text.length} 超出估算容量 ${capacity}`, 'text-overflow', 'warning'))
  }
  if (element.elementType === 'table' && element.rows !== undefined && !Array.isArray(element.rows)) errors.push(diagnostic(path, 'table.rows 必须是二维数组', 'invalid-field'))
  if (element.elementType === 'line' && element.stroke !== undefined && (typeof element.stroke !== 'object' || Array.isArray(element.stroke))) errors.push(diagnostic(path, 'line.stroke 必须是对象', 'invalid-field'))
  if (element.elementType === 'chart') {
    const chart = getPptdChartSpec(element)
    if (!isNativePptdChartType(chart.chartType) && !isImagePptdChartType(chart.chartType)) errors.push(diagnostic(path, `不支持的 chartType：${chart.chartType}`, 'invalid-field'))
    if (chart.data.length === 0) errors.push(diagnostic(path, 'chart.data 必须包含至少一条数据', 'invalid-field'))
    if (chart.data.length < 2) errors.push(diagnostic(path, 'chart.data 至少需要两条数据；单个指标请使用 text 或 shape', 'chart-insufficient-data'))
    const values = chart.data.flatMap((row) => chart.series.map((series) => Number(row[series.key])))
    if (values.length === 0 || values.every((value) => !Number.isFinite(value) || value === 0)) {
      errors.push(diagnostic(path, '图表没有可见的数值数据；架构/流程关系请使用 shape、line 和 text', 'chart-no-visible-data'))
    }
  }
}

/**
 * Reports references the parser could not resolve. Deliberately driven by
 * `project.unresolvedTokens` rather than re-scanning the parsed strings: after
 * substitution a literal `$` (authored as `$$`) is indistinguishable from a
 * missing reference, which is what made prose like "$USD 100" fail before.
 * A warning, not an error — an unresolved token renders as its own name, which
 * is wrong but still exportable.
 */
function checkUnresolvedTokens(project: PptdProject, warnings: PptdDiagnostic[]) {
  for (const item of project.unresolvedTokens ?? []) {
    warnings.push(diagnostic(item.path, `未解析的主题变量：$${item.token}（字面量美元符号请写成 $$）`, 'undefined-token', 'warning'))
  }
}

function checkInvalidColors(project: PptdProject, warnings: PptdDiagnostic[]) {
  const hexColor = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
  const colorKeys = new Set(['color', 'backgroundColor', 'borderColor', 'fill'])
  const visit = (value: unknown, path: string, colorContext = false) => {
    if (typeof value === 'string') {
      if (colorContext && !value.startsWith('$') && !hexColor.test(value)) warnings.push(diagnostic(path, `颜色不是受支持的 hex 格式：${value}`, 'invalid-color', 'warning'))
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, colorContext))
      return
    }
    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, item]) => {
        const nextContext = colorContext || key === 'colors' || (colorKeys.has(key) && typeof item === 'string')
        visit(item, `${path}.${key}`, nextContext)
      })
    }
  }
  visit(project.theme, 'theme')
  project.pages.forEach((page, index) => visit(page, `pages[${index}]`))
}

function contains(a: PptdElement, b: PptdElement): boolean {
  const [ax, ay, aw, ah] = a.bounds
  const [bx, by, bw, bh] = b.bounds
  return ax <= bx && ay <= by && ax + aw >= bx + bw && ay + ah >= by + bh
}

function overlaps(a: PptdElement, b: PptdElement): boolean {
  const [ax, ay, aw, ah] = a.bounds
  const [bx, by, bw, bh] = b.bounds
  return Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx)) * Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by)) > 4
}

function contrastRatio(first: string, second: string): number {
  const a = luminance(first)
  const b = luminance(second)
  if (a === undefined || b === undefined) return 0
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function luminance(color: string): number | undefined {
  let hex = color.replace(/^#/, '')
  if (!/^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(hex)) return undefined
  if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((channel) => `${channel}${channel}`).join('')
  hex = hex.slice(0, 6)
  const channels = [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255).map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function diagnostic(path: string, message: string, code: string, severity: 'error' | 'warning' = 'error'): PptdDiagnostic {
  return { path, message, code, severity }
}

function number(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }
function finiteNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
