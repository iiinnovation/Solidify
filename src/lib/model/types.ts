/**
 * Unified model types - provider-agnostic
 * @module lib/model/types
 */

import type { JSONSchema } from '../types/json-schema'

/**
 * Unified message format (internal standard)
 */
export interface UnifiedMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | UnifiedContent[]
}

/**
 * Unified content types
 */
export type UnifiedContent =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; detail?: 'auto' | 'low' | 'high' }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

/**
 * Tool definition for model
 */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JSONSchema
}

/**
 * Unified completion request
 */
export interface CompletionRequest {
  model: string
  system?: string
  messages: UnifiedMessage[]
  tools?: ToolDefinition[]
  temperature?: number
  maxTokens?: number
  topP?: number
  stream: true // We only support streaming
}

/**
 * Token usage statistics
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
}

/**
 * Model error types
 */
export interface ModelError {
  code: string
  message: string
  type: 'api_error' | 'rate_limit' | 'invalid_request' | 'timeout' | 'network' | 'unknown'
  retryable: boolean
}

/**
 * Stop reasons from model
 * @see docs/specs/agent-loop.md §3.2
 */
export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'

/**
 * Unified streaming response chunks
 */
export type CompletionChunk =
  | { type: 'content_start' }
  | { type: 'content_delta'; delta: string }
  | { type: 'content_end' }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; delta: string }
  | { type: 'tool_call_end'; id: string; input: unknown }
  | { type: 'message_start' }
  | { type: 'message_end'; usage?: TokenUsage; stopReason?: StopReason }
  | { type: 'error'; error: ModelError }
  | { type: 'ping' } // Keep-alive for long responses

/**
 * Provider configuration
 */
export interface ProviderConfig {
  apiKey: string
  baseURL?: string // Support custom endpoints (e.g., API proxies)
  timeout?: number // Request timeout in ms
  maxRetries?: number // Max retry attempts
  defaultModel?: string // Default model for this provider
}

/**
 * Provider metadata
 */
export interface ProviderMetadata {
  name: string
  displayName: string
  supportsVision: boolean
  supportsTools: boolean
  supportsStreaming: boolean
  defaultMaxTokens: number
  models: string[]
}
