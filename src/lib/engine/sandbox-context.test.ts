import { describe, expect, it, vi, beforeEach } from 'vitest'
const capabilities = vi.hoisted(() => vi.fn())
vi.mock('../folder-tasks/client', () => ({ folderTaskClient: { sandboxCapabilities: capabilities } }))
import { prepareSandboxContext } from './sandbox-context'
import { extractDocumentTextTool } from '../tools/builtin/folder-tasks'
import { PolicyEngine } from '../harness/policy'
import { ToolRegistry } from '../tools/registry'
import type { QueryContext } from './types'
import type { Tool, ToolUseContext } from '../tools/types'

const ready = [{ method: 'image_ocr' as const, available: true, reasonCode: null, reason: null }]
const context = () => ({ platform: 'tauri', folderTaskId: 'task', tools: [extractDocumentTextTool],
  signal: new AbortController().signal, sandboxCapabilities: ready }) as unknown as QueryContext

describe('sandbox run capability boundary', () => {
  beforeEach(() => { capabilities.mockReset() })
  it('refreshes restored capabilities and removes unavailable tools', async () => {
    capabilities.mockRejectedValue(new Error('offline'))
    const result = await prepareSandboxContext(context())
    expect(result.sandboxCapabilities).toEqual([])
    expect(result.tools).toEqual([])
    capabilities.mockResolvedValue(ready)
    expect((await prepareSandboxContext(context())).tools).toEqual([extractDocumentTextTool])
  })
  it('does not probe or expose extraction outside desktop tasks', async () => {
    const result = await prepareSandboxContext({ ...context(), folderTaskId: undefined })
    expect(result.tools).toEqual([])
    expect(capabilities).not.toHaveBeenCalled()
    const registry = new ToolRegistry()
    registry.register(extractDocumentTextTool as Tool)
    expect(registry.resolve({ platform: 'tauri', userDisabledTools: [], isOnline: true })).toEqual([])
  })
  it('allows only the exact fixed pipeline and preserves every explicit permission denial', () => {
    const ctx = { platform: 'tauri' as const, settings: { disabledTools: [] } as never,
      workspace: {} as never, permissions: new Map(),
      toolContext: { folderTaskId: 'task', sandboxCapabilities: ready } as unknown as ToolUseContext }
    const call = { id: 'call', name: extractDocumentTextTool.name, input: { method: 'image_ocr' } }
    expect(new PolicyEngine().evaluate(extractDocumentTextTool, call, ctx).kind).toBe('allow')
    expect(new PolicyEngine().evaluate({ ...extractDocumentTextTool }, call, ctx).kind).toBe('deny')
    expect(new PolicyEngine().evaluate(extractDocumentTextTool, { ...call, input: { method: 'pdf_ocr' } }, ctx).kind).toBe('deny')
    for (const source of ['user', 'project']) {
      expect(new PolicyEngine({ [source]: { extract_document_text: 'allow', 'process:spawn': 'deny' } })
        .evaluate(extractDocumentTextTool, call, ctx).kind).toBe('deny')
    }
  })
})
