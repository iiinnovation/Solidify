import { load as parseYaml } from 'js-yaml'
import type { PptdBounds, PptdElement, PptdFiles, PptdPage, PptdProject, PptdSize, PptdTextStyle, PptdTheme } from './types'

export class PptdParseError extends Error {
  public readonly sourcePath?: string

  constructor(message: string, sourcePath?: string) {
    super(sourcePath ? `${sourcePath}: ${message}` : message)
    this.name = 'PptdParseError'
    this.sourcePath = sourcePath
  }
}

export function parsePptdProject(files: PptdFiles): PptdProject {
  const manifestPath = files.manifestPath ?? 'deck.pptd'
  const manifest = asRecord(parseYamlDocument(files.manifest, manifestPath), manifestPath)
  const version = requiredString(manifest.version, 'version', manifestPath)
  if (version !== 'v2') throw new PptdParseError(`暂不支持 PPTD 版本：${version}`, manifestPath)
  const title = requiredString(manifest.title, 'title', manifestPath)
  const size = parseSize(manifest.size ?? [960, 540], manifestPath)
  const theme = parseTheme(manifest.theme ?? {}, manifestPath)
  const pagePaths = requiredArray(manifest.pages, 'pages', manifestPath).map((value, index) => {
    const path = requiredString(value, `pages[${index}]`, manifestPath)
    return safeRelativePath(path, manifestPath)
  })
  if (new Set(pagePaths).size !== pagePaths.length) {
    throw new PptdParseError('pages 不能包含重复路径', manifestPath)
  }

  const pages = pagePaths.map((pagePath) => {
    const raw = files.pages[pagePath]
    if (raw === undefined) throw new PptdParseError(`缺少页面文件：${pagePath}`, manifestPath)
    return parsePage(raw, pagePath, theme)
  })

  return {
    version,
    title,
    size,
    theme,
    pages,
    pagePaths,
    media: files.media ?? {},
    source: { manifestPath },
  }
}

export function parsePptdPage(raw: string, path = 'page.page', theme: PptdTheme = emptyTheme()): PptdPage {
  return parsePage(raw, path, theme)
}

function parsePage(raw: string, path: string, theme: PptdTheme): PptdPage {
  const source = asRecord(parseYamlDocument(raw, path), path)
  const elements = requiredArray(source.elements ?? [], 'elements', path).map((value, index) => parseElement(value, `${path}: elements[${index}]`))
  const page = {
    ...source,
    ...(source.pageType === undefined ? {} : { pageType: requiredString(source.pageType, 'pageType', path) }),
    ...(source.background === undefined ? {} : { background: resolveTokens(asRecord(source.background, path), theme) }),
    elements,
  } as PptdPage
  return resolveTokens(page, theme) as PptdPage
}

function parseElement(value: unknown, path: string): PptdElement {
  const source = asRecord(value, path)
  const elementId = requiredString(source.elementId, 'elementId', path)
  const elementType = requiredString(source.elementType, 'elementType', path)
  if (!['text', 'shape', 'image', 'line', 'icon', 'table', 'chart'].includes(elementType)) {
    throw new PptdParseError(`不支持的元素类型：${elementType}`, path)
  }
  const boundsValue = requiredArray(source.bounds, 'bounds', path)
  if (boundsValue.length !== 4 || boundsValue.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new PptdParseError('bounds 必须是四个有限数字 [x, y, width, height]', path)
  }
  const bounds = boundsValue as unknown as PptdBounds
  if (bounds[2] <= 0 || bounds[3] <= 0) throw new PptdParseError('bounds 的 width 和 height 必须大于 0', path)
  return { ...source, elementId, elementType: elementType as PptdElement['elementType'], bounds }
}

function parseTheme(value: unknown, path: string): PptdTheme {
  const source = asRecord(value, `${path}: theme`)
  const colorsSource = asRecord(source.colors ?? {}, `${path}: theme.colors`)
  const textStylesSource = asRecord(source.textStyles ?? {}, `${path}: theme.textStyles`)
  const colors: Record<string, string> = {}
  for (const [name, color] of Object.entries(colorsSource)) colors[name] = requiredString(color, `theme.colors.${name}`, path)
  const textStyles: Record<string, PptdTextStyle> = {}
  for (const [name, style] of Object.entries(textStylesSource)) textStyles[name] = asRecord(style, `${path}: theme.textStyles.${name}`) as PptdTextStyle
  return resolveTokens({ ...source, colors, textStyles }, { ...emptyTheme(), ...source, colors, textStyles }) as PptdTheme
}

function resolveTokens(value: unknown, theme: PptdTheme): unknown {
  if (typeof value === 'string') {
    const exact = value.match(/^\$([\w.-]+)$/)
    if (exact) return lookupToken(exact[1], theme) ?? value
    return value.replace(/\$([\w.-]+)/g, (_match, token: string) => String(lookupToken(token, theme) ?? `$${token}`))
  }
  if (Array.isArray(value)) return value.map((item) => resolveTokens(item, theme))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTokens(item, theme)]))
  return value
}

function lookupToken(token: string, theme: PptdTheme): unknown {
  const [root, ...rest] = token.split('.')
  if (root === 'colors') return rest.reduce<unknown>((current, key) => current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, theme.colors)
  if (root === 'textStyles') return rest.reduce<unknown>((current, key) => current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, theme.textStyles)
  return theme.colors[token] ?? theme.textStyles[token]
}

function parseYamlDocument(raw: string, path: string): unknown {
  try {
    return parseYaml(raw)
  } catch (error) {
    throw new PptdParseError(`YAML 解析失败：${error instanceof Error ? error.message : String(error)}`, path)
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PptdParseError('必须是对象', path)
  return value as Record<string, unknown>
}

function requiredString(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new PptdParseError(`${field} 必须是非空字符串`, path)
  return value.trim()
}

function requiredArray(value: unknown, field: string, path: string): unknown[] {
  if (!Array.isArray(value)) throw new PptdParseError(`${field} 必须是数组`, path)
  return value
}

function parseSize(value: unknown, path: string): PptdSize {
  const size = requiredArray(value, 'size', path)
  if (size.length !== 2 || size.some((item) => typeof item !== 'number' || !Number.isFinite(item) || item <= 0)) throw new PptdParseError('size 必须是两个正数 [width, height]', path)
  return size as unknown as PptdSize
}

function safeRelativePath(path: string, sourcePath: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) throw new PptdParseError(`路径必须是安全的相对路径：${path}`, sourcePath)
  return normalized
}

function emptyTheme(): PptdTheme {
  return { colors: {}, textStyles: {} }
}
