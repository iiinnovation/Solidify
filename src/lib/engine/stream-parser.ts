/**
 * SSE Stream Parser for AI Responses
 * @module lib/engine/stream-parser
 *
 * Handles incremental parsing of both text and tool_use deltas from:
 * - OpenAI: delta.tool_calls[].function.arguments (chunked, indexed)
 * - Anthropic: content_block_start + input_json_delta + content_block_stop
 */

/**
 * Stream event types
 */
export type StreamEventType =
  | 'text_delta'
  | 'tool_call_start'
  | 'tool_call_delta'
  | 'tool_call_end'
  | 'message_done'
  | 'error'

/**
 * Parsed stream event
 */
export interface StreamEvent {
  type: StreamEventType
  // Text delta
  text?: string
  // Tool call
  toolCallId?: string
  toolName?: string
  toolIndex?: number
  argumentsDelta?: string
  // Error
  error?: {
    type: string
    message: string
  }
}

/**
 * Tool call accumulator for incremental building
 */
interface ToolCallAccumulator {
  id: string
  name: string
  arguments: string
  index: number
}

/**
 * Stream parser state
 */
interface ParserState {
  provider: 'openai' | 'anthropic'
  buffer: string
  toolCalls: Map<number, ToolCallAccumulator>
  currentBlockId?: string
  currentBlockType?: string
}

/**
 * Create a new stream parser
 */
export function createStreamParser(provider: 'openai' | 'anthropic'): StreamParser {
  const state: ParserState = {
    provider,
    buffer: '',
    toolCalls: new Map(),
  }

  return {
    parse: (chunk: string) => parseChunk(state, chunk),
    reset: () => {
      state.buffer = ''
      state.toolCalls.clear()
      state.currentBlockId = undefined
      state.currentBlockType = undefined
    },
    getState: () => ({ ...state }),
  }
}

export interface StreamParser {
  parse: (chunk: string) => StreamEvent[]
  reset: () => void
  getState: () => ParserState
}

/**
 * Parse a chunk of SSE data
 */
function parseChunk(state: ParserState, chunk: string): StreamEvent[] {
  state.buffer += chunk

  const lines = state.buffer.split('\n')
  // Keep the last incomplete line in buffer
  state.buffer = lines.pop() ?? ''

  const events: StreamEvent[] = []

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue

    const data = line.slice(6).trim()
    if (data === '[DONE]') {
      events.push({ type: 'message_done' })
      continue
    }

    try {
      const parsed = JSON.parse(data)

      if (state.provider === 'openai') {
        events.push(...parseOpenAIChunk(state, parsed))
      } else {
        events.push(...parseAnthropicChunk(state, parsed))
      }
    } catch (error) {
      // Ignore invalid JSON
      console.warn('Failed to parse SSE data:', data, error)
    }
  }

  return events
}

/**
 * Parse OpenAI format chunk
 *
 * Text: choices[0].delta.content
 * Tool calls: choices[0].delta.tool_calls[] with incremental function.arguments
 */
function parseOpenAIChunk(state: ParserState, data: unknown): StreamEvent[] {
  const events: StreamEvent[] = []
  const choice = data && typeof data === 'object' && 'choices' in data
    ? (data.choices as unknown[])?.[0]
    : undefined

  if (!choice || typeof choice !== 'object' || !('delta' in choice)) return events

  const choiceObj = choice as { delta: Record<string, unknown>; finish_reason?: string }
  const { delta } = choiceObj

  // Text content delta
  if (delta.content) {
    events.push({
      type: 'text_delta',
      text: String(delta.content),
    })
  }

  // Tool calls delta
  if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
    for (const toolCall of delta.tool_calls) {
      const index = toolCall.index ?? 0
      const existingCall = state.toolCalls.get(index)

      // Start new tool call
      if (toolCall.id || toolCall.function?.name) {
        const id = toolCall.id || existingCall?.id || `tool_${index}`
        const name = toolCall.function?.name || existingCall?.name || ''

        if (!existingCall) {
          state.toolCalls.set(index, {
            id,
            name,
            arguments: '',
            index,
          })

          events.push({
            type: 'tool_call_start',
            toolCallId: id,
            toolName: name,
            toolIndex: index,
          })
        }
      }

      // Arguments delta
      if (toolCall.function?.arguments) {
        const accumulator = state.toolCalls.get(index)
        if (accumulator) {
          accumulator.arguments += toolCall.function.arguments

          events.push({
            type: 'tool_call_delta',
            toolCallId: accumulator.id,
            toolName: accumulator.name,
            toolIndex: index,
            argumentsDelta: toolCall.function.arguments,
          })
        }
      }
    }
  }

  // Check for finish_reason to emit tool_call_end
  if (choiceObj.finish_reason === 'tool_calls') {
    for (const [index, call] of state.toolCalls.entries()) {
      events.push({
        type: 'tool_call_end',
        toolCallId: call.id,
        toolName: call.name,
        toolIndex: index,
      })
    }
  }

  return events
}

