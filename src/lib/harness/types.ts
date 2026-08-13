/**
 * Harness types - Settings, Permissions, Platform, Logger
 * @see docs/specs/harness.md
 */

import type { FeatureFlags } from './flags'
import type { PermissionScope } from '../tools/types'

// ============================================================================
// Platform
// ============================================================================

export type Platform = 'web' | 'tauri'

export interface PlatformInfo {
  type: Platform
  os: 'windows' | 'macos' | 'linux' | 'unknown'
  arch: string
  version: string
}

// ============================================================================
// Settings
// ============================================================================

export interface ModelSettings {
  provider: 'openai' | 'anthropic'
  model: string
  apiKey?: string
  baseUrl?: string
  temperature: number
  maxTokens: number
}

export interface UISettings {
  theme: 'light' | 'dark' | 'auto'
  fontSize: number
  codeTheme: string
  compactMode: boolean
}

export interface PrivacySettings {
  allowTelemetry: boolean
  allowCrashReports: boolean
  shareUsageData: boolean
}

export interface Settings {
  model: ModelSettings
  ui: UISettings
  privacy: PrivacySettings
  features: FeatureFlags
  disabledTools: string[]
  workspaceRoot?: string
}

// ============================================================================
// Permissions
// ============================================================================

export type PermissionStatus = 'granted' | 'denied' | 'prompt'

export interface PermissionEntry {
  scope: PermissionScope
  status: PermissionStatus
  grantedAt?: string
  expiresAt?: string
}

export type PermissionMap = Map<PermissionScope, PermissionEntry>

export interface PermissionPolicy {
  /** Check if permission is granted */
  check(scope: PermissionScope): PermissionStatus

  /** Request permission from user */
  request(scope: PermissionScope, reason: string): Promise<PermissionStatus>

  /** Grant permission programmatically (from user action) */
  grant(scope: PermissionScope, duration?: 'session' | 'permanent'): void

  /** Revoke permission */
  revoke(scope: PermissionScope): void
}

// ============================================================================
// Run Logger (for ledger/transcript)
// ============================================================================

export interface LogEntry {
  timestamp: string
  level: 'debug' | 'info' | 'warn' | 'error'
  event: string
  data?: unknown
}

export interface RunLogger {
  /** Log a ledger event */
  log(event: string, data?: unknown): void

  /** Write info message */
  info(message: string, data?: unknown): void

  /** Write warning */
  warn(message: string, data?: unknown): void

  /** Write error */
  error(message: string, error?: Error | unknown): void

  /** Flush logs to persistent storage */
  flush(): Promise<void>

  /** Get all entries for this run */
  entries(): LogEntry[]
}

// ============================================================================
// Hook System (for harness extensibility)
// ============================================================================

export interface HookContext {
  runId: string
  conversationId: string
  timestamp: string
}

export interface BeforeToolCallHook {
  (toolName: string, input: unknown, ctx: HookContext): Promise<void | { abort: true; reason: string }>
}

export interface AfterToolCallHook {
  (toolName: string, result: unknown, ctx: HookContext): Promise<void>
}

export interface HookRegistry {
  registerBeforeToolCall(hook: BeforeToolCallHook): void
  registerAfterToolCall(hook: AfterToolCallHook): void
  executeBeforeToolCall(toolName: string, input: unknown, ctx: HookContext): Promise<void | { abort: true; reason: string }>
  executeAfterToolCall(toolName: string, result: unknown, ctx: HookContext): Promise<void>
}
