import { describe, expect, it, vi } from 'vitest'
import type { Tool, ToolUseContext } from '../types'
import { listDirTool } from './list-dir'
import { readFileTool } from './read-file'
import { writeFileTool } from './write-file'
import { searchFilesTool } from './search-files'

const tauri = vi.hoisted(() => ({
  listWorkspaceDir: vi.fn(),
  readWorkspaceFile: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  searchWorkspaceFiles: vi.fn(),
}))

vi.mock('@/lib/tauri', () => tauri)

function context(): ToolUseContext {
  return {
    runId: 'workspace-tools',
    cwd: '/workspace',
    workspace: {
      root: '/workspace',
      name: 'workspace',
      resolve(path) {
        if (path.startsWith('/') || path.startsWith('../')) throw new Error('outside workspace')
        return `/workspace/${path}`
      },
      contains: () => false,
    },
    memory: {} as ToolUseContext['memory'],
    settings: {} as ToolUseContext['settings'],
    permissions: new Map(),
    platform: 'tauri',
    logger: {
      log: () => {}, info: () => {}, warn: () => {}, error: () => {},
      flush: async () => {}, entries: () => [],
    },
  }
}

describe('workspace tools renderer-side sandbox', () => {
  it.each([
    ['list_dir', listDirTool as Tool, { path: '../outside' }],
    ['read_file', readFileTool as Tool, { path: '/etc/passwd' }],
    ['write_file', writeFileTool as Tool, { path: '../outside', content: 'no' }],
    ['search_files', searchFilesTool as Tool, { query: 'secret', path: '../outside' }],
  ])('rejects an escaping path before invoking Tauri for %s', async (_name, tool, input) => {
    const result = await tool.execute(
      input,
      context(),
      new AbortController().signal,
    )

    expect(result).toMatchObject({
      success: false,
      error: { kind: 'permission_denied', recoverable: false },
    })
    expect(Object.values(tauri).every((mock) => mock.mock.calls.length === 0)).toBe(true)
  })
})
