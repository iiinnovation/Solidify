import { beforeEach, describe, expect, it, vi } from 'vitest'

const { files, searchWorkspaceIndex, writeWorkspaceFile } = vi.hoisted(() => ({
  files: new Map<string, string>(),
  searchWorkspaceIndex: vi.fn(async () => [{ path: '资料/需求.md', text: '统一数据治理平台', score: -0.5 }]),
  writeWorkspaceFile: vi.fn(async (path: string, content: string) => { files.set(path, content); return content.length }),
}))

vi.mock('@/lib/tauri', () => ({
  readWorkspaceFile: vi.fn(async (path: string) => {
    const content = files.get(path)
    if (content === undefined) throw new Error('not found')
    return { content, binary: false, bytes: content.length, truncated: false }
  }),
  writeWorkspaceFile,
  searchWorkspaceIndex,
}))

import { MemdirMemory } from './memdir'
import { WorkspaceMemory } from './retrieval'
import { prefetchMemory } from './prefetch'

describe('M3 workspace memory', () => {
  beforeEach(() => {
    files.clear()
    searchWorkspaceIndex.mockClear()
    writeWorkspaceFile.mockClear()
    writeWorkspaceFile.mockImplementation(async (path: string, content: string) => { files.set(path, content); return content.length })
  })

  it('persists handles through the workspace memdir manifest', async () => {
    const first = new MemdirMemory('/workspace')
    const handle = await first.store('large durable tool result')
    expect(await new MemdirMemory('/workspace').retrieve(handle)).toBe('large durable tool result')
  })

  it('combines memdir and indexed workspace retrieval', async () => {
    const memory = new WorkspaceMemory('/workspace')
    await memory.store('数据治理的短期结论')
    const results = await memory.search('数据治理', 5)
    expect(results.map((result) => result.source)).toContain('资料/需求.md')
    expect(results.some((result) => result.content.includes('短期结论'))).toBe(true)
  })

  it('keeps a retrievable in-memory handle when workspace persistence fails', async () => {
    writeWorkspaceFile.mockRejectedValue(new Error('workspace is read-only'))
    const memory = new WorkspaceMemory('/workspace')

    const handle = await memory.store('large transient evidence')

    expect(handle).toMatch(/^handle-/)
    expect(await memory.retrieve(handle)).toBe('large transient evidence')
  })

  it('formats retrieved memory for the before-query hook', async () => {
    const memory = new WorkspaceMemory('/workspace')
    const context = await prefetchMemory([{ role: 'user', content: '数据治理' }], memory)
    expect(context).toContain('[资料/需求.md] 统一数据治理平台')
  })
})
