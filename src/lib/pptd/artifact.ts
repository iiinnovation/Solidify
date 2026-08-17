import { dump as dumpYaml, load as parseYaml } from 'js-yaml'
import { parsePptdProject } from './parse'
import { legacyToPptd, parseLegacySlidesDeck } from './migrate-legacy'
import { pptdMediaDataUrl } from './media'
import type { PptdFiles, PptdProject } from './types'

export type PptdArtifactParseStage = 'bundle-json' | 'legacy-json' | 'inline-yaml' | 'json-repair'

export interface PptdArtifactParseDiagnostic {
  stage: PptdArtifactParseStage
  message: string
  position?: number
  line?: number
  column?: number
  sourceLine?: string
}

export interface PptdArtifactParseResult {
  project: PptdProject | null
  diagnostics: PptdArtifactParseDiagnostic[]
  repaired: boolean
}

/**
 * Parses the self-contained artifact representation used by the panel:
 * `{ manifest, pages, media }`. Inline YAML pages are accepted as a
 * convenience for model output, while the canonical on-disk format remains
 * the multi-file PPTD bundle.
 */
export function parsePptdArtifactContent(raw: string): PptdProject | null {
  return parsePptdArtifactContentDetailed(raw).project
}

/** Parses an artifact while preserving failures from every supported format. */
export function parsePptdArtifactContentDetailed(raw: string): PptdArtifactParseResult {
  const text = stripCodeFence(raw)
  const diagnostics: PptdArtifactParseDiagnostic[] = []
  let jsonText = text
  let parsedJson: unknown
  let repaired = false

  try {
    parsedJson = JSON.parse(text) as unknown
  } catch (error) {
    diagnostics.push(toDiagnostic('bundle-json', error, text))
    const repair = repairUnescapedJsonQuotes(text)
    if (repair) {
      try {
        parsedJson = JSON.parse(repair.text) as unknown
        jsonText = repair.text
        repaired = true
      } catch (repairError) {
        diagnostics.push(toDiagnostic('json-repair', repairError, repair.text))
      }
    }
  }

  if (parsedJson !== undefined) {
    if (isBundle(parsedJson)) {
      try {
        return { project: parsePptdProject(parsedJson), diagnostics, repaired }
      } catch (error) {
        diagnostics.push(toDiagnostic('bundle-json', error, jsonText))
      }
    }
    const legacy = parseLegacySlidesDeck(jsonText)
    if (legacy) return { project: legacyToPptd(legacy), diagnostics, repaired }
    if (isRecord(parsedJson) && 'slides' in parsedJson) {
      diagnostics.push({ stage: 'legacy-json', message: '旧版 slides JSON 结构无效' })
    }
  }

  try {
    const document = parseYaml(text) as Record<string, unknown> | null
    if (!isRecord(document) || !Array.isArray(document.pages) || document.pages.length === 0) {
      throw new Error('内联 PPTD 必须包含非空 pages 数组')
    }
    if (!document.pages.every(isRecord)) throw new Error('内联 PPTD 的每个 page 必须是对象')
    const pagePaths = document.pages.map((_page, index) => `pages/${String(index + 1).padStart(2, '0')}.page`)
    const manifest = dumpYaml({ ...document, pages: pagePaths })
    const pages = Object.fromEntries(document.pages.map((page, index) => [pagePaths[index], dumpYaml(page)]))
    return {
      project: parsePptdProject({ manifest, pages, media: isMediaMap(document.media) ? document.media : {} }),
      diagnostics,
      repaired,
    }
  } catch (error) {
    diagnostics.push(toDiagnostic('inline-yaml', error, text))
    return { project: null, diagnostics, repaired: false }
  }
}

/** Serializes the canonical project into the self-contained artifact bundle. */
export function serializePptdArtifactContent(project: PptdProject): string {
  const pages = Object.fromEntries(project.pagePaths.map((path, index) => [
    path,
    dumpYaml(project.pages[index], { noRefs: true, lineWidth: -1 }),
  ]))
  const manifest = dumpYaml({
    version: project.version,
    title: project.title,
    size: project.size,
    theme: project.theme,
    pages: project.pagePaths,
  }, { noRefs: true, lineWidth: -1 })
  const media = Object.fromEntries(Object.entries(project.media).map(([path, value]) => {
    if (typeof value === 'string') return [path, value]
    const dataUrl = pptdMediaDataUrl(value, path)
    if (!dataUrl) throw new Error(`无法序列化 PPTD media：${path}`)
    return [path, dataUrl]
  }))
  // Prevent user-authored text from closing the surrounding artifact envelope.
  return JSON.stringify({ manifest, pages, media }).replace(/</g, '\\u003c')
}

