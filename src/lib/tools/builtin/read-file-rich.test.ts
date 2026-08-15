import { describe, expect, it, vi } from 'vitest'
import type { ToolUseContext } from '../types'

const mocks = vi.hoisted(() => ({
  readWorkspaceFile: vi.fn(async () => ({ content: null, binary: true, bytes: 120, truncated: false })),
  readWorkspaceBytes: vi.fn(async () => [1, 2, 3]),
  extractText: vi.fn(async () => 'Word 文档中的客户需求'),
}))

vi.mock('@/lib/tauri', () => ({ readWorkspaceFile: mocks.readWorkspaceFile, readWorkspaceBytes: mocks.readWorkspaceBytes }))
vi.mock('@/lib/file-extractor', () => ({ extractText: mocks.extractText }))

import { readFileTool } from './read-file'

const context = {
  cwd: '/workspace',
  workspace: { root: '/workspace', name: 'workspace', resolve: (path: string) => `/workspace/${path}`, contains: () => true },
  platform: 'tauri',
  memory: {}, settings: {}, permissions: new Map(), logger: {}, runId: 'm3-rich-read',
} as unknown as ToolUseContext

describe('M3 rich workspace read', () => {
  it('extracts Word content for the Agent and preserves slicing', async () => {
    const result = await readFileTool.execute({ path: '需求.docx', offset: 5, limit: 6 }, context, new AbortController().signal)
    expect(result.success).toBe(true)
    expect(result.content).toBe('文档中的客户')
    expect(mocks.extractText).toHaveBeenCalledOnce()
  })

  it('reads only the selected Skill virtual resource', async () => {
    const skillContext = {
      ...context,
      skillResources: {
        virtualRoot: '.solidify/skills/demo',
        canRead: (path: string) => path.startsWith('.solidify/skills/demo/'),
        read: async (path: string) => ({ content: `resource:${path}`, bytes: path.length, truncated: false }),
      },
    } as unknown as ToolUseContext
    const result = await readFileTool.execute({ path: '.solidify/skills/demo/reference/guide.md' }, skillContext, new AbortController().signal)
    expect(result).toMatchObject({ success: true, content: 'resource:.solidify/skills/demo/reference/guide.md' })

    const denied = await readFileTool.execute({ path: '.solidify/skills/other/reference/guide.md' }, skillContext, new AbortController().signal)
    expect(denied).toMatchObject({ success: false, error: { kind: 'permission_denied' } })
  })
})
