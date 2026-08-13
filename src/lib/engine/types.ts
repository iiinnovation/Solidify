/**
 * Agent query loop types
 * @module lib/engine/types
 * @see docs/specs/agent-loop.md
 */

import type { Tool, ToolCall, ToolResult, ToolProgress } from '../tools/types'
import type { MemoryState } from '../memory/types'
import type { LoadedSkill } from '../skills/types'

// ============================================================================
// Query Context
// ============================================================================

export interface ModelConfig {
  provider: 'openai' | 'anthropic'
  model: string
  apiKey?: string
  baseUrl?: string
  temperature?: number
  maxTokens?: number
}

export interface RunLimits {
  /** Maximum conversation turns before exhaustion (default: 25) */
  maxTurns: number
  /** Total token budget for this run */
  maxTokens: number
  /** Maximum tool calls across all turns (default: 50) */
  maxToolCalls: number
  /** Single tool execution timeout in ms (default: 60_000) */
  toolTimeoutMs: number
}

export interface Message {
  role: 'user' | 'assistant'
  content: string | MessageContent[]
}

export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

/**
 * Immutable context for one query run
 * Reconstructed per turn, never mutated
 */
export interface QueryContext {
  readonly runId: string
  readonly conversationId: string
  readonly cwd: string                      // Working directory = project root
  readonly messages: readonly Message[]
  readonly tools: readonly Tool[]           // Available tools (filtered by permissions & env)
  readonly skill?: LoadedSkill
  readonly memory: MemoryState
  readonly model: ModelConfig
  readonly limits: RunLimits
  readonly signal: AbortSignal
}

// ============================================================================
// Query Events (Stream Output)
// ============================================================================

export interface ArtifactRef {
  id: string
  type: string
  title: string
}

export interface UsageStats {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  turns: number
  toolCalls: number
}

export interface RunError {
  kind: 'aborted' | 'timeout' | 'rate_limit' | 'api_error' | 'internal'
  message: string
  details?: unknown
}

export type PermissionDecision = 'allow' | 'deny' | 'allow_once' | 'allow_session'

/**
 * Event stream types
 * @see docs/04-decisions.md#adr-0007 - UI events and ledger events are the same stream
 */
export type QueryEvent =
  | { type: 'run.started'; runId: string }
  | { type: 'message.delta'; text: string }
  | { type: 'message.completed'; content: string }
  | { type: 'tool.requested'; call: ToolCall }
  | { type: 'permission.required'; call: ToolCall; reason: string }
  | { type: 'permission.resolved'; callId: string; decision: PermissionDecision }
  | { type: 'tool.progress'; callId: string; progress: ToolProgress }
  | { type: 'tool.completed'; callId: string; result: ToolResult }
  | { type: 'artifact.created'; artifact: ArtifactRef }
  | { type: 'tombstone'; reason: string; detail?: unknown }
  | { type: 'run.completed'; usage: UsageStats }
  | { type: 'run.failed'; error: RunError }
  | { type: 'run.exhausted'; reason: 'max_turns' | 'max_tokens' | 'max_tool_calls' }

// ============================================================================
// Model Gateway
// ============================================================================

export interface ModelCapabilities {
  /** Supports tool calling */
  tools: boolean
  /** Supports multiple tool calls in one turn */
  parallelTools: boolean
  /** Supports image inputs (needed for capture_preview self-check) */
  vision: boolean
  /** Maximum context window size in tokens */
  maxContext: number
}

export interface ModelRequest {
  messages: Message[]
  tools?: unknown[]  // Format-specific tool schema
  model: string
  temperature?: number
  maxTokens?: number
  stream: true
}

export interface ModelChunk {
  type: 'text' | 'tool_call' | 'done'
  text?: string
  toolCall?: Partial<ToolCall>
  usage?: UsageStats
}

export interface ModelGateway {
  /** Query model capabilities */
  capabilities(model: ModelConfig): ModelCapabilities

  /** Stream model response */
  stream(req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelChunk>
}

// ============================================================================
// Context Assembly
// ============================================================================

export interface ContextBudget {
  total: number
  system: number
  skill: number
  messages: number
  toolResults: number
  memory: number
}

/**
 * Large result handleization threshold
 * Results larger than this are stored with a handle
 */
export const HANDLE_THRESHOLD = 8192  // 8KB
