/**
 * Model provider interface
 * @module lib/model/provider
 */

import type {
  CompletionRequest,
  CompletionChunk,
  ProviderMetadata,
} from './types'

/**
 * Base interface for all model providers
 */
export interface ModelProvider {
  /** Provider identifier */
  readonly name: string

  /** Provider metadata */
  readonly metadata: ProviderMetadata

  /**
   * Stream completion from model
   * @param request - Unified completion request
   * @returns Async generator of completion chunks
   */
  stream(request: CompletionRequest): AsyncGenerator<CompletionChunk>

  /**
   * Optional: List available models
   */
  listModels?(): Promise<string[]>

  /**
   * Optional: Validate configuration
   */
  validateConfig?(): Promise<boolean>
}
