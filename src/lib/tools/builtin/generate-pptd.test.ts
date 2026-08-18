import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderRegistry } from '../../model'
import { InMemoryState } from '../../memory'
import type { QueryContext } from '../../engine/types'
import type { ToolUseContext } from '../types'

const mocks = vi.hoisted(() => ({
  readWorkspaceBytes: vi.fn(),
  readWorkspaceFile: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  runPptdDeckPipeline: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  readWorkspaceBytes: mocks.readWorkspaceBytes,
  readWorkspaceFile: mocks.readWorkspaceFile,
  writeWorkspaceFile: mocks.writeWorkspaceFile,
}))
vi.mock('../../pptd/pipeline', () => ({ runPptdDeckPipeline: mocks.runPptdDeckPipeline }))

import { createGeneratePptdTool } from './generate-pptd'

function workspace() {
  return {
    root: '/workspace',
    name: 'workspace',
    resolve(path: string) {
      if (path.startsWith('/') || path.startsWith('../')) throw new Error('outside workspace')
      return `/workspace/${path}`
    },
    contains: () => true,
  }
}

function parent(overrides: Partial<QueryContext> = {}): QueryContext {
  return {
    runId: 'run', conversationId: 'conversation', cwd: '/workspace', messages: [], tools: [],
    memory: new InMemoryState(), model: { provider: 'mock', model: 'mock' },
    limits: { maxTurns: 5, maxTokens: 10_000, maxOutputTokens: 2_000, maxToolCalls: 5, toolTimeoutMs: 1_000 },
    signal: new AbortController().signal, providerRegistry: new ProviderRegistry(), workspace: workspace(),
    ...overrides,
  }
}

function toolContext(context: QueryContext): ToolUseContext {
  return {
    runId: context.runId, cwd: context.cwd, workspace: context.workspace ?? workspace(),
    memory: context.memory, settings: {} as ToolUseContext['settings'], permissions: new Map(), platform: 'tauri',
    logger: { log() {}, info() {}, warn() {}, error() {}, async flush() {}, entries: () => [] },
  }
}

describe('generate_pptd workspace media', () => {
  beforeEach(() => {
    mocks.readWorkspaceBytes.mockReset()
    mocks.readWorkspaceFile.mockReset()
    mocks.readWorkspaceFile.mockRejectedValue(new Error('not found'))
    mocks.writeWorkspaceFile.mockReset()
    mocks.writeWorkspaceFile.mockResolvedValue(1)
    mocks.runPptdDeckPipeline.mockReset()
    mocks.runPptdDeckPipeline.mockResolvedValue({
      artifact: { title: 'Deck', type: 'slides', path: '03-交付物/deck.pptd', content: '{}', envelope: '<artifact />' },
      project: { pages: [{}] }, pageReports: [], warnings: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, calls: 1 },
    })
  })

  it('loads validated workspace images and preserves colliding attachment media', async () => {
    const context = parent({
      pptdMedia: { 'media/chart.png': 'data:image/png;base64,iVBORw0KGgo=' },
    })
    mocks.readWorkspaceBytes.mockResolvedValue([137, 80, 78, 71, 13, 10, 26, 10])

    await createGeneratePptdTool(() => context).execute(
      { brief: 'deck', mediaPaths: ['reports/chart.png'] },
      toolContext(context), new AbortController().signal,
    )

    expect(mocks.readWorkspaceBytes).toHaveBeenCalledWith('reports/chart.png', '/workspace')
    expect(mocks.runPptdDeckPipeline.mock.calls[0][1].media).toEqual({
      'media/chart.png': 'data:image/png;base64,iVBORw0KGgo=',
      'media/chart-2.png': Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    })
  })

  it('wires resumable checkpoint reads and writes to the selected workspace', async () => {
    const context = parent()
    mocks.readWorkspaceFile.mockResolvedValue({ content: 'checkpoint', binary: false, bytes: 10, truncated: false })

    await createGeneratePptdTool(() => context).execute(
      { brief: 'deck' }, toolContext(context), new AbortController().signal,
    )

    const options = mocks.runPptdDeckPipeline.mock.calls[0][2] as {
      onCheckpoint(checkpoint: { path: string; content: string }): Promise<void>
      loadCheckpoint(path: string): Promise<string | undefined>
    }
    await expect(options.loadCheckpoint('.solidify/pptd-checkpoints/key/deck.pptd')).resolves.toBe('checkpoint')
    await options.onCheckpoint({ path: '.solidify/pptd-checkpoints/key/pages/01.page', content: 'elements: []' })
    expect(mocks.readWorkspaceFile).toHaveBeenCalledWith('.solidify/pptd-checkpoints/key/deck.pptd', '/workspace')
    expect(mocks.writeWorkspaceFile).toHaveBeenCalledWith(
      '.solidify/pptd-checkpoints/key/pages/01.page', 'elements: []', '/workspace',
    )
  })

  it('rejects unsupported workspace media before model generation', async () => {
    const context = parent()
    mocks.readWorkspaceBytes.mockResolvedValue([0x69, 0x63, 0x6e, 0x73, 0, 0, 0, 0])

    await expect(createGeneratePptdTool(() => context).execute(
      { brief: 'deck', mediaPaths: ['bad.icns'] },
      toolContext(context), new AbortController().signal,
    )).rejects.toThrow('不支持该图片格式')
    expect(mocks.runPptdDeckPipeline).not.toHaveBeenCalled()
  })

  it('requires an explicitly selected workspace for mediaPaths', async () => {
    const context = parent({ workspace: undefined })

    await expect(createGeneratePptdTool(() => context).execute(
      { brief: 'deck', mediaPaths: ['chart.png'] },
      toolContext(context), new AbortController().signal,
    )).rejects.toThrow('已选择工作区')
    expect(mocks.readWorkspaceBytes).not.toHaveBeenCalled()
  })

  it('does not restart the whole deck when the caller retries after a timeout', async () => {
    const context = parent()
    const tool = createGeneratePptdTool(() => context)
    const execute = () => tool.execute({ brief: 'deck' }, toolContext(context), new AbortController().signal)

    await execute()
    await expect(execute()).rejects.toThrow('已启动过 generate_pptd')
    expect(mocks.runPptdDeckPipeline).toHaveBeenCalledTimes(1)
  })

  it('unlocks the one-shot guard after a failed pipeline so a corrected call can retry', async () => {
    const context = parent()
    mocks.runPptdDeckPipeline
      .mockRejectedValueOnce(new Error('PPTD design 输出达到 token 上限'))
      .mockResolvedValueOnce({
        artifact: { title: 'Deck', type: 'slides', path: '03-交付物/deck.pptd', content: '{}', envelope: '<artifact />' },
        project: { pages: [{}] }, pageReports: [], warnings: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, calls: 1 },
      })
    const tool = createGeneratePptdTool(() => context)
    const execute = () => tool.execute({ brief: 'deck' }, toolContext(context), new AbortController().signal)

    await expect(execute()).rejects.toThrow('PPTD design 输出达到 token 上限')
    await expect(execute()).resolves.toMatchObject({ success: true })
    expect(mocks.runPptdDeckPipeline).toHaveBeenCalledTimes(2)
  })
})
