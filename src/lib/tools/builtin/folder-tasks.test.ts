import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryState } from '@/lib/memory'
import type { Tool, ToolUseContext } from '../types'

const client = vi.hoisted(() => ({
  get: vi.fn(),
  claimBatch: vi.fn(),
  readFileBytes: vi.fn(),
  updateBatch: vi.fn(),
  requestDecision: vi.fn(),
  resolveDecision: vi.fn(),
  setStatus: vi.fn(),
  previewPlan: vi.fn(),
  confirmPlan: vi.fn(),
  listItems: vi.fn(),
  reviewItems: vi.fn(),
  writeOutput: vi.fn(),
  sandboxCapabilities: vi.fn(),
  extractText: vi.fn(),
}))
const extractor = vi.hoisted(() => ({ extractTextResult: vi.fn() }))

vi.mock('@/lib/folder-tasks/client', () => ({ folderTaskClient: client }))
vi.mock('@/lib/file-extractor', () => ({
  inferFileMimeType: () => 'text/plain',
  extractTextResult: extractor.extractTextResult,
}))

import {
  claimFolderTaskBatchTool,
  extractDocumentTextTool,
  completeFolderTaskTool,
  listFolderTaskResultsTool,
  prepareFolderTaskPlanTool,
  readFolderTaskFileTool,
  resolveFolderTaskDecisionTool,
  requestFolderTaskDecisionTool,
  reviseFolderTaskResultTool,
  updateFolderTaskBatchTool,
  writeFolderTaskOutputTool,
} from './folder-tasks'

const ctx = {
  folderTaskId: 'task-1',
  runId: 'run-1',
  messages: [{ role: 'user', content: '结果没问题，完成任务' }],
} as never
const signal = new AbortController().signal
const task = {
  id: 'task-1',
  recipe: 'structured-extraction',
  status: 'running',
  plan: {}, inventory: {}, progress: {}, decisions: [], recentEvents: [], recentRuns: [],
}

