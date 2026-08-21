/**
 * Context assembly and budget management
 * @module lib/engine/context-budget
 * @see docs/specs/agent-loop.md §6
 */

import type { QueryContext } from './types'
import type { ClaudeMessage, ClaudeContent } from './messages'
import type { MemoryState } from '../memory/types'

/**
 * Token estimation.
 *
 * ~4 characters per token holds for Latin text but is ~4x optimistic for CJK,
 * where a character is roughly one token. This product is Chinese-first, so the
 * two ranges are counted separately — a uniform /4 would let a long Chinese
 * conversation report a quarter of its real cost and blow past the window.
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let characters = 0
  for (const char of text) {
    characters++
    const code = char.codePointAt(0) ?? 0
    if (
      (code >= 0x3040 && code <= 0x30ff)   // kana
      || (code >= 0x3400 && code <= 0x4dbf) // CJK ext A
      || (code >= 0x4e00 && code <= 0x9fff) // CJK unified
      || (code >= 0xf900 && code <= 0xfaff) // compatibility ideographs
      || (code >= 0xac00 && code <= 0xd7af) // hangul
      || (code >= 0x20000 && code <= 0x2ebef) // CJK ext B-F
    ) cjk++
  }
  const rest = characters - cjk
  return Math.ceil(cjk + rest / 4)
}

/**
 * Estimate tokens for message content
 */
export function estimateMessageTokens(content: string | ClaudeContent[]): number {
  if (typeof content === 'string') {
    return estimateTokens(content)
  }

  return content.reduce((sum, part) => {
    if (part.type === 'text') {
      return sum + estimateTokens(part.text)
    }
    if (part.type === 'tool_use') {
      return sum + estimateTokens(JSON.stringify(part.input)) + 20 // overhead
    }
    if (part.type === 'tool_result') {
      return sum + estimateTokens(part.content) + 20
    }
    if (part.type === 'image_url') {
      return sum + 1000 // rough estimate for image tokens
    }
    return sum
  }, 0)
}

/**
 * Context budget configuration
 */
export interface ContextBudget {
  /** Total available tokens */
  total: number
  /** Measured system prompt cost (not trimmable) */
  system: number
  /** Native tool definitions sent beside the messages. */
  tools: number
  /** Reserved for output generation */
  output: number
  /** Remaining for messages and tool results */
  available: number
}

/**
 * Conservative fallback when the provider does not report a context window.
 * Deliberately not 200k: assuming Claude-sized windows overflows every smaller
 * model (DeepSeek, gpt-*-16k, custom OpenAI-compatible endpoints) with a hard
 * provider 400 that trimming never gets a chance to prevent.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/**
 * Calculate context budget from model config.
 *
 * `systemPrompt` must be the *actual* assembled system prompt. It is never
 * trimmed, so it has to be measured rather than assumed — it carries the skill
 * body, the tool section and retrieved context, all of which vary by orders of
 * magnitude.
 */
export function calculateBudget(ctx: QueryContext, systemPrompt = '', toolTokens = 0): ContextBudget {
  const declared = ctx.model?.contextWindow
  const total = declared && declared > 0 ? declared : DEFAULT_CONTEXT_WINDOW
  const output = ctx.limits.maxOutputTokens || 4096
  const system = estimateTokens(systemPrompt)

  // Never hand back a negative or absurdly small budget: if the system prompt
  // alone crowds out the window, still allow a floor so the run can report a
  // real provider error rather than sending zero messages.
  const tools = Math.max(0, toolTokens)
  const available = Math.max(1024, total - output - system - tools)

  return { total, system, tools, output, available }
}

export interface InputSlotBudgets {
  /** Proactive workspace-memory disclosure on the first turn. */
  retrieved: number
  /** Cumulative inline budget across every tool result in the request. */
  toolResults: number
}

/**
 * Allocate bounded input slots before generic history trimming. This prevents
 * several individually-small tool results from collectively monopolizing the
 * context window. Compact recovery deliberately discloses much less evidence.
 */
