/**
 * Tool interface types
 * @module lib/tools/types
 * @see docs/specs/tool-interface.md
 */

import type { JSONSchema } from '../types/json-schema'
import type { WorkspaceHandle } from '../workspace/types'
import type { MemoryState } from '../memory/types'
import type { Settings, PermissionMap, Platform } from '../harness/types'
import type { RunLogger } from '../harness/types'

// ============================================================================
// Tool Definition
// ============================================================================

export type ToolAvailability = 'always' | 'tauri-only' | 'online-only'

export type PermissionScope =
  | 'fs:read'
  | 'fs:write'
  | 'net:http'
  | 'process:spawn'
  | 'clipboard'
  | 'screen:capture'

export interface ToolProgress {
  phase: string
  current: number
  total?: number
  message?: string
}

export interface Tool<I = unknown, O = unknown> {
  /** Model-visible name, snake_case, globally unique */
  name: string

  /** Model-visible description. Focus on "when to use" over "what it is" */
  description: string

  /** Input schema, validated before execution */
  inputSchema: JSONSchema

  /** Output schema, optional, for result normalization */
  outputSchema?: JSONSchema

  // ── Behavior declarations for Harness decision-making ──
  /** Read-only tools can skip confirmation and run concurrently */
  readOnly: boolean
  /** Can execute in parallel with other tools */
  concurrencySafe: boolean
  /** May cause irreversible consequences */
  destructive: boolean
  /** Requires user confirmation before execution */
  requiresConfirmation: boolean | ((input: I, ctx: ToolUseContext) => boolean)

  // ── Environment requirements ──
  /** Runtime availability constraint */
  availability: ToolAvailability
  /** Required permission scopes */
  permissions: PermissionScope[]

  // ── Execution strategy ──
  timeoutMs?: number
  retry?: { maxAttempts: number; backoffMs: number }

  /** Execute the tool */
  execute(
    input: I,
    ctx: ToolUseContext,
    signal: AbortSignal,
    onProgress?: (p: ToolProgress) => void,
  ): Promise<ToolResult<O>>

  /** Render a human-readable one-line description for confirmation dialog */
  renderCall(input: I): string
}

// ============================================================================
// Execution Context
// ============================================================================

/** Immutable context for each turn, reconstructed per loop iteration */
export interface ToolUseContext {
  readonly runId: string
  readonly cwd: string                    // Working directory = project root, sandbox boundary
  readonly workspace: WorkspaceHandle
  readonly memory: MemoryState
  readonly settings: Readonly<Settings>
  readonly permissions: PermissionMap
  readonly platform: Platform
  readonly logger: RunLogger              // Write to run ledger
}

// ============================================================================
// Tool Result
// ============================================================================

export type ToolErrorKind =
  | 'invalid_input'
  | 'not_found'
  | 'permission_denied'
  | 'timeout'
  | 'aborted'
  | 'runtime'

export interface ToolError {
  kind: ToolErrorKind
  /** Error message for the model (must be actionable, not raw stack traces) */
  message: string
  /** Whether the error is recoverable by retrying or changing input */
  recoverable: boolean
}

export interface ToolResultMetadata {
  durationMs: number
  bytesRead?: number
  bytesWritten?: number
}

export interface ToolResult<T = unknown> {
  success: boolean

  /** Content for the model. Large results MUST be handleized (see agent-loop.md §6) */
  content: string

  /** Structured data for UI consumption */
  data?: T

  /** Storage handle for large results */
  handle?: string
  truncated?: boolean

  /** Explainable error when success=false */
  error?: ToolError

  metadata?: ToolResultMetadata
}

// ============================================================================
// Tool Call (from model output)
// ============================================================================

export interface ToolCall {
  id: string
  name: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any  // Will be validated against tool.inputSchema
}

// ============================================================================
// Tool Registry
// ============================================================================

export interface ResolveContext {
  platform: Platform
  skillAllowedTools?: string[]  // From SKILL.md frontmatter
  userDisabledTools: string[]   // From settings
  isOnline: boolean
}

export interface ToolRegistry {
  /** Register a tool into the registry */
  register(tool: Tool): void

  /** Get a tool by name */
  get(name: string): Tool | undefined

  /**
   * Resolve available tools for current context
   * Three-layer filtering:
   * 1. Environment - Web has no tauri-only tools
   * 2. Skill whitelist - From SKILL.md frontmatter
   * 3. User settings - User can globally disable tools
   */
  resolve(ctx: ResolveContext): Tool[]

  /**
   * Generate model-visible schema adapted to wire format
   * @param format - API format ('openai' | 'anthropic')
   */
  toSchema(tools: Tool[], format: 'openai' | 'anthropic'): unknown[]
}