describe('FolderTask capability-token tools', () => {
  it('keeps the scheduler pending on abort until extraction has acknowledged cleanup', async () => {
    const { executeCall } = await import('../executor')
    const controller = new AbortController()
    let finish!: (value: unknown) => void
    let backendSignal!: AbortSignal
    client.extractText.mockImplementation((_request, abortSignal) => {
      backendSignal = abortSignal
      return new Promise((resolve) => { finish = resolve })
    })
    const context = { folderTaskId: 'task-1', runId: 'run-1', platform: 'tauri', memory: new InMemoryState(),
      sandboxCapabilities: [{ method: 'image_ocr', available: true }] } as unknown as ToolUseContext
    let settled = false
    const pending = executeCall(extractDocumentTextTool as Tool,
      { id: 'call', name: extractDocumentTextTool.name, input: { batchToken: 'batch', relativePath: 'scan.png', method: 'image_ocr' } },
      { ctx: context, signal: controller.signal, defaultTimeoutMs: 1000 }).then((result) => { settled = true; return result })
    controller.abort()
    await Promise.resolve()
    await Promise.resolve()
    expect(backendSignal.aborted).toBe(true)
    expect(settled).toBe(false)
    finish({ complete: true, pages: [] })
    expect(await pending).toMatchObject({ success: false, error: { kind: 'aborted' } })
    expect(client.extractText).toHaveBeenCalledTimes(1)
  })

  it('injects trusted extraction identity and forwards cancellation', async () => {
    const { validateInput } = await import('../executor')
    const input = { batchToken: 'batch', relativePath: 'scan.png', method: 'image_ocr' as const }
    expect(validateInput({ ...input, taskId: 'forged' }, extractDocumentTextTool.inputSchema).ok).toBe(false)
    const context = { folderTaskId: 'task-1', runId: 'run-1', platform: 'tauri',
      sandboxCapabilities: [{ method: 'image_ocr', available: true }] } as never
    client.extractText.mockResolvedValue({ complete: true, sourceHash: 'hash', pages: [] })
    expect((await extractDocumentTextTool.execute(input, context, signal)).success).toBe(true)
    expect(client.extractText).toHaveBeenCalledWith({ ...input, taskId: 'task-1', runId: 'run-1', callId: expect.any(String) }, signal)
    client.extractText.mockClear()
    expect((await extractDocumentTextTool.execute(input, ctx, signal)).success).toBe(false)
    expect(client.extractText).not.toHaveBeenCalled()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    client.get.mockResolvedValue(task)
    client.sandboxCapabilities.mockResolvedValue([{ method: 'image_ocr', available: false, reasonCode: 'dependency_missing', reason: 'missing' }])
    extractor.extractTextResult.mockResolvedValue({ status: 'parsed', content: 'hello world', totalCharacters: 11, warnings: [], parser: 'browser-text', parserVersion: 'test' })
  })

  it('returns an external-parser route without presenting missing OCR as business failure', async () => {
    client.readFileBytes.mockResolvedValue({ name: 'scan.png', bytes: [1], size: 1, contentHash: 'hash' })
    extractor.extractTextResult.mockResolvedValue({ status: 'unsupported', content: '', totalCharacters: 0,
      warnings: ['needs OCR'], parser: 'none', parserVersion: 'test', externalMethods: ['image_ocr'], reasonCode: 'image_requires_ocr' })
    const result = await readFolderTaskFileTool.execute({ batchToken: 'batch', relativePath: 'scan.png' }, ctx, signal)
    expect(result).toMatchObject({ success: true, data: { status: 'needs_external_parser', sourceHash: 'hash',
      methods: [{ method: 'image_ocr', available: false, reasonCode: 'dependency_missing' }] } })
    expect(JSON.stringify(result)).toContain('awaiting_external_parser')
  })

  it('claims a batch for the authoritative Agent run and returns its lease', async () => {
    client.claimBatch.mockResolvedValue({
      batch: { id: 'batch-1', leaseToken: 'lease-1' },
      items: [{ id: 'item-1', relativePath: 'one.txt' }],
    })
    const result = await claimFolderTaskBatchTool.execute({}, ctx, signal)
    expect(client.claimBatch).toHaveBeenCalledWith('task-1', 'run-1')
    expect(result.content).toContain('lease-1')
  })

  it('turns the natural-language goal into a bound semantic plan before claiming', async () => {
    const awaiting = {
      ...task,
      status: 'awaiting_plan_confirmation',
      revision: 4,
      plan: { output: { autoWrite: false } },
    }
    const running = { ...awaiting, status: 'running', revision: 5 }
    client.get.mockResolvedValue(awaiting)
    client.previewPlan.mockResolvedValue({ confirmationToken: 'confirm-chat', selectedFiles: 3, excludedFiles: 1 })
    client.confirmPlan.mockResolvedValue(running)
    const recipePlan = {
      kind: 'structured-extraction' as const,
      schemaVersion: 1 as const,
      fields: [{ name: 'amount', description: '合同金额', type: 'number' as const, required: true, aliases: ['金额'] }],
      dedupeKeys: [],
    }

    const result = await prepareFolderTaskPlanTool.execute({ recipe: 'structured-extraction', recipePlan }, ctx, signal)

    expect(result.success).toBe(true)
    expect(client.previewPlan).toHaveBeenCalledWith('task-1', expect.objectContaining({
      recipe: 'structured-extraction',
      recipePlan,
      output: { autoWrite: true },
    }), 4)
    expect(client.confirmPlan).toHaveBeenCalledWith('task-1', 'confirm-chat', 4)
  })

  it('binds file reads to the run and lease token', async () => {
    client.readFileBytes.mockResolvedValue({ name: 'one.txt', bytes: [104, 105], size: 2, contentHash: 'abc' })
    const result = await readFolderTaskFileTool.execute({ batchToken: 'lease-1', relativePath: 'one.txt' }, ctx, signal)
    expect(client.readFileBytes).toHaveBeenCalledWith('task-1', 'run-1', 'lease-1', 'one.txt')
    expect(result.success).toBe(true)
  })

  it('reports pagination metadata for the returned slice', async () => {
    client.readFileBytes.mockResolvedValue({ name: 'one.txt', bytes: [104, 105], size: 2, contentHash: 'abc' })

    const result = await readFolderTaskFileTool.execute({
      batchToken: 'lease-1',
      relativePath: 'one.txt',
      offset: 6,
      limit: 3,
    }, ctx, signal)

    expect(result.data).toMatchObject({
      content: 'wor',
      offset: 6,
      nextOffset: 9,
      totalCharacters: 11,
      returnedCharacters: 3,
    })
  })

  it('caps an oversized provider read request instead of rejecting the claimed batch', async () => {
    client.readFileBytes.mockResolvedValue({ name: 'large.txt', bytes: [104, 105], size: 2, contentHash: 'abc' })
    extractor.extractTextResult.mockResolvedValue({
      status: 'parsed', content: 'x'.repeat(30_000), totalCharacters: 30_000,
      warnings: [], parser: 'browser-text', parserVersion: 'test',
    })

    const result = await readFolderTaskFileTool.execute({
      batchToken: 'lease-1',
      relativePath: 'large.txt',
      limit: 50_000,
    }, ctx, signal)

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ returnedCharacters: 24_000, nextOffset: 24_000 })
  })

  it('rejects a completed result that violates the selected recipe', async () => {
    const result = await updateFolderTaskBatchTool.execute({
      batchToken: 'lease-1',
      updates: [{ itemId: 'item-1', status: 'completed', result: { summary: 'missing facts' } }],
    }, ctx, signal)
    expect(result.success).toBe(false)
    expect(result.content).toContain('facts')
    expect(client.updateBatch).not.toHaveBeenCalled()
  })

  it('normalizes path identifiers, status aliases, and flattened result fields before IPC', async () => {
    client.listItems.mockResolvedValue([{
      id: 'item-1',
      relativePath: 'nested/one.txt',
      status: 'processing',
    }])
    client.updateBatch.mockResolvedValue(task)

    const result = await updateFolderTaskBatchTool.execute({
      batchToken: 'lease-1',
      updates: [{
        relativePath: './nested\\one.txt',
        status: 'done',
        summary: 'normalized result',
        facts: [{ label: 'name', value: 'one', evidence: 'hello world' }],
      }],
    }, ctx, signal)

    expect(result.success).toBe(true)
    expect(client.listItems).toHaveBeenCalledWith('task-1', 'processing', 0, 100)
    expect(client.updateBatch).toHaveBeenCalledWith(
      'task-1',
      'run-1',
      'lease-1',
      [{
        itemId: 'item-1',
        status: 'completed',
        result: {
          summary: 'normalized result',
          facts: [{ label: 'name', value: 'one', evidence: 'hello world' }],
        },
      }],
      undefined,
    )
  })

  it('normalizes common classification result aliases without inventing fields', async () => {
    const classificationTask = {
      ...task,
      recipe: 'classification',
      plan: {
        recipePlan: {
          kind: 'classification',
          schemaVersion: 1,
          categories: [
            { id: 'match', label: 'Match', description: 'Matches' },
            { id: 'no_match', label: 'No match', description: 'Does not match' },
          ],
          minimumConfidence: 0.65,
          unknownCategory: 'uncertain',
        },
      },
    }
    client.get.mockResolvedValue(classificationTask)
    client.updateBatch.mockResolvedValue(classificationTask)

    const result = await updateFolderTaskBatchTool.execute({
      batchToken: 'lease-1',
      updates: [{
        itemId: 'item-1',
        status: 'success',
        summary: 'classification complete',
        classification: 'match',
        confidence: 0.9,
        reason: 'The document matches the goal.',
      }],
    }, ctx, signal)

    expect(result.success).toBe(true)
    expect(client.updateBatch).toHaveBeenCalledWith(
      'task-1',
      'run-1',
      'lease-1',
      [{
        itemId: 'item-1',
        status: 'completed',
        result: {
          summary: 'classification complete',
          category: 'match',
          confidence: 0.9,
          rationale: 'The document matches the goal.',
        },
      }],
      undefined,
    )
  })

  it('passes only the structured decision payload after consuming the lease token', async () => {
    client.requestDecision.mockResolvedValue({ id: 'decision-1' })
    client.get.mockResolvedValue({ ...task, status: 'awaiting_decision' })
    const result = await requestFolderTaskDecisionTool.execute({
      batchToken: 'lease-1',
      kind: 'mapping',
      title: 'Choose mapping',
      description: 'Ambiguous mapping',
      options: [
        { id: 'a', label: 'A', description: 'A' },
        { id: 'b', label: 'B', description: 'B' },
      ],
    }, ctx, signal)
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ paused: true, decision: { id: 'decision-1' } })
    expect(client.requestDecision).toHaveBeenCalledWith(
      'task-1',
      'run-1',
      'lease-1',
      expect.not.objectContaining({ batchToken: expect.anything() }),
    )
  })

  it('applies a conversational answer to the pending business decision', async () => {
    const pendingTask = {
      ...task,
      revision: 9,
      status: 'awaiting_decision',
      decisions: [{
        id: 'decision-1',
        status: 'pending',
        applyKey: 'date-format',
        options: [{ id: 'day-first' }, { id: 'month-first' }],
      }],
    }
    const resumedTask = { ...pendingTask, status: 'running', revision: 10, decisions: [] }
    client.get.mockResolvedValue(pendingTask)
    client.resolveDecision.mockResolvedValue(resumedTask)

    const result = await resolveFolderTaskDecisionTool.execute({
      decisionId: 'decision-1',
      optionId: 'day-first',
      note: '用户说按日/月/年处理',
    }, ctx, signal)

    expect(result.success).toBe(true)
    expect(client.resolveDecision).toHaveBeenCalledWith({
      taskId: 'task-1',
      decisionId: 'decision-1',
      optionId: 'day-first',
      note: '用户说按日/月/年处理',
      applyToSimilar: true,
      expectedRevision: 9,
    })
  })

  it('completes review only through the explicit conversational completion tool', async () => {
    const reviewingTask = { ...task, status: 'reviewing', revision: 12, decisions: [] }
    const completedTask = { ...reviewingTask, status: 'completed', revision: 13 }
    client.get.mockResolvedValue(reviewingTask)
    client.setStatus.mockResolvedValue(completedTask)

    const result = await completeFolderTaskTool.execute({}, ctx, signal)

    expect(result.success).toBe(true)
    expect(client.setStatus).toHaveBeenCalledWith('task-1', 'complete', 12)
  })

  it('rejects completion when the latest user message asks for a correction', async () => {
    client.get.mockResolvedValue({ ...task, status: 'reviewing', revision: 12 })

    const result = await completeFolderTaskTool.execute({}, {
      folderTaskId: 'task-1',
      runId: 'run-1',
      messages: [{ role: 'user', content: '结果不对，先不要完成任务' }],
    } as never, signal)

    expect(result.success).toBe(false)
    expect(client.setStatus).not.toHaveBeenCalled()
  })

  it('does not mistake an automatic continuation prompt for user confirmation', async () => {
    client.get.mockResolvedValue({ ...task, status: 'reviewing', revision: 12 })

    const result = await completeFolderTaskTool.execute({}, {
      folderTaskId: 'task-1',
      runId: 'run-1',
      messages: [{ role: 'user', content: '请开始处理我选择的文档。任务目标：完成任务清单' }],
    } as never, signal)

    expect(result.success).toBe(false)
    expect(client.setStatus).not.toHaveBeenCalled()
  })

  it('accepts a concise natural-language completion confirmation', async () => {
    const reviewingTask = { ...task, status: 'reviewing', revision: 12, decisions: [] }
    client.get.mockResolvedValue(reviewingTask)
    client.setStatus.mockResolvedValue({ ...reviewingTask, status: 'completed', revision: 13 })

    const result = await completeFolderTaskTool.execute({}, {
      folderTaskId: 'task-1',
      runId: 'run-1',
      messages: [{ role: 'user', content: '没问题，完成吧' }],
    } as never, signal)

    expect(result.success).toBe(true)
    expect(client.setStatus).toHaveBeenCalledWith('task-1', 'complete', 12)
  })

  it('lists persisted results for conversational review', async () => {
    client.listItems.mockResolvedValue([{
      id: 'item-1',
      relativePath: 'one.txt',
      status: 'completed',
      result: { summary: 'ok', facts: [] },
      attempts: 1,
    }])

    const result = await listFolderTaskResultsTool.execute({ status: 'completed' }, ctx, signal)

    expect(result.success).toBe(true)
    expect(client.listItems).toHaveBeenCalledWith('task-1', 'completed', 0, 20)
    expect(result.content).toContain('one.txt')
  })

  it('applies a validated result correction and can regenerate output', async () => {
    const reviewing = {
      ...task,
      status: 'reviewing',
      revision: 12,
      plan: { recipePlan: { kind: 'structured-extraction', schemaVersion: 1, fields: [], dedupeKeys: [] } },
    }
    const revised = { ...reviewing, revision: 13 }
    client.get.mockResolvedValue(reviewing)
    client.reviewItems.mockResolvedValue(revised)
    client.writeOutput.mockResolvedValue({ ...revised, revision: 14 })

    const revision = await reviseFolderTaskResultTool.execute({
      itemId: 'item-1',
      action: 'accept',
      result: { summary: 'corrected', facts: [] },
    }, ctx, signal)
    const output = await writeFolderTaskOutputTool.execute({}, ctx, signal)

    expect(revision.success).toBe(true)
    expect(client.reviewItems).toHaveBeenCalledWith('task-1', [{
      itemId: 'item-1',
      action: 'accept',
      result: { summary: 'corrected', facts: [] },
      error: undefined,
    }], 12)
    expect(output.success).toBe(true)
    expect(client.writeOutput).toHaveBeenCalledWith('task-1', 12)
  })
})
