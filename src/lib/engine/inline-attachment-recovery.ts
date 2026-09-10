/** Emergency, source-bound excerpts. Never mutates stored attachments/history. */
import type { Message } from './types'
import { clipGenericText, estimateTokens } from './context-budget'
import { formatAttachmentTextEntry, type AttachmentResource } from '../attachments/types'

export const MAX_RECOVERY_INLINE_TOKENS = 6_000
const NOTICE = '<attachment_recovery_notice>Attachment excerpts are incomplete. Repeated sources appear only at their latest occurrence. Omitted content is not evidence of absence; do not invent missing details.</attachment_recovery_notice>\n'

export interface InlineRecoveryStats {
  budgetTokens: number
  sourceTokens: number
  resultTokens: number
  matchedEntries: number
  compactedEntries: number
  removedDuplicates: number
  omittedSources: number
}

interface Entry {
  original: string
  resource: AttachmentResource
}
interface Occurrence { start: number; end: number; entry: Entry; replacement: string }

/** Only replace exact entries built from authoritative runtime resources.
 * Arbitrary XML-like text in the user's request is not parsed as an attachment. */
export function compactInlineAttachments(
  messages: readonly Message[],
  resources: readonly AttachmentResource[],
  budgetTokens: number,
): { messages: Message[]; stats: InlineRecoveryStats } {
  const stats: InlineRecoveryStats = { budgetTokens, sourceTokens: 0, resultTokens: 0,
    matchedEntries: 0, compactedEntries: 0, removedDuplicates: 0, omittedSources: 0 }
  const entries = [...new Map(resources.filter(resource => resource.text?.trim()).map(resource => {
    const original = formatAttachmentTextEntry(resource, resource.text!)
    return [original, { original, resource }] as const
  })).values()]
  const parts: { text: string; occurrences: Occurrence[] }[] = []
  const occurrences: Occurrence[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    const texts = typeof message.content === 'string' ? [message.content]
      : message.content.filter(part => part.type === 'text').map(part => part.text)
    for (const text of texts) {
      const found: Occurrence[] = []
      for (const entry of entries) {
        let start = text.indexOf(entry.original)
        while (start >= 0) {
          found.push({ start, end: start + entry.original.length, entry, replacement: '' })
          start = text.indexOf(entry.original, start + entry.original.length)
        }
      }
      found.sort((a, b) => a.start - b.start || b.end - a.end)
      const selected: Occurrence[] = []
      for (const item of found) {
        if (!selected.length || item.start >= selected.at(-1)!.end) selected.push(item)
      }
      parts.push({ text, occurrences: selected })
      occurrences.push(...selected)
    }
  }
  stats.matchedEntries = occurrences.length
  stats.sourceTokens = occurrences.reduce((sum, item) => sum + estimateTokens(item.entry.original), 0)
  stats.resultTokens = stats.sourceTokens
  if (!occurrences.length || stats.sourceTokens <= budgetTokens) return { messages: [...messages], stats }

  const latest = new Map<Entry, Occurrence>()
  for (const item of occurrences) latest.set(item.entry, item)
  const unique = occurrences.filter(item => latest.get(item.entry) === item)
  stats.removedDuplicates = occurrences.length - unique.length
  let remaining = Math.max(0, budgetTokens - estimateTokens(NOTICE))
  unique.forEach((item, index) => {
    const share = Math.floor(remaining / (unique.length - index))
    item.replacement = excerpt(item.entry, share)
    remaining -= estimateTokens(item.replacement)
    if (!item.replacement) stats.omittedSources++
  })
  // One bounded notice replaces any number of duplicated/omitted source bodies.
  unique.at(-1)!.replacement += NOTICE
  stats.compactedEntries = occurrences.filter(item => item.replacement !== item.entry.original).length
  stats.resultTokens = occurrences.reduce((sum, item) => sum + estimateTokens(item.replacement), 0)
  if (stats.resultTokens > budgetTokens) throw new Error('Inline recovery metadata exceeds its budget')

  let index = 0
  const nextText = () => {
    const part = parts[index++]
    let output = '', offset = 0
    for (const item of part.occurrences) {
      output += part.text.slice(offset, item.start) + item.replacement
      offset = item.end
    }
    return output + part.text.slice(offset)
  }
  return {
    stats,
    messages: messages.map(message => message.role !== 'user' ? message : {
      ...message,
      content: typeof message.content === 'string' ? nextText()
        : message.content.map(part => part.type === 'text' ? { ...part, text: nextText() } : part),
    }),
  }
}

function excerpt(entry: Entry, budget: number): string {
  if (estimateTokens(entry.original) <= budget) return entry.original
  const empty = formatAttachmentTextEntry(entry.resource, '', true)
  const bodyBudget = budget - estimateTokens(empty)
  if (bodyBudget < 1) return ''
  const text = entry.resource.text!
  // Extracted .md files also contain plain numbered headings, not just '#'.
  const headings = [...text.matchAll(/^(?:#{1,6}\s+|[一二三四五六七八九十百]+、|\d+(?:\.\d+){1,4}\s+)[^\n]{1,120}$/gm)]
  const boundaries = [...new Set([0, ...headings.map(match => match.index!), text.length])]
  const count = boundaries.length - 1
  const share = Math.max(1, Math.floor((bodyBudget - count) / Math.max(1, count)))
  const headingStarts = new Set(headings.map(match => match.index!))
  const sections = boundaries.slice(0, -1).map((start, index) => {
    const section = text.slice(start, boundaries[index + 1])
    const lineEnd = section.indexOf('\n')
    if (headingStarts.has(start) && lineEnd >= 0) {
      const heading = section.slice(0, lineEnd)
      const contentBudget = share - estimateTokens(heading) - 1
      if (contentBudget >= 0) return `${heading}\n${clipGenericText(section.slice(lineEnd + 1), contentBudget).clipped}`
    }
    return clipGenericText(section, share).clipped
  }).join('\n\n')
  const body = clipGenericText(sections, bodyBudget).clipped
  return formatAttachmentTextEntry(entry.resource, body, true)
}
