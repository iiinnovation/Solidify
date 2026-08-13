/**
 * Provider registry and factory
 * @module lib/model/registry
 */

import type { ModelProvider } from './provider'
import type { ProviderConfig } from './types'
import { AnthropicProvider } from './anthropic'
import { OpenAIProvider } from './openai'

/**
 * Provider type identifier
 */
export type ProviderType = 'anthropic' | 'openai' | 'gemini'

/**
 * Provider registry for managing multiple model providers
 */
export class ProviderRegistry {
  private providers = new Map<string, ModelProvider>()

  /**
   * Register a provider instance
   */
  register(name: string, provider: ModelProvider): void {
    this.providers.set(name, provider)
  }

  /**
   * Get a registered provider
   */
  get(name: string): ModelProvider {
    const provider = this.providers.get(name)
    if (!provider) {
      throw new Error(`Provider "${name}" not found. Available: ${this.list().join(', ')}`)
    }
    return provider
  }

  /**
   * Check if provider exists
   */
  has(name: string): boolean {
    return this.providers.has(name)
  }

  /**
   * List all registered provider names
   */
  list(): string[] {
    return Array.from(this.providers.keys())
  }

  /**
   * Remove a provider
   */
  unregister(name: string): boolean {
    return this.providers.delete(name)
  }

  /**
   * Clear all providers
   */
  clear(): void {
    this.providers.clear()
  }
}

/**
 * Create a provider instance from type and config
 */
export function createProvider(
  type: ProviderType,
  config: ProviderConfig
): ModelProvider {
  switch (type) {
    case 'anthropic':
      return new AnthropicProvider(config)

    case 'openai':
      return new OpenAIProvider(config)

    case 'gemini':
      throw new Error('Gemini provider not yet implemented')

    default:
      throw new Error(`Unknown provider type: ${type}`)
  }
}

/**
 * Create a registry with default providers from config
 */
export function createProviderRegistry(
  configs: Record<string, { type: ProviderType; config: ProviderConfig }>
): ProviderRegistry {
  const registry = new ProviderRegistry()

  for (const [name, { type, config }] of Object.entries(configs)) {
    const provider = createProvider(type, config)
    registry.register(name, provider)
  }

  return registry
}
