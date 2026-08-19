/**
 * Agent query loop types
 * @module lib/engine/types
 * @see docs/specs/agent-loop.md
 */

import type { Tool, ToolCall, ToolResult, ToolProgress } from '../tools/types'
import type { MemoryState } from '../memory/types'
import type { LoadedSkill, SkillResourceResolver, SkillRegistryApi } from '../skills/types'
import type { ProviderRegistry } from '../model'
import type { WorkspaceHandle } from '../workspace/types'
import type { Settings, PermissionMap, Platform } from '../harness/types'
import type { ConfirmationPrompt } from '../harness/policy'
import type { ApprovalOutcome } from '../harness/approval'
import type { TaskTreeBudget } from './sub-agent/types'

// ============================================================================
// Query Context
// ============================================================================

export interface ModelConfig {
  provider: string  // Provider name in registry
  model: string
  temperature?: number
  maxTokens?: number
  /**
   * Usable context window for this model, in tokens. Drives context trimming.
   * Absent = a conservative default is used rather than assuming 200k, which
   * would silently overflow every smaller model.
   */
  contextWindow?: number
}

export interface RunLimits {
  /** Maximum conversation turns before exhaustion (default: 25) */
  maxTurns: number
  /** Total token budget for this run */
  maxTokens: number
  /** Maximum output tokens per turn */
  maxOutputTokens: number
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
  /** Wall-clock time when the user initiated this run, before local preparation. */
  readonly requestStartedAt?: number
  /** M6: Parent run for a one-level sub-agent. Root runs omit this field. */
  readonly parentRunId?: string
  readonly conversationId: string
  readonly cwd: string                      // Working directory = project root
  readonly messages: readonly Message[]
  readonly tools: readonly Tool[]           // Available tools (filtered by permissions & env)
  readonly skill?: LoadedSkill
  readonly skillResources?: SkillResourceResolver
  readonly skillRegistry?: SkillRegistryApi
  /** Trusted image attachments available to the PPTD generator for this run. */
  readonly pptdMedia?: Readonly<Record<string, string | Uint8Array>>
  readonly memory: MemoryState
  readonly model: ModelConfig
  readonly limits: RunLimits
  readonly signal: AbortSignal
  readonly providerRegistry: ProviderRegistry  // Model provider registry
  /** M1-13: Optional snapshot store for crash recovery; absent = no snapshots */
  readonly snapshots?: SnapshotStore
  /** Resume an interrupted run from the latest turn snapshot. */
  readonly restoreSnapshot?: boolean

  // ── M1-14: Harness-provided tool execution environment ──
  // Optional for non-chat callers; the loop synthesizes conservative
  // fallbacks when absent (see engine/tool-context.ts)
  readonly workspace?: WorkspaceHandle
  readonly settings?: Readonly<Settings>
  readonly permissions?: PermissionMap
  readonly platform?: Platform
  /** Trusted Harness-generated context appended to the system prompt. */
  readonly harnessContext?: readonly string[]
  /**
   * Untrusted content retrieved from the workspace (RAG / memory prefetch).
   * Injected as a user-role message, never into the system prompt — it may
   * contain text authored by anyone who can drop a file in the workspace.
   */
  readonly retrievedContext?: string
  /** M6: Shared cancellation and token accounting for the whole task tree. */
  readonly taskTree?: {
    readonly rootRunId: string
    readonly depth: 0 | 1
    readonly budget: TaskTreeBudget
  }
}

// ============================================================================
// Session Snapshot (M1-13)
// ============================================================================

/**
 * One snapshot per completed turn, serialized as one jsonl line
 * @see docs/specs/agent-loop.md §4 (恢复)
 */
export interface TurnSnapshot {
  runId: string
  turn: number
  messages: Message[]
  usage: UsageStats
  /** Progress-budget charge (first-turn input plus generated output). */
  budgetTokens?: number
  ts: string
}

/**
 * Append-only snapshot storage
 * Tauri: .solidify/conversations/<id>.jsonl · Web: localStorage
 */
export interface SnapshotStore {
  /** Append one turn snapshot for a conversation */
  append(conversationId: string, snapshot: TurnSnapshot): Promise<void>

  /** Load the latest snapshot, null if none exists */
  loadLatest(conversationId: string): Promise<TurnSnapshot | null>

  /** Remove all snapshots for a conversation */
  clear(conversationId: string): Promise<void>
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
  | { type: 'permission.required'; requestId: string; callId: string; prompt: ConfirmationPrompt }
  | { type: 'permission.resolved'; requestId: string; callId: string; outcome: ApprovalOutcome }
  | { type: 'tool.progress'; callId: string; progress: ToolProgress }
  | { type: 'tool.completed'; callId: string; result: ToolResult }
  | { type: 'artifact.created'; artifact: ArtifactRef }
  | { type: 'tombstone'; reason: string; detail?: unknown }
  | { type: 'run.completed'; usage: UsageStats }
  | { type: 'run.failed'; error: RunError; usage?: UsageStats }
  | { type: 'run.exhausted'; reason: 'max_turns' | 'max_tokens' | 'max_tool_calls'; usage?: UsageStats }

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
 * Large result handleization threshold. Keep this aligned with the context
 * budget and read_handle chunk ceiling.
 * Results larger than this are stored with a handle
 */
export const HANDLE_THRESHOLD = 24_000  // 24KB