export function calculateInputSlotBudgets(ctx: QueryContext, budget: ContextBudget): InputSlotBudgets {
  const compact = ctx.inputMode === 'compact_recovery'
  return {
    retrieved: Math.max(256, Math.min(compact ? 512 : 1_500, Math.floor(budget.available * (compact ? 0.04 : 0.1)))),
    toolResults: Math.max(512, Math.min(compact ? 2_000 : 12_000, Math.floor(budget.available * (compact ? 0.12 : 0.3)))),
  }
}

/**
 * Handle threshold for large tool results (24KB). This matches the maximum
 * read_handle chunk so a retrieved chunk is not immediately handleized again.
 */
export const HANDLE_THRESHOLD = 24_000

/**
 * Handleize large tool result.
 *
 * Storing the payload is best-effort: a failed store (disk full, read-only
 * volume, revoked workspace) must degrade to inline truncation, never reject.
 * `executeCall` promises it always returns a ToolResult, and this sits on that
 * path — a rejection here would leave every `tool_use` in the turn unanswered.
 */
export async function handleizeLargeResult(
  content: string,
  memory?: MemoryState,
): Promise<{ content: string; isHandleized: boolean; handle?: string }> {
  const bytes = new TextEncoder().encode(content).byteLength
  if (bytes <= HANDLE_THRESHOLD) {
    return { content, isHandleized: false }
  }

  const summary = safeSummary(content)
  if (!memory) {
    return {
      content: `${summary}\n\n[Result truncated: ${bytes} bytes, ${[...content].length} characters total.]`,
      isHandleized: true,
    }
  }

  let handle: string
  try {
    handle = await memory.store(content)
  } catch (error) {
    console.warn('[context-budget] Unable to store large result, truncating inline:', error)
    return {
      content: `${summary}\n\n[Result truncated: ${bytes} bytes, ${[...content].length} characters total. Storage was unavailable, so the full content cannot be retrieved.]`,
      isHandleized: true,
    }
  }

  const truncated = `${summary}\n\n[Result stored as ${handle}: ${bytes} bytes, ${[...content].length} characters total. Use read_handle to retrieve it.]`
  return { content: truncated, isHandleized: true, handle }
}

/**
 * First 500 *characters* — slicing UTF-16 code units can split a surrogate pair
 * and emit a lone surrogate, which becomes U+FFFD on the wire.
 */
function safeSummary(content: string): string {
  let out = ''
  let count = 0
  for (const char of content) {
    if (count >= 500) break
    out += char
    count++
  }
  return out
}

/**
 * Trim messages to fit budget.
 *
 * Strategy: keep the most recent messages. The cut must never land between an
 * assistant `tool_use` and the `user` message carrying its `tool_result` — the
 * APIs reject an unpaired block — so trimming works on *turn groups*: an
 * assistant message and the tool-result message that answers it are kept or
 * dropped together. The first kept message is also forced to `user` role.
 *
 * Always returns at least one message; an empty array is an API error.
 */
export function trimMessages(
  messages: ClaudeMessage[],
  availableTokens: number,
): ClaudeMessage[] {
  if (messages.length === 0) return messages

  const groups = groupByToolPairing(messages)
  let totalTokens = 0
  const kept: ClaudeMessage[][] = []

  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]
    const tokens = group.reduce((sum, msg) => sum + estimateMessageTokens(msg.content), 0)
    if (totalTokens + tokens > availableTokens) {
      // The newest message is often an attachment-expanded user prompt. The
      // old logic always kept that first group even when it was many times
      // larger than the entire model window, bypassing the budget completely.
      if (kept.length === 0) {
        const fitted = fitOversizedStandaloneMessage(group, availableTokens)
        if (fitted) kept.unshift([fitted])
      }
      break
    }
    totalTokens += tokens
    kept.unshift(group)
  }

  const flat = kept.flat()
  // A conversation may not start mid-turn. Strip from the front while the first
  // message is an assistant turn or a bare tool_result — because groups keep
  // pairs together, this removes a whole unusable turn rather than half of one
  // (stripping only the assistant would orphan its tool_result).
  while (flat.length > 0 && (flat[0].role === 'assistant' || hasBlock(flat[0], 'tool_result'))) {
    flat.shift()
  }
  if (flat.length > 0) return flat

  // Nothing viable fit: fall back to the most recent standalone user message.
  // Over budget, but valid — the provider can then report a real error instead
  // of us sending an empty or unpaired request.
  const fallback = [...messages].reverse().find(
    msg => msg.role === 'user' && !hasBlock(msg, 'tool_result'),
  )
  return fallback
    ? [fitOversizedMessage(fallback, availableTokens)]
    : messages.slice(-1)
}

