/**
 * Message assembly for Claude API
 * @module lib/engine/messages
 * @see docs/specs/agent-loop.md §3
 */

import type { QueryContext } from './types'
import { applyBudget } from './context-budget'

/**
 * Message format for Claude API
 */
export interface ClaudeMessage {
  role: 'user' | 'assistant'
  content: string | ClaudeContent[]
}

export type ClaudeContent =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

/**
 * System prompt components
 */
interface SystemPromptParts {
  base: string
  harness?: string
  skill?: string
  tools?: string
}

/**
 * Build messages array for Claude API from QueryContext
 * @see docs/specs/agent-loop.md §3.1
 */
export async function buildMessages(ctx: QueryContext): Promise<{
  system: string
  messages: ClaudeMessage[]
}> {
  const system = buildSystemPrompt(ctx)
  const messages = ctx.messages.map(msg => convertMessage(msg))

  // Apply budget constraints (handleize large results, trim if needed)
  const budgetedMessages = await applyBudget(ctx, messages)

  return { system, messages: budgetedMessages }
}

/**
 * Build system prompt from context components
 * @see docs/specs/agent-loop.md §3.2
 */
function buildSystemPrompt(ctx: QueryContext): string {
  const parts: SystemPromptParts = {
    base: buildBaseSystemPrompt(ctx),
  }

  if (ctx.harnessContext?.length) {
    parts.harness = ctx.harnessContext.join('\n\n')
  }

  if (ctx.skill?.content.trim()) {
    parts.skill = ctx.skill.content.trim()
  }

  // Add tool definitions if available
  if (ctx.tools.length > 0) {
    parts.tools = buildToolsSection(ctx)
  }

  // TODO M2: Add memory context via ctx.memory.search()

  return Object.values(parts).filter(Boolean).join('\n\n---\n\n')
}

/**
 * Build base system prompt
 */
function buildBaseSystemPrompt(ctx: QueryContext): string {
  // TODO M2: Load from settings or templates
  return `You are Solidify, an AI assistant that helps users with their tasks.

${ctx.tools.length > 0
    ? "You have access to tools that let you interact with the user's system. Use them when appropriate to complete tasks."
    : 'No tools are available for this provider; answer using the conversation context only.'}

Current working directory: ${ctx.cwd}
All relative file paths are resolved inside this workspace boundary.

When using tools:
- Read the tool description and parameter schema carefully
- Provide all required parameters
- Handle errors gracefully and explain what went wrong

Think step by step and explain your reasoning when helpful.`
}

/**
 * Build tools section for system prompt
 */
function buildToolsSection(ctx: QueryContext): string {
  const toolList = ctx.tools
    .map(tool => `- ${tool.name}: ${tool.description}`)
    .join('\n')

  return `# Available Tools

You have access to the following tools:

${toolList}

Use tools by calling them with valid JSON parameters according to their schema.`
}

/**
 * Convert internal message format to Claude API format
 */
function convertMessage(msg: QueryContext['messages'][0]): ClaudeMessage {
  // Simple text messages
  if (typeof msg.content === 'string') {
    return {
      role: msg.role,
      content: msg.content,
    }
  }

  // Multi-part content (text + tool_use + tool_result)
  return {
    role: msg.role,
    content: msg.content.map(part => {
      if (part.type === 'text') {
        return { type: 'text', text: part.text }
      }
      if (part.type === 'tool_use') {
        return {
          type: 'tool_use',
          id: part.id,
          name: part.name,
          input: part.input,
        }
      }
      if (part.type === 'tool_result') {
        return {
          type: 'tool_result',
          tool_use_id: part.tool_use_id,
          content: part.content,
          is_error: part.is_error,
        }
      }
      // Image URLs are passed through (used for vision features)
      if (part.type === 'image_url') {
        return part
      }
      // Exhaustiveness check
      const _exhaustive: never = part
      return _exhaustive
    }),
  }
}

/**
 * Append assistant response with tool calls to context
 */
export function appendAssistantMessage(
  ctx: QueryContext,
  text: string,
  toolCalls: Array<{ id: string; name: string; input: unknown }>,
): QueryContext {
  const content: ClaudeContent[] = []

  if (text.trim()) {
    content.push({ type: 'text', text })
  }

  toolCalls.forEach(call => {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.input,
    })
  })

  return {
    ...ctx,
    messages: [
      ...ctx.messages,
      {
        role: 'assistant',
        content,
      },
    ],
  }
}

/**
 * Append tool results to context
 */
export function appendToolResults(
  ctx: QueryContext,
  results: Array<{ tool_use_id: string; content: string; is_error?: boolean }>,
): QueryContext {
  const content: ClaudeContent[] = results.map(result => ({
    type: 'tool_result',
    tool_use_id: result.tool_use_id,
    content: result.content,
    is_error: result.is_error,
  }))

  return {
    ...ctx,
    messages: [
      ...ctx.messages,
      {
        role: 'user',
        content,
      },
    ],
  }
}