/**
 * Parse Anthropic format chunk
 *
 * Uses content blocks with these event types:
 * - content_block_start: { type: 'tool_use', id, name }
 * - content_block_delta: { type: 'input_json_delta', partial_json }
 * - content_block_stop
 */
function parseAnthropicChunk(state: ParserState, data: unknown): StreamEvent[] {
  const events: StreamEvent[] = []

  if (!data || typeof data !== 'object' || !('type' in data)) return events

  const typedData = data as Record<string, unknown>

  switch (typedData.type) {
    case 'content_block_start': {
      const block = typedData.content_block
      if (!block || typeof block !== 'object') break

      const contentBlock = block as Record<string, unknown>

      if (contentBlock.type === 'text') {
        // Text block started (usually empty)
        if (contentBlock.text && typeof contentBlock.text === 'string') {
          events.push({
            type: 'text_delta',
            text: contentBlock.text,
          })
        }
      } else if (contentBlock.type === 'tool_use') {
        // Tool use block started
        state.currentBlockId = contentBlock.id as string
        state.currentBlockType = 'tool_use'

        const index = typeof typedData.index === 'number' ? typedData.index : 0
        state.toolCalls.set(index, {
          id: contentBlock.id as string,
          name: contentBlock.name as string,
          arguments: '',
          index,
        })

        events.push({
          type: 'tool_call_start',
          toolCallId: contentBlock.id as string,
          toolName: contentBlock.name as string,
          toolIndex: index,
        })
      }
      break
    }

    case 'content_block_delta': {
      const delta = typedData.delta
      if (!delta || typeof delta !== 'object') break

      const deltaBlock = delta as Record<string, unknown>

      if (deltaBlock.type === 'text_delta') {
        // Text delta
        if (deltaBlock.text && typeof deltaBlock.text === 'string') {
          events.push({
            type: 'text_delta',
            text: deltaBlock.text,
          })
        }
      } else if (deltaBlock.type === 'input_json_delta') {
        // Tool arguments delta
        const index = typeof typedData.index === 'number' ? typedData.index : 0
        const accumulator = state.toolCalls.get(index)

        if (accumulator && state.currentBlockType === 'tool_use' && typeof deltaBlock.partial_json === 'string') {
          accumulator.arguments += deltaBlock.partial_json

          events.push({
            type: 'tool_call_delta',
            toolCallId: accumulator.id,
            toolName: accumulator.name,
            toolIndex: index,
            argumentsDelta: deltaBlock.partial_json,
          })
        }
      }
      break
    }

    case 'content_block_stop': {
      // Block finished
      if (state.currentBlockType === 'tool_use' && state.currentBlockId) {
        const index = typeof typedData.index === 'number' ? typedData.index : 0
        const accumulator = state.toolCalls.get(index)

        if (accumulator) {
          events.push({
            type: 'tool_call_end',
            toolCallId: accumulator.id,
            toolName: accumulator.name,
            toolIndex: index,
          })
        }
      }

      state.currentBlockId = undefined
      state.currentBlockType = undefined
      break
    }

    case 'message_delta': {
      // Message metadata (usage, finish_reason, etc.)
      if (typedData.delta && typeof typedData.delta === 'object') {
        const messageDelta = typedData.delta as Record<string, unknown>
        if (messageDelta.stop_reason) {
          events.push({ type: 'message_done' })
        }
      }
      break
    }

    case 'message_stop': {
      events.push({ type: 'message_done' })
      break
    }

    case 'error': {
      const errorData = typedData.error && typeof typedData.error === 'object'
        ? (typedData.error as Record<string, unknown>)
        : {}
      events.push({
        type: 'error',
        error: {
          type: (errorData.type as string) || 'unknown_error',
          message: (errorData.message as string) || 'Unknown error occurred',
        },
      })
      break
    }
  }

  return events
}

/**
 * Reconstruct complete tool calls from parser state
 */
export function getCompletedToolCalls(parser: StreamParser): Array<{
  id: string
  name: string
  arguments: string
  index: number
}> {
  const state = parser.getState()
  return Array.from(state.toolCalls.values())
}

/**
 * Parse complete tool call arguments as JSON
 */
export function parseToolArguments(argumentsString: string): Record<string, unknown> {
  try {
    return JSON.parse(argumentsString)
  } catch (error) {
    console.error('Failed to parse tool arguments:', argumentsString, error)
    return {}
  }
}
