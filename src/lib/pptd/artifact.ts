import { dump as dumpYaml, load as parseYaml } from 'js-yaml'
import { parsePptdProject } from './parse'
import type { PptdFiles, PptdProject } from './types'

/**
 * Parses the self-contained artifact representation used by the panel:
 * `{ manifest, pages, media }`. Inline YAML pages are accepted as a
 * convenience for model output, while the canonical on-disk format remains
 * the multi-file PPTD bundle.
 */
export function parsePptdArtifactContent(raw: string): PptdProject | null {
  const text = stripCodeFence(raw)
  try {
    const parsed = JSON.parse(text) as unknown
    if (isBundle(parsed)) return parsePptdProject(parsed)
  } catch {
    // Try the inline YAML form below.
  }
  try {
    const document = parseYaml(text) as Record<string, unknown> | null
    if (!document || typeof document !== 'object' || Array.isArray(document) || !Array.isArray(document.pages) || document.pages.length === 0) return null
    if (!document.pages.every((page) => page && typeof page === 'object' && !Array.isArray(page))) return null
    const pagePaths = document.pages.map((_page, index) => `pages/${String(index + 1).padStart(2, '0')}.page`)
    const manifest = dumpYaml({ ...document, pages: pagePaths })
    const pages = Object.fromEntries(document.pages.map((page, index) => [pagePaths[index], dumpYaml(page)]))
    return parsePptdProject({ manifest, pages, media: isMediaMap(document.media) ? document.media : {} })
  } catch {
    return null
  }
}

function isBundle(value: unknown): value is PptdFiles {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).manifest === 'string' && (value as Record<string, unknown>).pages && typeof (value as Record<string, unknown>).pages === 'object')
}

function isMediaMap(value: unknown): value is Record<string, string | Uint8Array> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim()
  const match = trimmed.match(/^```(?:json|yaml|yml)?\s*\n?([\s\S]*?)\n?\s*```$/i)
  return match ? match[1].trim() : trimmed
}
