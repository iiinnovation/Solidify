import { describe, expect, it } from 'vitest'
import { ToolRegistry } from './registry'
import { readHandleTool } from './builtin/read-handle'
import { readFileTool } from './builtin/read-file'
import { listDirTool } from './builtin/list-dir'
import { writeFileTool } from './builtin/write-file'
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

  it('defaults a selected Skill without allowed-tools to read-only tools', () => {
    const registry = new ToolRegistry()
    registry.register(readFileTool as Tool)
    registry.register(listDirTool as Tool)
    registry.register(writeFileTool as Tool)

    const tools = registry.resolve({
      platform: 'tauri',
      skillActive: true,
      userDisabledTools: [],
      isOnline: true,
    })

    expect(tools.map((tool) => tool.name)).toEqual(['read_file', 'list_dir'])
  })

  it('exposes read_file on Web only when a selected Skill resource resolver exists', () => {
    const registry = new ToolRegistry()
    registry.register(readFileTool as Tool)
    registry.register(listDirTool as Tool)

    const withoutResolver = registry.resolve({
      platform: 'web',
      skillActive: true,
      userDisabledTools: [],
      isOnline: true,
    })
    const withResolver = registry.resolve({
      platform: 'web',
      skillActive: true,
      skillResourceAccess: true,
      userDisabledTools: [],
      isOnline: true,
    })

    expect(withoutResolver).toEqual([])
    expect(withResolver.map((tool) => tool.name)).toEqual(['read_file'])
  })
})