function fitOversizedStandaloneMessage(group: ClaudeMessage[], availableTokens: number): ClaudeMessage | undefined {
  if (group.length !== 1 || group[0].role !== 'user') return undefined
  return fitOversizedMessage(group[0], availableTokens)
}

export interface MessageStructure {
  userQuestion?: string
  attachments: Attachment[]
}

export interface Attachment {
  content: string
  type: 'log' | 'code' | 'data' | 'json' | 'text'
  metadata?: { language?: string; hasErrors?: boolean; lineCount?: number }
}

export interface ClippedAttachment {
  clipped: string
  omittedLines?: number
}

const CONTEXT_OMISSION = '\n\n[... content omitted to fit the model context budget ...]\n\n'

/** Fit an oversized user message while preserving intent, useful diagnostics,
 * and non-text content blocks. Assistant/tool messages are never rewritten. */
export function fitOversizedMessage(message: ClaudeMessage, availableTokens: number): ClaudeMessage {
  if (message.role !== 'user') return message
  if (typeof message.content === 'string') return fitOversizedTextMessage(message, availableTokens)
  return fitOversizedMultiBlockMessage(message, availableTokens)
}

function fitOversizedTextMessage(message: ClaudeMessage, availableTokens: number): ClaudeMessage {
  if (typeof message.content !== 'string' || estimateTokens(message.content) <= availableTokens) return message
  const structure = parseMessageStructure(message.content)
  const question = structure.userQuestion
  const questionBudget = question ? estimateTokens(question) : 0

  if (question && questionBudget >= availableTokens) {
    return { ...message, content: clipGenericText(question, availableTokens).clipped }
  }

  const attachments = structure.attachments
  const attachmentBudget = Math.max(0, availableTokens - questionBudget - (attachments.length > 0 ? estimateTokens('\n\n') : 0))
  const perAttachment = attachments.length > 0 ? Math.floor(attachmentBudget / attachments.length) : 0
  const parts = [question, ...attachments.map(att => clipAttachment(att, perAttachment).clipped)].filter(Boolean)
  let content = parts.join('\n\n')
  // Type-specific previews are best effort; the final generic fit guarantees
  // the advertised token ceiling when markers or CJK text add overhead.
  if (estimateTokens(content) > availableTokens) content = clipGenericText(content, availableTokens).clipped
  return { ...message, content }
}

function fitOversizedMultiBlockMessage(message: ClaudeMessage, availableTokens: number): ClaudeMessage {
  if (typeof message.content === 'string') return fitOversizedTextMessage(message, availableTokens)
  const blocks = message.content
  const total = estimateMessageTokens(blocks)
  if (total <= availableTokens) return message
  const textBlocks = blocks.filter(part => part.type === 'text')
  const immutable = blocks.reduce((sum, part) => sum + (part.type === 'text' ? 0 : estimateMessageTokens([part])), 0)
  const textBudget = Math.max(0, availableTokens - immutable)
  const textTotal = textBlocks.reduce((sum, part) => sum + estimateTokens(part.text), 0)
  const clipped = blocks.map(part => {
    if (part.type !== 'text') return part
    const budget = textTotal > 0 ? Math.floor(textBudget * estimateTokens(part.text) / textTotal) : 0
    return { ...part, text: clipMessageText(part.text, budget) }
  })
  return { ...message, content: clipped }
}

