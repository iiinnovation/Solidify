/**
 * Tool Registry Implementation
 * @module lib/tools/registry
 * @see docs/specs/tool-interface.md §7
 */

import type { Tool, ToolRegistry as IToolRegistry, ResolveContext } from './types'

/**
 * Central registry for all available tools
 * Handles registration, filtering, and schema generation
 */
export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): () => void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`)
    }
    this.tools.set(tool.name, tool)
    return () => { if (this.tools.get(tool.name) === tool) this.tools.delete(tool.name) }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  /**
   * Resolve available tools with three-layer filtering:
   * 1. Environment - Platform availability
   * 2. Skill whitelist - From SKILL.md frontmatter
   * 3. User settings - Globally disabled tools
   */
  resolve(ctx: ResolveContext): Tool[] {
    const available: Tool[] = []

    for (const tool of this.tools.values()) {
      const runtimeRequired = tool.name === 'read_handle'

      // Layer 1: Environment filter
      if (tool.availability === 'tauri-only' && ctx.platform === 'web') {
        continue
      }
      if (tool.availability === 'online-only' && !ctx.isOnline) {
        continue
      }

      // Layer 2: Skill whitelist filter
      if (!runtimeRequired && ctx.skillAllowedTools && !ctx.skillAllowedTools.includes(tool.name)) {
        continue
      }

      // Layer 3: User disabled tools
      if (!runtimeRequired && ctx.userDisabledTools.includes(tool.name)) {
        continue
      }

      available.push(tool)
    }

    return available
  }

  /**
   * Generate model-visible tool schemas
   * Adapts to provider-specific wire formats
   */
  toSchema(tools: Tool[], format: 'openai' | 'anthropic'): unknown[] {
    if (format === 'openai') {
      return tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }))
    }

    // Anthropic format
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }))
  }
}

/**
 * Global tool registry instance
 * Import this to register or resolve tools
 */
export const toolRegistry = new ToolRegistry()

// Register the first-party tools once at module initialization. Consumers can
// still use a separate ToolRegistry for tests or scoped tool sets.
import { listDirTool } from './builtin/list-dir'
import { readFileTool } from './builtin/read-file'
import { writeFileTool } from './builtin/write-file'
import { searchFilesTool } from './builtin/search-files'
import { capturePreviewTool } from './builtin/capture-preview'
import { readHandleTool } from './builtin/read-handle'

for (const tool of [listDirTool, readFileTool, writeFileTool, searchFilesTool, capturePreviewTool, readHandleTool]) {
  toolRegistry.register(tool as Tool)
}
