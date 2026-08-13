/**
 * Model provider system
 * @module lib/model
 */

export type {
  UnifiedMessage,
  UnifiedContent,
  ToolDefinition,
  CompletionRequest,
  CompletionChunk,
  TokenUsage,
  ModelError,
  ProviderConfig,
  ProviderMetadata,
} from './types'

export type { ModelProvider } from './provider'

export { AnthropicProvider } from './anthropic'
export { OpenAIProvider } from './openai'

export {
  ProviderRegistry,
  createProvider,
  createProviderRegistry,
  type ProviderType,
} from './registry'
