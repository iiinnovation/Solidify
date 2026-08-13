import { describe, expect, it } from 'vitest'
import { ToolRegistry } from './registry'
import { readHandleTool } from './builtin/read-handle'
import { readFileTool } from './builtin/read-file'
import type { Tool } from './types'

describe('ToolRegistry runtime tools', () => {
  it('keeps read_handle reachable through skill and user filters', () => {
    const registry = new ToolRegistry()
    registry.register(readFileTool as Tool)
    registry.register(readHandleTool as Tool)

    const tools = registry.resolve({
      platform: 'tauri',
      skillAllowedTools: ['read_file'],
      userDisabledTools: ['read_handle'],
      isOnline: true,
    })

    expect(tools.map((tool) => tool.name)).toEqual(['read_file', 'read_handle'])
  })
})
