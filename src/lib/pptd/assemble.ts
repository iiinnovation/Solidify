import type {
  PptdDiagnostic,
  PptdPage,
  PptdProject,
  PptdSize,
  PptdTheme,
  PptdValidationResult,
} from './types'
import { validatePptdProject } from './validate'

const DEFAULT_SIZE: PptdSize = [960, 540]

export interface PptdAssemblyInput {
  title: string
  theme: PptdTheme
  pages: readonly PptdPage[]
  pagePaths?: readonly string[]
  size?: PptdSize
  media?: Readonly<Record<string, string | Uint8Array>>
}

export interface PptdPageValidationResult extends PptdValidationResult {
  pageIndex: number
  pagePath: string
}

export interface PptdAssemblyResult {
  project: PptdProject
  validation: PptdValidationResult
  pageResults: PptdPageValidationResult[]
  projectErrors: PptdDiagnostic[]
  projectWarnings: PptdDiagnostic[]
}

/**
 * Builds the canonical in-memory deck and groups validator output by page for
 * targeted repair. This stage is deterministic and performs no model calls.
 */
export function assemblePptdProject(input: PptdAssemblyInput): PptdAssemblyResult {
  const pagePaths = resolvePagePaths(input.pages.length, input.pagePaths)
  const project: PptdProject = {
    version: 'v2',
    title: input.title,
    size: input.size ?? DEFAULT_SIZE,
    theme: input.theme,
    pages: [...input.pages],
    pagePaths,
    media: { ...input.media },
  }
  const validation = validatePptdProject(project)
  const pageResults = pagePaths.map((pagePath, pageIndex) => {
    const errors = validation.errors.filter((item) => belongsToPage(item, pagePath))
    const warnings = validation.warnings.filter((item) => belongsToPage(item, pagePath))
    return { pageIndex, pagePath, errors, warnings, valid: errors.length === 0 }
  })

  return {
    project,
    validation,
    pageResults,
    projectErrors: validation.errors.filter((item) => !pagePaths.some((pagePath) => belongsToPage(item, pagePath))),
    projectWarnings: validation.warnings.filter((item) => !pagePaths.some((pagePath) => belongsToPage(item, pagePath))),
  }
}

function resolvePagePaths(pageCount: number, provided?: readonly string[]): string[] {
  if (!provided) {
    return Array.from({ length: pageCount }, (_, index) => `pages/${String(index + 1).padStart(2, '0')}.page`)
  }
  if (provided.length !== pageCount) {
    throw new Error(`pagePaths length (${provided.length}) must match pages length (${pageCount})`)
  }
  const pagePaths = [...provided]
  if (new Set(pagePaths).size !== pagePaths.length) throw new Error('pagePaths must be unique')
  if (pagePaths.some((path) => !isSafeRelativePath(path))) throw new Error('pagePaths must contain safe relative paths')
  return pagePaths
}

function isSafeRelativePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return Boolean(normalized)
    && !normalized.startsWith('/')
    && normalized.split('/').every((part) => Boolean(part) && part !== '.' && part !== '..')
}

function belongsToPage(diagnostic: PptdDiagnostic, pagePath: string): boolean {
  return diagnostic.path === pagePath || diagnostic.path.startsWith(`${pagePath}:`)
}
