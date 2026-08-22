import { describe, expect, it } from 'vitest'
import { ToolRegistry } from './registry'
import { readHandleTool } from './builtin/read-handle'
import { readFileTool } from './builtin/read-file'
import { listDirTool } from './builtin/list-dir'
import { writeFileTool } from './builtin/write-file'
import { readAttachmentTool, searchAttachmentsTool } from './builtin/attachments'
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

  it('keeps attachment tools under Skill and user policy', () => {
    const registry = new ToolRegistry()
    registry.register(searchAttachmentsTool as Tool)
    registry.register(readAttachmentTool as Tool)

    const allowed = registry.resolve({
      platform: 'web', skillActive: true,
      skillAllowedTools: ['search_attachments', 'read_attachment'], userDisabledTools: [], isOnline: true,
    })
    expect(allowed.map((tool) => tool.name)).toEqual(['search_attachments', 'read_attachment'])

    const denied = registry.resolve({
      platform: 'web', skillActive: true,
      skillAllowedTools: ['search_attachments', 'read_attachment'], userDisabledTools: ['read_attachment'], isOnline: true,
    })
    expect(denied.map((tool) => tool.name)).toEqual(['search_attachments'])
  })

  it('exposes attachment readers to a Skill whose allowed-tools omits them', () => {
    const registry = new ToolRegistry()
    registry.register(readFileTool as Tool)
    registry.register(searchAttachmentsTool as Tool)
    registry.register(readAttachmentTool as Tool)

    // drawio-diagram ships `allowed-tools: [read_file, write_file]`; the user
    // still attaches a document to the run and expects it to be readable.
    const withAttachments = registry.resolve({
      platform: 'web', skillActive: true, skillAllowedTools: ['read_file', 'write_file'],
      hasAttachments: true, userDisabledTools: [], isOnline: true,
    })
    expect(withAttachments.map((tool) => tool.name)).toContain('search_attachments')
    expect(withAttachments.map((tool) => tool.name)).toContain('read_attachment')

    // Nothing attached: the readers have nothing to read, so they stay hidden.
    const withoutAttachments = registry.resolve({
      platform: 'web', skillActive: true, skillAllowedTools: ['read_file', 'write_file'],
      userDisabledTools: [], isOnline: true,
    })
    expect(withoutAttachments.map((tool) => tool.name)).not.toContain('search_attachments')

    // The run-scoped exemption covers Skill policy only, never user policy.
    const userDisabled = registry.resolve({
      platform: 'web', skillActive: true, skillAllowedTools: ['read_file', 'write_file'],
      hasAttachments: true, userDisabledTools: ['search_attachments', 'read_attachment'], isOnline: true,
    })
    expect(userDisabled.map((tool) => tool.name)).not.toContain('search_attachments')
    expect(userDisabled.map((tool) => tool.name)).not.toContain('read_attachment')
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

  it('keeps the unselected canonical run on discovery/read tools', () => {
    const registry = new ToolRegistry()
    for (const tool of [readFileTool, listDirTool, writeFileTool, readHandleTool]) registry.register(tool as Tool)
    const tools = registry.resolve({
      platform: 'tauri',
      minimalUnselected: true,
      userDisabledTools: [],
      isOnline: true,
    })
    expect(tools.map((tool) => tool.name)).toEqual(['read_file', 'list_dir', 'read_handle'])
  })
})
