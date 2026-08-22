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

export interface AttachmentEvidencePack {
  content: string
  maxChars: number
  truncated: boolean
  entries: Array<{ attachmentId: string; name: string; sectionId: string; offset: number; end: number }>
}

export type AttachmentContextMode = 'inline' | 'retrieval'

export interface AttachmentRoutingInput {
  resources: readonly AttachmentResource[]
  userContent: string
  /** Provider context window in tokens. Defaults to a conservative 32k. */
  contextWindow?: number
  /** Estimated tokens already occupied by history and fixed prompt/tool schema. */
  reservedTokens?: number
}

const INLINE_ATTACHMENT_RATIO = 0.20
const DEFAULT_CONTEXT_WINDOW = 32_000

/**
 * Choose the low-latency attachment path only for explicit, single-turn-like
 * full-reading requests. Multi-turn work stays on retrieval so the text can
 * be budgeted and deduplicated between turns.
 */
export function chooseAttachmentContextMode(input: AttachmentRoutingInput): AttachmentContextMode {
  const resources = input.resources
  if (resources.length === 0 || resources.some((resource) => !resource.text?.trim())) return 'retrieval'
  if (!/(全文|完整阅读|通读|逐段阅读|全部内容|基于全文|阅读附件)/i.test(input.userContent)) return 'retrieval'
  if (/(多轮|分步骤|分阶段|先.+再|然后|多个交付物|分别|逐个|持续)/i.test(input.userContent)) return 'retrieval'

  // This is intentionally conservative: UTF-8/Unicode tokenization varies by
  // provider, so three characters per token avoids opting into an oversized
  // first request. The 20% cap leaves room for the answer and fixed context.
  const bodyTokens = resources.reduce((sum, resource) => sum + Math.ceil((resource.text?.length ?? 0) / 3), 0)
  const contextWindow = Math.max(1, input.contextWindow ?? DEFAULT_CONTEXT_WINDOW)
  const reservedTokens = Math.max(0, input.reservedTokens ?? 0)
  const available = Math.max(0, contextWindow - reservedTokens)
  return bodyTokens > 0 && bodyTokens <= available * INLINE_ATTACHMENT_RATIO ? 'inline' : 'retrieval'
}

export function formatInlineAttachments(resources: readonly AttachmentResource[]): string {
  const entries = resources
    .filter((resource) => resource.text?.trim())
    .map((resource) => `<attachment_full_text id="${escapeXmlAttribute(resource.id)}" name="${escapeXmlAttribute(resource.name)}">\n${resource.text}\n</attachment_full_text>`)
  return entries.length > 0
    ? `\n\n<attachments_inline>\n${entries.join('\n\n')}\n</attachments_inline>`
    : ''
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character] ?? character)
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

const DEFAULT_EVIDENCE_CHARS = 24_000
const MAX_EVIDENCE_CHARS = 48_000

/** Build one deterministic, source-addressable context pack for full-reading tasks. */
export function buildAttachmentEvidencePack(
  resources: readonly AttachmentResource[],
  attachmentIds?: readonly string[],
  requestedMaxChars = DEFAULT_EVIDENCE_CHARS,
): AttachmentEvidencePack | undefined {
  const selected = attachmentIds?.length
    ? resources.filter((resource) => attachmentIds.includes(resource.id))
    : [...resources]
  if (selected.length === 0) return undefined
  const maxChars = Math.max(1_000, Math.min(requestedMaxChars, MAX_EVIDENCE_CHARS))
  const entries: AttachmentEvidencePack['entries'] = []
  const chunks: string[] = []
  let used = 0
  for (const resource of selected) {
    if (resource.text === undefined) continue
    const sections = attachmentSections(resource.text)
    const candidates = sections.length > 0
      ? sections
      : (resource.text.trim() ? [{ id: 'section-01', start: 0, end: resource.text.length, preview: '' }] : [])
    for (const section of candidates) {
      const sectionText = resource.text.slice(section.start, section.end).trim()
      if (!sectionText) continue
      const prefix = `[source attachment:${resource.id} name:${resource.name} section:${section.id} offset:${section.start}]\n`
      const remaining = maxChars - used - prefix.length
      if (remaining <= 0) break
      const text = sectionText.length <= remaining
        ? sectionText
        : `${sectionText.slice(0, Math.max(1, remaining - 28)).trimEnd()}\n[…证据包已截断…]`
      entries.push({ attachmentId: resource.id, name: resource.name, sectionId: section.id, offset: section.start, end: section.start + text.length })
      chunks.push(`${prefix}${text}`)
      used += prefix.length + text.length + 2
      if (text.length < sectionText.length) break
    }
    if (used >= maxChars) break
  }
  if (entries.length === 0) return undefined
  return {
    content: chunks.join('\n\n'),
    maxChars,
    truncated: chunks.some((chunk) => chunk.includes('证据包已截断')),
    entries,
  }
}

export function searchAttachmentResources(resources: readonly AttachmentResource[], query: string, limit = 8): AttachmentSearchHit[] {
  // Treat the model's common `A OR B | C` syntax as alternatives. The old
  // whitespace-only parser treated the English token `or` as a real search
  // term and returned only the first match in a long document, which often
  // meant the introduction instead of the requested architecture section.
  const terms = query.toLowerCase()
    .split(/\s*(?:\bor\b|\||,|，|、)\s*/i)
    .flatMap((part) => part.split(/\s+/))
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && term !== 'or')
  if (terms.length === 0) return []
  const hits: AttachmentSearchHit[] = []
  for (const resource of resources) {
    const content = resource.text ?? ''
    const sections = attachmentSections(content)
    const candidates = sections.length > 0 ? sections : [{ id: undefined, start: 0, end: content.length, preview: content }]
    for (const section of candidates) {
      const sectionText = content.slice(section.start, section.end)
      const lower = sectionText.toLowerCase()
      for (const term of terms) {
        let cursor = lower.indexOf(term)
        let matches = 0
        while (cursor >= 0 && matches < 4) {
          const start = Math.max(0, cursor - 180)
          const excerpt = sectionText.slice(start, start + 700).trim()
          const excerptLower = excerpt.toLowerCase()
          const score = terms.reduce((sum, candidate) => sum + (excerptLower.includes(candidate) ? 1 : 0), 0)
          const absoluteStart = section.start + start
          const duplicate = hits.some((hit) =>
            hit.attachmentId === resource.id
            && hit.sectionId === section.id
            && Math.abs(hit.start - absoluteStart) < 160,
          )
          if (!duplicate) {
            hits.push({
              attachmentId: resource.id,
              name: resource.name,
              ...(section.id ? { sectionId: section.id } : {}),
              start: absoluteStart,
              end: absoluteStart + excerpt.length,
              excerpt,
              score,
            })
          }
          matches++
          cursor = lower.indexOf(term, cursor + term.length)
        }
      }
    }
  }
  return hits.sort((left, right) => right.score - left.score || left.start - right.start).slice(0, Math.max(1, Math.min(limit, 20)))
}

export function formatAttachmentManifest(resources: readonly AttachmentResource[], options: { includePreview?: boolean } = {}): string {
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
    const preview = options.includePreview === false
      ? '  preview: [content included in the bounded evidence pack below]'
      : resource.text !== undefined && previewBudget > 0
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