function isBundle(value: unknown): value is PptdFiles {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).manifest === 'string' && (value as Record<string, unknown>).pages && typeof (value as Record<string, unknown>).pages === 'object')
}

function isMediaMap(value: unknown): value is Record<string, string | Uint8Array> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const MAX_JSON_QUOTE_REPAIRS = 8

/**
 * Repairs only quotes that occur inside a JSON string and cannot legally end
 * that string. This covers model output such as `"title": "A"升级方案"`
 * without attempting general-purpose or recursive JSON recovery.
 */
function repairUnescapedJsonQuotes(raw: string): { text: string; count: number } | null {
  let output = ''
  let inString = false
  let escaped = false
  let repairs = 0

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    if (!inString) {
      output += char
      if (char === '"') inString = true
      continue
    }
    if (escaped) {
      output += char
      escaped = false
      continue
    }
    if (char === '\\') {
      output += char
      escaped = true
      continue
    }
    if (char !== '"') {
      output += char
      continue
    }

    const next = nextNonWhitespace(raw, index + 1)
    if (next === undefined || ':,}]'.includes(next)) {
      output += char
      inString = false
      continue
    }
    repairs++
    if (repairs > MAX_JSON_QUOTE_REPAIRS) return null
    output += '\\"'
  }

  return repairs > 0 ? { text: output, count: repairs } : null
}

function nextNonWhitespace(raw: string, start: number): string | undefined {
  for (let index = start; index < raw.length; index++) {
    if (!/\s/.test(raw[index])) return raw[index]
  }
  return undefined
}

function toDiagnostic(stage: PptdArtifactParseStage, error: unknown, source: string): PptdArtifactParseDiagnostic {
  const message = error instanceof Error ? error.message : String(error)
  const errorRecord = error && typeof error === 'object' ? error as Record<string, unknown> : undefined
  const mark = errorRecord?.mark && typeof errorRecord.mark === 'object'
    ? errorRecord.mark as Record<string, unknown>
    : undefined
  const positionMatch = message.match(/position\s+(\d+)/i)
  const lineMatch = message.match(/line\s+(\d+)/i)
  const columnMatch = message.match(/column\s+(\d+)/i)
  const markedLine = typeof mark?.line === 'number' ? mark.line + 1 : undefined
  const markedColumn = typeof mark?.column === 'number' ? mark.column + 1 : undefined
  const position = positionMatch ? Number(positionMatch[1]) : undefined
  const location = position !== undefined ? locationAt(source, position) : undefined
  const line = markedLine ?? (lineMatch ? Number(lineMatch[1]) : location?.line)
  const column = markedColumn ?? (columnMatch ? Number(columnMatch[1]) : location?.column)
  const sourceLine = line ? clippedSourceLine(source, line, column) : undefined
  return {
    stage,
    message,
    ...(position !== undefined ? { position } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
    ...(sourceLine !== undefined ? { sourceLine } : {}),
  }
}

function locationAt(source: string, position: number): { line: number; column: number } {
  const before = source.slice(0, Math.max(0, Math.min(position, source.length)))
  const lines = before.split(/\r?\n/)
  return { line: lines.length, column: [...(lines.at(-1) ?? '')].length + 1 }
}

const MAX_DIAGNOSTIC_SOURCE_LINE = 240

function clippedSourceLine(source: string, line: number, column?: number): string | undefined {
  const value = source.split(/\r?\n/)[line - 1]
  if (value === undefined || value.length <= MAX_DIAGNOSTIC_SOURCE_LINE) return value
  const center = Math.max(0, (column ?? 1) - 1)
  const start = Math.max(0, Math.min(value.length - MAX_DIAGNOSTIC_SOURCE_LINE, center - Math.floor(MAX_DIAGNOSTIC_SOURCE_LINE / 2)))
  const end = Math.min(value.length, start + MAX_DIAGNOSTIC_SOURCE_LINE)
  return `${start > 0 ? '...' : ''}${value.slice(start, end)}${end < value.length ? '...' : ''}`
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim()
  const match = trimmed.match(/^```(?:json|yaml|yml)?\s*\n?([\s\S]*?)\n?\s*```$/i)
  return match ? match[1].trim() : trimmed
}
