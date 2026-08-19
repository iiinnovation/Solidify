/** Runtime-only attachment resources exposed to read-only model tools. */
export interface AttachmentResource {
  id: string
  name: string
  size: number
  mimeType?: string
  text?: string
  mediaUrl?: string
  mediaId?: string
}

export interface AttachmentSection {
  id: string
  title?: string
  start: number
  end: number
  preview: string
}

export interface AttachmentSearchHit {
  attachmentId: string
  name: string
  sectionId?: string
  start: number
  end: number
  excerpt: string
  score: number
}

const DEFAULT_PREVIEW_CHARS = 480
const MAX_SECTION_PREVIEW_CHARS = 240
const MAX_MANIFEST_CHARS = 6_000

export function attachmentPreview(text: string, limit = DEFAULT_PREVIEW_CHARS): string {
  const normalized = text.trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, Math.max(0, limit - 24)).trimEnd()}\n[…附件预览已截断…]`
}

export function attachmentSections(text: string): AttachmentSection[] {
  // Keep offsets in the same UTF-16 coordinate system as readAttachmentRange.
  const value = text
  const headings = [...value.matchAll(/^(#{1,6})\s+(.+)$/gm)]
  if (headings.length === 0) {
    return value.trim()
      ? [{ id: 'section-01', start: 0, end: value.length, preview: attachmentPreview(value, MAX_SECTION_PREVIEW_CHARS) }]
      : []
  }
  return headings.map((match, index) => {
    const start = match.index ?? 0
    const end = headings[index + 1]?.index ?? value.length
    return {
      id: `section-${String(index + 1).padStart(2, '0')}`,
      title: match[2]?.trim(),
      start,
      end,
      preview: attachmentPreview(value.slice(start, end), MAX_SECTION_PREVIEW_CHARS),
    }
  })
}

export function readAttachmentRange(resource: AttachmentResource, offset = 0, limit = 8_000): { text: string; offset: number; nextOffset?: number; total: number } {
  const content = resource.text ?? ''
  const safeOffset = Math.max(0, Math.min(Math.floor(offset), content.length))
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 8_000))
  const text = content.slice(safeOffset, safeOffset + safeLimit)
  const nextOffset = safeOffset + text.length < content.length ? safeOffset + text.length : undefined
  return { text, offset: safeOffset, nextOffset, total: content.length }
}

export function searchAttachmentResources(resources: readonly AttachmentResource[], query: string, limit = 8): AttachmentSearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).map((term) => term.trim()).filter(Boolean)
  if (terms.length === 0) return []
  const hits: AttachmentSearchHit[] = []
  for (const resource of resources) {
    const content = resource.text ?? ''
    const sections = attachmentSections(content)
    const candidates = sections.length > 0 ? sections : [{ id: undefined, start: 0, end: content.length, preview: content }]
    for (const section of candidates) {
      const sectionText = content.slice(section.start, section.end)
      const lower = sectionText.toLowerCase()
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0)
      if (score === 0) continue
      const firstTerm = terms.find((term) => lower.includes(term)) ?? terms[0]
      const matchAt = Math.max(0, lower.indexOf(firstTerm))
      const start = Math.max(0, matchAt - 180)
      const excerpt = sectionText.slice(start, start + 700).trim()
      hits.push({
        attachmentId: resource.id,
        name: resource.name,
        ...(section.id ? { sectionId: section.id } : {}),
        start: section.start + start,
        end: section.start + start + excerpt.length,
        excerpt,
        score,
      })
    }
  }
  return hits.sort((left, right) => right.score - left.score || left.start - right.start).slice(0, Math.max(1, Math.min(limit, 20)))
}

export function formatAttachmentManifest(resources: readonly AttachmentResource[]): string {
  if (resources.length === 0) return ''
  const entries: string[] = []
  let remaining = MAX_MANIFEST_CHARS
  for (const resource of resources) {
    const metadata = [
      `- id: ${resource.id}`,
      `  name: ${resource.name}`,
      `  size: ${resource.size} bytes`,
      `  type: ${resource.mimeType ?? 'unknown'}`,
    ].join('\n')
    if (remaining <= metadata.length + 24) break
    const previewBudget = Math.max(0, Math.min(DEFAULT_PREVIEW_CHARS, remaining - metadata.length - 32))
    const preview = resource.text !== undefined && previewBudget > 0
      ? `  preview: ${attachmentPreview(resource.text, previewBudget)}`
      : '  preview: [content available through attachment tools]'
    const entry = `${metadata}\n${preview}`
    entries.push(entry)
    remaining -= entry.length
  }
  const omitted = resources.length - entries.length
  if (omitted > 0) entries.push(`- …还有 ${omitted} 个附件，请先使用 manifest 中的附件 ID 或 search_attachments 定位…`)
  return ['<attachments>', ...entries, '</attachments>'].join('\n')
}

export function createAttachmentResourceId(input: Pick<AttachmentResource, 'name' | 'size' | 'mimeType' | 'text' | 'mediaId'>): string {
  const source = `${input.name}\u0000${input.size}\u0000${input.mimeType ?? ''}\u0000${input.text ?? ''}\u0000${input.mediaId ?? ''}`
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `att-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}
