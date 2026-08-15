import type { PptdDiagnostic, PptdElement, PptdProject, PptdValidationResult } from './types'

export function validatePptdProject(project: PptdProject): PptdValidationResult {
  const errors: PptdDiagnostic[] = []
  const warnings: PptdDiagnostic[] = []
  const [width, height] = project.size
  if (project.pages.length === 0) errors.push(diagnostic('project', '至少需要一个页面', 'empty-pages'))
  checkUnresolvedTokens(project, errors)
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
        if (i !== j && contains(a, b) && a.elementType !== 'text' && b.elementType !== 'text') {
          warnings.push(diagnostic(pagePath, `元素完全覆盖：${a.elementId} 可能遮挡 ${b.elementId}`, 'hidden-element', 'warning'))
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
    const fontSize = typeof content?.fontSize === 'number' ? content.fontSize : undefined
    if (fontSize !== undefined && fontSize < 10) warnings.push(diagnostic(path, `正文字号过小：${fontSize}pt`, 'small-font', 'warning'))
    const color = typeof content?.color === 'string' ? content.color : undefined
    const background = typeof project.theme.colors.bg === 'string' ? project.theme.colors.bg : undefined
    if (color && background && contrastRatio(color, background) < 4.5) warnings.push(diagnostic(path, '文字与背景对比度低于 WCAG AA 建议值', 'low-contrast', 'warning'))
    const text = typeof content?.text === 'string' ? content.text.replace(/<[^>]*>/g, '') : ''
    const capacity = Math.max(1, Math.floor((element.bounds[2] * element.bounds[3]) / Math.max(1, number(content?.fontSize, 18) * 1.8)))
    if (text.length > capacity) warnings.push(diagnostic(path, `文本长度 ${text.length} 超出估算容量 ${capacity}`, 'text-overflow', 'warning'))
  }
  if (element.elementType === 'table' && element.rows !== undefined && !Array.isArray(element.rows)) errors.push(diagnostic(path, 'table.rows 必须是二维数组', 'invalid-field'))
  if (element.elementType === 'line' && element.stroke !== undefined && (typeof element.stroke !== 'object' || Array.isArray(element.stroke))) errors.push(diagnostic(path, 'line.stroke 必须是对象', 'invalid-field'))
}

function checkUnresolvedTokens(project: PptdProject, errors: PptdDiagnostic[]) {
  const visit = (value: unknown, path: string) => {
    if (typeof value === 'string' && /\$[A-Za-z_][\w.-]*/.test(value)) errors.push(diagnostic(path, `存在未解析的主题变量：${value}`, 'undefined-token'))
    else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`))
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => visit(item, `${path}.${key}`))
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
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function luminance(color: string): number {
  const hex = color.replace(/^#/, '').slice(0, 6)
  if (!/^[\da-f]{6}$/i.test(hex)) return 1
  const channels = [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255).map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function diagnostic(path: string, message: string, code: string, severity: 'error' | 'warning' = 'error'): PptdDiagnostic {
  return { path, message, code, severity }
}

function number(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }
