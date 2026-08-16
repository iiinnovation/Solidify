import type { PptdDiagnostic, PptdElement, PptdProject, PptdValidationResult } from './types'
import { getPptdChartSpec, isImagePptdChartType, isNativePptdChartType } from './chart'

export function validatePptdProject(project: PptdProject): PptdValidationResult {
  const errors: PptdDiagnostic[] = []
  const warnings: PptdDiagnostic[] = []
  const [width, height] = project.size
  if (project.pages.length === 0) errors.push(diagnostic('project', '至少需要一个页面', 'empty-pages'))
  checkUnresolvedTokens(project, warnings)
  checkInvalidColors(project, warnings)
  project.pages.forEach((page, pageIndex) => {
    const pagePath = project.pagePaths[pageIndex] ?? `pages/${pageIndex}.page`
    const ids = new Set<string>()
    page.elements.forEach((element, index) => {
      const path = `${pagePath}: elements[${index}]`
      if (ids.has(element.elementId)) errors.push(diagnostic(path, `重复的 elementId：${element.elementId}`, 'duplicate-element-id'))
      ids.add(element.elementId)
      checkBounds(element, width, height, path, errors)
      checkElement(element, project, path, errors, warnings)
    })
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
  })
  return { errors, warnings, valid: errors.length === 0 }
}

function checkBounds(element: PptdElement, width: number, height: number, path: string, errors: PptdDiagnostic[]) {
  const [x, y, w, h] = element.bounds
  if (![x, y, w, h].every((value) => Number.isFinite(value)) || w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > width || y + h > height) errors.push(diagnostic(path, `元素超出画布边界：${element.elementId}`, 'out-of-bounds'))
}

function checkElement(element: PptdElement, project: PptdProject, path: string, errors: PptdDiagnostic[], warnings: PptdDiagnostic[]) {
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
    const background = typeof project.theme.colors.bg === 'string' ? project.theme.colors.bg : undefined
    if (color && background && contrastRatio(color, background) < 4.5) warnings.push(diagnostic(path, '文字与背景对比度低于 WCAG AA 建议值', 'low-contrast', 'warning'))
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