function clipMessageText(text: string, budget: number): string {
  // Non-text blocks are immutable, so in an exceptionally tight mixed message
  // they can consume the whole estimate. Keep one code point rather than emit
  // an invalid empty text block; preserving block structure wins in that case.
  if (budget <= 0) return [...text][0] ?? ''
  if (estimateTokens(text) <= budget) return text
  const structure = parseMessageStructure(text)
  const questionTokens = structure.userQuestion ? estimateTokens(structure.userQuestion) : 0
  if (structure.userQuestion && questionTokens >= budget) return clipGenericText(structure.userQuestion, budget).clipped
  const remaining = Math.max(0, budget - questionTokens - estimateTokens('\n\n'))
  const perAttachment = structure.attachments.length ? Math.floor(remaining / structure.attachments.length) : remaining
  const parts = [structure.userQuestion, ...structure.attachments.map(att => clipAttachment(att, perAttachment).clipped)].filter(Boolean)
  const result = parts.join('\n\n')
  return estimateTokens(result) <= budget ? result : clipGenericText(result, budget).clipped
}

/** Detect a short user request followed by one or more attached documents. */
export function parseMessageStructure(text: string): MessageStructure {
  const separators: number[] = []
  const doubleBreak = /\n\n/g
  let match: RegExpExecArray | null
  while ((match = doubleBreak.exec(text))) separators.push(match.index + 2)
  separators.push(...Array.from(text.matchAll(/\n(?=```|(?:INFO|DEBUG|WARN|ERROR|TRACE|FATAL)[:\s])/g), m => (m.index ?? 0) + 1))
  const pathMarker = text.match(/\n?(\/[^\n:]+\.(?:log|txt|csv|tsv|json|[cm]?[jt]sx?|py|java)):\s*/i)
  if (pathMarker?.index !== undefined) {
    separators.push(pathMarker.index + pathMarker[0].lastIndexOf('\n') + 1)
  }
  for (const point of separators.sort((a, b) => a - b)) {
    const question = text.slice(0, point).trim()
    const attachment = text.slice(point).trim()
    if (question.length <= 1000 && attachment.length >= 500) {
      return { userQuestion: question, attachments: [detectAttachmentType(attachment)] }
    }
  }
  return { attachments: [detectAttachmentType(text)] }
}

export function detectAttachmentType(content: string): Attachment {
  const lineCount = content.split('\n').length
  if (/\b(ERROR|WARN|WARNING|FATAL|Exception|Traceback)\b/i.test(content)) {
    return { content, type: 'log', metadata: { hasErrors: true, lineCount } }
  }
  if (/^\s*(import|from|package|use|require|class|function|def|const|let|var)\b/m.test(content)) {
    return { content, type: 'code', metadata: { language: detectLanguage(content), lineCount } }
  }
  const trimmed = content.trim()
  const fencedMarkdown = /^```[\w-]*\s[\s\S]*```$/.test(trimmed)
  if (!fencedMarkdown && /^\s*(?:\[|\{)/.test(content) && /(?:}|\])\s*$/.test(content)) {
    try { JSON.parse(content); return { content, type: 'json', metadata: { lineCount } } } catch { /* fall through */ }
  }
  const lines = content.split('\n')
  if (lines.length >= 2 && /^[^\n,\t]+(?:[,\t][^\n,\t]+)+$/.test(lines[0])) {
    return { content, type: 'data', metadata: { lineCount } }
  }
  return { content, type: 'text', metadata: { lineCount } }
}

function detectLanguage(content: string): string | undefined {
  if (/\b(interface|type)\s+\w+|:\s*(string|number|boolean)\b/.test(content)) return 'typescript'
  if (/\b(def|from\s+\w+\s+import)\b/.test(content)) return 'python'
  if (/\b(package|func|go\s)/.test(content)) return 'go'
  if (/\b(public\s+class|System\.out)\b/.test(content)) return 'java'
  return undefined
}

export function clipAttachment(attachment: Attachment, targetTokens: number): ClippedAttachment {
  if (targetTokens <= 0) return { clipped: '' }
  switch (attachment.type) {
    case 'log': return clipLogFile(attachment.content, targetTokens)
    case 'code': return clipCodeFile(attachment.content, targetTokens)
    case 'json': return clipJsonContent(attachment.content, targetTokens)
    case 'data': return clipDataFile(attachment.content, targetTokens)
    default: return clipGenericText(attachment.content, targetTokens)
  }
}

export function clipLogFile(content: string, targetTokens: number): ClippedAttachment {
  const lines = content.split('\n')
  const critical: number[] = []
  lines.forEach((line, i) => {
    if (/ERROR|WARN|WARNING|FATAL|Exception|Traceback/i.test(line)) critical.push(i)
  })

  // Error/warning lines are the one irreplaceable part of a log preview. Add
  // those first, then spend the remaining budget on their context and the file
  // boundaries. This avoids a generic character clip cutting an error in half.
  const kept = new Set(critical)
  const contextCandidates = critical.flatMap(i => [i - 2, i - 1, i + 1, i + 2])
  const boundaryCandidates = [
    ...Array.from({ length: Math.min(10, lines.length) }, (_, i) => i),
    ...Array.from({ length: Math.min(10, lines.length) }, (_, i) => lines.length - 1 - i),
  ]
  for (const idx of [...contextCandidates, ...boundaryCandidates]) {
    if (idx < 0 || idx >= lines.length || kept.has(idx)) continue
    const candidate = new Set(kept).add(idx)
    if (estimateTokens(formatLogSelection(lines, candidate)) <= targetTokens) kept.add(idx)
  }

  const clipped = formatLogSelection(lines, kept)
  if (estimateTokens(clipped) > targetTokens) {
    const criticalOnly = formatLogSelection(lines, new Set(critical))
    return clipGenericText(criticalOnly, targetTokens)
  }
  return { clipped, omittedLines: lines.length - kept.size }
}

function formatLogSelection(lines: string[], kept: Set<number>): string {
  const indices = [...kept].sort((a, b) => a - b)
  const output: string[] = []
  indices.forEach((idx, i) => {
    if (i > 0 && idx > indices[i - 1] + 1) output.push(`[... ${idx - indices[i - 1] - 1} lines omitted ...]`)
    output.push(lines[idx])
  })
  return output.join('\n')
}

export function clipCodeFile(content: string, targetTokens: number): ClippedAttachment {
  const lines = content.split('\n')
  const imports = lines.slice(0, 30).filter(line => /^\s*(import|from|package|use|require)\b/i.test(line))
  const signatures = lines.filter(line => /^\s*(export\s+)?(async\s+)?(function|class|interface|type)\b|^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*\(/i.test(line))
  const preview = [
    '// Imports:', imports.join('\n'),
    '// Function/Class signatures:', signatures.join('\n'),
    '// File beginning:', lines.slice(0, 15).join('\n'),
    '[... middle content omitted ...]',
    '// File end:', lines.slice(-15).join('\n'),
  ].filter(Boolean).join('\n')
  return estimateTokens(preview) <= targetTokens
    ? { clipped: preview, omittedLines: Math.max(0, lines.length - 30) }
    : clipGenericText(content, targetTokens)
}

export function clipJsonContent(content: string, targetTokens: number): ClippedAttachment {
  try { return { clipped: fitStructuredText(JSON.stringify(createJsonSkeleton(JSON.parse(content), 0, 0), null, 2), targetTokens) } }
  catch { return clipGenericText(content, targetTokens) }
}

function createJsonSkeleton(value: unknown, _targetTokens: number, depth: number): unknown {
  if (depth > 3) return '...'
  if (Array.isArray(value)) {
    if (value.length <= 3) return value.map(item => createJsonSkeleton(item, _targetTokens, depth + 1))
    return [createJsonSkeleton(value[0], _targetTokens, depth + 1), `... ${value.length - 2} items omitted ...`, createJsonSkeleton(value[value.length - 1], _targetTokens, depth + 1)]
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    return Object.fromEntries(entries.length <= 5
      ? entries.map(([key, item]) => [key, createJsonSkeleton(item, _targetTokens, depth + 1)])
      : [...entries.slice(0, 3).map(([key, item]) => [key, createJsonSkeleton(item, _targetTokens, depth + 1)]), ['...', `${entries.length - 3} keys omitted`]])
  }
  return value
}

export function clipDataFile(content: string, targetTokens: number): ClippedAttachment {
  const lines = content.split('\n')
  if (lines.length <= 20) return { clipped: fitStructuredText(content, targetTokens) }
  const sampleSize = Math.max(1, Math.min(10, Math.floor(targetTokens / 20)))
  const step = Math.max(1, Math.ceil((lines.length - 3) / sampleSize))
  const sampled = [...lines.slice(0, 3), `[... showing sampled rows of ${lines.length - 3} data rows ...]`]
  for (let i = 3; i < lines.length && sampled.length < sampleSize + 4; i += step) sampled.push(lines[i])
  const clipped = fitStructuredText(sampled.join('\n'), targetTokens)
  return { clipped, omittedLines: Math.max(0, lines.length - sampled.length + 1) }
}

export function clipGenericText(content: string, targetTokens: number): ClippedAttachment {
  if (targetTokens <= 0) return { clipped: '' }
  if (estimateTokens(content) <= targetTokens) return { clipped: content }
  const marker = CONTEXT_OMISSION
  const markerTokens = estimateTokens(marker) * 2
  if (markerTokens >= targetTokens) return { clipped: fitPrefix(content, targetTokens) }
  let low = 0
  let high = [...content].length
  while (low < high) {
    const keep = Math.ceil((low + high) / 2)
    const candidate = sampledText(content, keep, marker)
    if (estimateTokens(candidate) <= targetTokens) low = keep
    else high = keep - 1
  }
  return { clipped: sampledText(content, low, marker) }
}

function fitStructuredText(text: string, targetTokens: number): string {
  return estimateTokens(text) <= targetTokens ? text : clipGenericText(text, targetTokens).clipped
}

function sampledText(text: string, keepCharacters: number, marker: string): string {
  const chars = [...text]
  const head = Math.ceil(keepCharacters * 0.4)
  const middle = Math.ceil(keepCharacters * 0.2)
  const tail = Math.max(0, keepCharacters - head - middle)
  const middleStart = Math.max(0, Math.floor(chars.length / 2 - middle / 2))
  return `${chars.slice(0, head).join('')}${marker}${chars.slice(middleStart, middleStart + middle).join('')}${marker}${chars.slice(-tail).join('')}`
}

function fitPrefix(text: string, maxTokens: number): string {
  let low = 0
  let high = [...text].length
  const chars = [...text]
  while (low < high) {
    const length = Math.ceil((low + high) / 2)
    if (estimateTokens(chars.slice(0, length).join('')) <= maxTokens) low = length
    else high = length - 1
  }
  return chars.slice(0, low).join('')
}

/**
 * Group messages so that an assistant message containing `tool_use` stays with
 * the message(s) carrying the matching `tool_result`s.
 */
function groupByToolPairing(messages: ClaudeMessage[]): ClaudeMessage[][] {
  const groups: ClaudeMessage[][] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    const group = [message]
    if (hasBlock(message, 'tool_use')) {
      // Absorb every following message that answers this turn's tool calls.
      while (i + 1 < messages.length && hasBlock(messages[i + 1], 'tool_result')) {
        group.push(messages[++i])
      }
    }
    groups.push(group)
  }
  return groups
}

function hasBlock(message: ClaudeMessage, type: 'tool_use' | 'tool_result'): boolean {
  return typeof message.content !== 'string' && message.content.some(part => part.type === type)
}

/**
 * Process messages with budget constraints
 * - Handleize large tool results
 * - Trim old messages if needed (pair-aware)
 * - Remove orphan tool_result (M1-11 tombstoning)
 *
 * Order matters: trimming must happen *before* orphan removal. Trimming drops
 * whole turns from the front, which can strand a `tool_result` whose `tool_use`
 * was cut; running the orphan sweep first would leave that unpaired block in the
 * request and the provider rejects it with a hard 400 that reproduces on every
 * retry, because the same history is rebuilt each turn.
 */
export async function applyBudget(
  ctx: QueryContext,
  messages: ClaudeMessage[],
  systemPrompt = '',
  toolTokens = 0,
): Promise<ClaudeMessage[]> {
  const budget = calculateBudget(ctx, systemPrompt, toolTokens)
  const slots = calculateInputSlotBudgets(ctx, budget)

  // Step 1: Handleize large tool results
  const processedMessages = await Promise.all(messages.map(async msg => {
    if (typeof msg.content === 'string') {
      return msg
    }

    const processedContent = await Promise.all(msg.content.map(async part => {
      if (part.type === 'tool_result') {
        const { content, isHandleized } = await handleizeLargeResult(part.content, ctx.memory)
        if (isHandleized) {
          console.debug(`[context-budget] Handleized tool result ${part.tool_use_id}`)
        }
        return { ...part, content }
      }
      return part
    }))

    return { ...msg, content: processedContent }
  }))

  // Step 2: Cheap Hermes-style local cleanup. Identical historical payloads
  // are replaced before slot accounting, so the same attachment read cannot
  // consume the budget once per retry.
  const deduplicatedMessages = deduplicateToolResults(processedMessages)

  // Step 3: Bound tool-result history as a cumulative slot. Results are kept
  // newest-first; older payloads retain a small model-visible tombstone so the
  // tool_use/tool_result protocol pairing remains valid.
  const slottedMessages = capToolResultContext(deduplicatedMessages, slots.toolResults)

  // Step 4: Trim if over budget
  const currentTokens = slottedMessages.reduce(
    (sum, msg) => sum + estimateMessageTokens(msg.content),
    0,
  )
  const trimmed = currentTokens > budget.available
    ? trimMessages(slottedMessages, budget.available)
    : slottedMessages
  if (trimmed.length !== slottedMessages.length) {
    console.debug(
      `[context-budget] Trimmed ${slottedMessages.length - trimmed.length} message(s): ${currentTokens} > ${budget.available}`,
    )
  }

  // Step 5: M1-11 - Detect and remove orphan tool_results left by the trim
  const { cleanedMessages, orphanCount } = removeOrphanToolResults(trimmed)
  if (orphanCount > 0) {
    console.warn(`[context-budget] Removed ${orphanCount} orphan tool_result(s)`)
  }

  // Step 6: Drop messages the sweep emptied — both APIs reject empty content
  const nonEmpty = cleanedMessages.filter(
    msg => typeof msg.content === 'string' ? msg.content.length > 0 : msg.content.length > 0,
  )

  return nonEmpty.length > 0 ? nonEmpty : messages.slice(-1)
}

const OMITTED_TOOL_RESULT = '[Earlier result omitted; re-read if needed.]'
export const DUPLICATE_TOOL_RESULT = '[Duplicate tool output omitted; the latest identical result is retained.]'

/**
 * Replace repeated long tool payloads with a short marker before generic
 * token-budget trimming. The message/block shape is unchanged, preserving
 * provider pairing invariants. Only payloads over 200 characters are touched;
 * short errors and status values are cheap and often semantically distinct.
 */
export function deduplicateToolResults(messages: ClaudeMessage[]): ClaudeMessage[] {
  const output = messages.map((message) => ({
    ...message,
    content: typeof message.content === 'string' ? message.content : [...message.content],
  }))
  const firstByContent = new Map<string, { messageIndex: number; partIndex: number }>()
  for (let messageIndex = 0; messageIndex < output.length; messageIndex++) {
    const content = output[messageIndex].content
    if (typeof content === 'string') continue
    for (let partIndex = 0; partIndex < content.length; partIndex++) {
      const part = content[partIndex]
      if (part.type !== 'tool_result' || part.content.length <= 200) continue
      const previous = firstByContent.get(part.content)
      if (previous) {
        const previousMessage = output[previous.messageIndex]
        if (typeof previousMessage.content !== 'string') {
          const previousPart = previousMessage.content[previous.partIndex]
          if (previousPart.type === 'tool_result') {
            previousMessage.content[previous.partIndex] = { ...previousPart, content: DUPLICATE_TOOL_RESULT }
          }
        }
      }
      firstByContent.set(part.content, { messageIndex, partIndex })
    }
  }
  return output
}

/**
 * Keep recent tool evidence within a single cumulative token allowance.
 * Exported for boundary tests because this is a core progressive-disclosure
 * invariant, not a provider implementation detail.
 */
export function capToolResultContext(messages: ClaudeMessage[], maxTokens: number): ClaudeMessage[] {
  const output = messages.map((message) => ({
    ...message,
    content: typeof message.content === 'string' ? message.content : [...message.content],
  }))
  const results: Array<{ messageIndex: number; partIndex: number; content: string }> = []

  for (let messageIndex = 0; messageIndex < output.length; messageIndex++) {
    const content = output[messageIndex].content
    if (typeof content === 'string') continue
    for (let partIndex = 0; partIndex < content.length; partIndex++) {
      const part = content[partIndex]
      if (part.type === 'tool_result') results.push({ messageIndex, partIndex, content: part.content })
    }
  }

  const markerTokens = estimateTokens(OMITTED_TOOL_RESULT)
  // Reserve a valid non-empty result for every tool call before spending the
  // rest on recent evidence. maxToolCalls is bounded, so the 512-token floor in
  // calculateInputSlotBudgets covers this reserve in normal operation.
  let remaining = Math.max(0, maxTokens - markerTokens * results.length)
  for (const result of results) {
    const message = output[result.messageIndex]
    if (typeof message.content === 'string') continue
    const part = message.content[result.partIndex]
    if (part.type === 'tool_result') message.content[result.partIndex] = { ...part, content: OMITTED_TOOL_RESULT }
  }

  for (let index = results.length - 1; index >= 0 && remaining > 0; index--) {
    const result = results[index]
    const message = output[result.messageIndex]
    if (typeof message.content === 'string') continue
    const part = message.content[result.partIndex]
    if (part.type !== 'tool_result') continue
    const originalTokens = estimateTokens(result.content)
    const extraForFull = Math.max(0, originalTokens - markerTokens)
    if (extraForFull <= remaining) {
      message.content[result.partIndex] = { ...part, content: result.content }
      remaining -= extraForFull
      continue
    }
    const separatorTokens = estimateTokens('\n\n')
    const previewBudget = Math.max(0, remaining - separatorTokens)
    const preview = previewBudget > 0 ? clipGenericText(result.content, previewBudget).clipped.trim() : ''
    const replacement = preview ? `${preview}\n\n${OMITTED_TOOL_RESULT}` : OMITTED_TOOL_RESULT
    message.content[result.partIndex] = { ...part, content: replacement }
    remaining = 0
  }

  return output
}

/**
 * Remove orphan tool_result blocks that don't have corresponding tool_use
 * M1-11: Tombstoning strategy
 */
function removeOrphanToolResults(
  messages: ClaudeMessage[],
): { cleanedMessages: ClaudeMessage[]; orphanCount: number } {
  // Collect all tool_use IDs
  const toolUseIds = new Set<string>()
  for (const msg of messages) {
    if (typeof msg.content !== 'string') {
      for (const part of msg.content) {
        if (part.type === 'tool_use') {
          toolUseIds.add(part.id)
        }
      }
    }
  }

  // Filter out orphan tool_results
  let orphanCount = 0
  const cleanedMessages = messages.map(msg => {
    if (typeof msg.content === 'string') {
      return msg
    }

    const filteredContent = msg.content.filter(part => {
      if (part.type === 'tool_result') {
        const hasParent = toolUseIds.has(part.tool_use_id)
        if (!hasParent) {
          orphanCount++
          console.debug(
            `[context-budget] Orphan tool_result detected: ${part.tool_use_id}`,
          )
          return false // Remove orphan
        }
      }
      return true
    })

    return { ...msg, content: filteredContent }
  })

  return { cleanedMessages, orphanCount }
}

/**
 * Get budget status for debugging/monitoring
 */
export function getBudgetStatus(ctx: QueryContext, messages: ClaudeMessage[]) {
  const budget = calculateBudget(ctx)
  const usedTokens = messages.reduce(
    (sum, msg) => sum + estimateMessageTokens(msg.content),
    0,
  )

  return {
    budget,
    used: usedTokens,
    available: budget.available,
    utilization: Math.round((usedTokens / budget.available) * 100),
  }
}
