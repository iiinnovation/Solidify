import type { QueryContext } from './types'
import { buildMessages } from './messages'
import { estimateTokens } from './context-budget'
import { assertContextBudgetSnapshot } from './context-budget-gate'
import type { ToolDefinition } from '../model'

export interface CompiledContextStats {
  slots: {
    systemTokens: number
    fixedSystemTokens: number
    skillTokens: number
    toolsTokens: number
    historyTokens: number
    attachmentTokens: number
    runtimeTokens: number
    currentTaskTokens: number
  }
  skillIndexTokens: number
  inlineAttachmentPreviewTokens: number
  rawHistoryTokens: number
  finalHistoryTokens: number
  historyTrimmed: boolean
  fixedPrefixFingerprint: string
  cacheable: { tools: boolean; system: boolean; skill: boolean }
}

type BuiltMessages = Awaited<ReturnType<typeof buildMessages>>

export interface CompiledContext {
  system: string
  messages: BuiltMessages['messages']
  tools: ToolDefinition[]
  skillTokens: BuiltMessages['skillTokens']
  stats: CompiledContextStats
}

/**
 * Compile the model-visible context into stable and dynamic slots.
 *
 * The compiler is deliberately provider-neutral: adapters decide how to mark
 * `stats.fixedPrefixFingerprint` for their native cache protocol, while the
 * engine owns the slot budget and stable-prefix identity.
 */
export async function compileContext(ctx: QueryContext): Promise<CompiledContext> {
  const { system, fixedSystemTokens, messages, skillTokens } = await buildMessages(ctx)
  const tools: ToolDefinition[] = ctx.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))
  const toolText = JSON.stringify(tools)
  const rawMessages = ctx.messages.map((message) => messageTokenText(message))
  const finalMessages = messages.map((message) => messageTokenText(message))
  const rawHistoryTokens = rawMessages.reduce((sum, text) => sum + estimateTokens(text), 0)
  const finalHistoryTokens = finalMessages.reduce((sum, text) => sum + estimateTokens(text), 0)
  const attachmentTokens = finalMessages.reduce((sum, text) => sum + estimateAttachmentTokens(text), 0)
  const currentTaskText = finalMessages.at(-1) ?? ''
  const runtimeTokens = estimateTokens((ctx.harnessContext ?? []).filter((part) => part.startsWith('Environment:')).join('\n'))
  const fixedPrefixFingerprint = fingerprint([
    system,
    toolText,
    ctx.skill?.metadata.name ?? '',
    ctx.skill?.metadata.version ?? '',
    ctx.skill?.content ?? '',
  ].join('\n\u0000'))
  const stats: CompiledContextStats = {
    slots: {
      systemTokens: estimateTokens(system),
      fixedSystemTokens,
      skillTokens: skillTokens.totalTokens,
      toolsTokens: estimateTokens(toolText),
      historyTokens: Math.max(0, finalHistoryTokens - estimateTokens(currentTaskText)),
      attachmentTokens,
      runtimeTokens,
      currentTaskTokens: estimateTokens(currentTaskText),
    },
    skillIndexTokens: skillTokens.indexTokens,
    inlineAttachmentPreviewTokens: 0,
    rawHistoryTokens,
    finalHistoryTokens,
    historyTrimmed: finalHistoryTokens < rawHistoryTokens,
    fixedPrefixFingerprint,
    cacheable: { tools: tools.length > 0, system: true, skill: Boolean(ctx.skill) },
  }
  assertContextBudgetSnapshot({
    ...stats.slots,
    skillIndexTokens: stats.skillIndexTokens,
    inlineAttachmentPreviewTokens: stats.inlineAttachmentPreviewTokens,
  })
  return { system, messages, tools, skillTokens, stats }
}

function messageTokenText(message: { role: string; content: string | unknown[] }): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
}

function estimateAttachmentTokens(text: string): number {
  const body = [
    ...(text.match(/<attachment_full_text\b[^>]*>[\s\S]*?<\/attachment_full_text>/g) ?? []),
    ...(text.match(/<attachments(?:_inline)?\b[^>]*>[\s\S]*?<\/attachments(?:_inline)?>/g) ?? []),
  ]
  return body.reduce((sum, item) => sum + estimateTokens(item), 0)
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193)
  return `ctx-${(hash >>> 0).toString(16).padStart(8, '0')}`
}
