import { describe, expect, it } from 'vitest'
import { runQuery } from '../query'
import { ProviderRegistry } from '../../model'
import type { CompletionChunk, CompletionRequest, ModelProvider } from '../../model'
import type { QueryContext, QueryEvent, SnapshotStore, TurnSnapshot } from '../types'
import type { Tool, ToolResult } from '../../tools/types'
import { InMemoryState } from '../../memory'
import { folderTaskTools } from '../../tools/builtin/folder-tasks'

function toolTurn(id: string, name: string, input: unknown): CompletionChunk[] {
  return [
    { type: 'tool_call_start', id, name },
    { type: 'tool_call_end', id, input },
    {
      type: 'message_end',
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
      stopReason: 'tool_use',
    },
  ]
}

function scriptedProvider(script: CompletionChunk[][], requests: CompletionRequest[]): ModelProvider {
  let turn = 0
  return {
    name: 'mock',
    metadata: {
      name: 'mock',
      displayName: 'Mock',
      supportsVision: false,
      supportsTools: true,
      supportsStreaming: true,
      defaultMaxTokens: 4096,
      models: ['mock-model'],
    },
    async *stream(request) {
      requests.push(request)
      yield { type: 'message_start' }
      yield* script[turn++]
    },
  }
}

describe('FolderTask staged capability sequence', () => {
  it('runs context → claim → read → checkpoint without one-shot tools revoking later stages', async () => {
    const requests: CompletionRequest[] = []
    const provider = scriptedProvider([
      toolTurn('context', 'get_folder_task_context', {}),
      toolTurn('claim', 'claim_folder_task_batch', {}),
      toolTurn('read', 'read_folder_task_file', { batchToken: 'lease-1', relativePath: 'input/resource.txt' }),
      toolTurn('checkpoint', 'update_folder_task_batch', {
        batchToken: 'lease-1',
        updates: [{ itemId: 'item-1', status: 'completed', result: { resource: 'ecs-001' } }],
      }),
      [
        { type: 'content_delta', delta: '批次检查点已保存。' },
        {
          type: 'message_end',
          usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
          stopReason: 'end_turn',
        },
      ],
    ], requests)
    const registry = new ProviderRegistry()
    registry.register('mock', provider)
    const executed: string[] = []
    const tools = folderTaskTools.map((tool) => ({
      ...tool,
      async execute(input: unknown): Promise<ToolResult> {
        executed.push(tool.name)
        return {
          success: true,
          content: JSON.stringify({ tool: tool.name, input }),
          metadata: { durationMs: 0 },
        }
      },
    })) as Tool[]
    const context: QueryContext = {
      runId: 'folder-task-sequence',
      conversationId: 'folder-task-conversation',
      cwd: '/',
      messages: [{ role: 'user', content: '继续当前文件夹任务' }],
      tools,
      folderTaskId: 'task-1',
      platform: 'tauri',
      memory: new InMemoryState(),
      model: { provider: 'mock', model: 'mock-model' },
      limits: {
        maxTurns: 8,
        maxTokens: 100_000,
        maxOutputTokens: 1000,
        maxToolCalls: 10,
        toolTimeoutMs: 1000,
        toolLoopBudgets: {
          'folder-task-context': { maxCalls: 1, softThreshold: 1, hardThreshold: 1 },
          'folder-task-plan': { maxCalls: 3, softThreshold: 2, hardThreshold: 3 },
          'folder-task-claim': { maxCalls: 1, softThreshold: 1, hardThreshold: 1 },
          'folder-task-read': { maxCalls: 45, softThreshold: 36, hardThreshold: 45 },
          'folder-task-checkpoint': { maxCalls: 2, softThreshold: 2, hardThreshold: 2 },
          'folder-task-decision': { maxCalls: 2, softThreshold: 2, hardThreshold: 2 },
          'folder-task-results': { maxCalls: 5, softThreshold: 3, hardThreshold: 5 },
          'folder-task-review': { maxCalls: 10, softThreshold: 6, hardThreshold: 10 },
          'folder-task-output': { maxCalls: 2, softThreshold: 2, hardThreshold: 2 },
        },
      },
      signal: new AbortController().signal,
      providerRegistry: registry,
    }
    const events: QueryEvent[] = []
    for await (const event of runQuery(context)) events.push(event)

    expect(executed).toEqual([
      'get_folder_task_context',
      'claim_folder_task_batch',
      'read_folder_task_file',
      'update_folder_task_batch',
    ])
    expect(requests.every((request) => request.timeout === 180_000 && request.stallTimeoutMs === 120_000)).toBe(true)
    expect(requests[0].tools?.map((tool) => tool.name)).toContain('get_folder_task_context')
    expect(requests[0].tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'list_folder_task_results',
      'revise_folder_task_result',
      'write_folder_task_output',
    ]))
    expect(requests[1].tools?.map((tool) => tool.name)).not.toContain('get_folder_task_context')
    expect(requests[1].tools?.map((tool) => tool.name)).toContain('claim_folder_task_batch')
    expect(requests[2].tools?.map((tool) => tool.name)).not.toContain('claim_folder_task_batch')
    expect(requests[2].tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'read_folder_task_file',
      'update_folder_task_batch',
      'request_folder_task_decision',
    ]))
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  it('does not accept a text-only ending while a claimed batch lacks a checkpoint', async () => {
    const requests: CompletionRequest[] = []
    const provider = scriptedProvider([
      toolTurn('claim', 'claim_folder_task_batch', {}),
      [
        { type: 'content_delta', delta: '已经处理完成。' },
        { type: 'message_end', stopReason: 'end_turn' },
      ],
      toolTurn('checkpoint', 'update_folder_task_batch', {
        batchToken: 'lease-1',
        updates: [{ itemId: 'item-1', status: 'completed', result: {} }],
      }),
      [
        { type: 'content_delta', delta: '批次检查点已保存。' },
        { type: 'message_end', stopReason: 'end_turn' },
      ],
    ], requests)
    const registry = new ProviderRegistry()
    registry.register('mock', provider)
    const executed: string[] = []
    const tools = folderTaskTools.map((tool) => ({
      ...tool,
      async execute(): Promise<ToolResult> {
        executed.push(tool.name)
        return {
          success: true,
          content: JSON.stringify({ tool: tool.name }),
          data: tool.name === 'claim_folder_task_batch'
            ? { batch: { id: 'batch-1', leaseToken: 'lease-1' }, items: [{ id: 'item-1' }] }
            : {},
          metadata: { durationMs: 0 },
        }
      },
    })) as Tool[]
    const context: QueryContext = {
      runId: 'folder-task-checkpoint-guard',
      conversationId: 'folder-task-conversation',
      cwd: '/',
      messages: [{ role: 'user', content: '处理下一批' }],
      tools,
      folderTaskId: 'task-1',
      platform: 'tauri',
      memory: new InMemoryState(),
      model: { provider: 'mock', model: 'mock-model' },
      limits: {
        maxTurns: 6,
        maxTokens: 100_000,
        maxOutputTokens: 1000,
        maxToolCalls: 10,
        toolTimeoutMs: 1000,
      },
      signal: new AbortController().signal,
      providerRegistry: registry,
    }
    const events: QueryEvent[] = []

    for await (const event of runQuery(context)) events.push(event)

    expect(executed).toEqual(['claim_folder_task_batch', 'update_folder_task_batch'])
    expect(requests).toHaveLength(4)
    expect(JSON.stringify(requests[2].messages)).toContain('当前领取的批次尚未保存完整检查点')
    expect(events.some((event) => event.type === 'message.delta' && event.text.includes('已经处理完成'))).toBe(false)
    expect(events.find((event) => event.type === 'message.completed')).toMatchObject({
      content: '批次检查点已保存。',
    })
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  it('allows a claimed batch to pause after a durable user decision is requested', async () => {
    const requests: CompletionRequest[] = []
    const provider = scriptedProvider([
      toolTurn('claim', 'claim_folder_task_batch', {}),
      toolTurn('decision', 'request_folder_task_decision', {
        batchToken: 'lease-1',
        kind: 'mapping',
        title: '请选择分类规则',
        description: '存在高影响歧义',
        options: [
          { id: 'a', label: '规则 A', description: '使用规则 A' },
          { id: 'b', label: '规则 B', description: '使用规则 B' },
        ],
      }),
      [
        { type: 'content_delta', delta: '请确认应使用规则 A 还是规则 B。' },
        { type: 'message_end', stopReason: 'end_turn' },
      ],
    ], requests)
    const registry = new ProviderRegistry()
    registry.register('mock', provider)
    const executed: string[] = []
    const tools = folderTaskTools.map((tool) => ({
      ...tool,
      async execute(): Promise<ToolResult> {
        executed.push(tool.name)
        const data = tool.name === 'claim_folder_task_batch'
          ? { batch: { id: 'batch-1', leaseToken: 'lease-1' }, items: [{ id: 'item-1' }] }
          : tool.name === 'request_folder_task_decision'
            ? { paused: true, decision: { id: 'decision-1' } }
            : {}
        return { success: true, content: JSON.stringify(data), data, metadata: { durationMs: 0 } }
      },
    })) as Tool[]
    const context: QueryContext = {
      runId: 'folder-task-decision-pause',
      conversationId: 'folder-task-conversation',
      cwd: '/',
      messages: [{ role: 'user', content: '处理下一批' }],
      tools,
      folderTaskId: 'task-1',
      platform: 'tauri',
      memory: new InMemoryState(),
      model: { provider: 'mock', model: 'mock-model' },
      limits: { maxTurns: 5, maxTokens: 100_000, maxOutputTokens: 1000, maxToolCalls: 10, toolTimeoutMs: 1000 },
      signal: new AbortController().signal,
      providerRegistry: registry,
    }
    const events: QueryEvent[] = []

    for await (const event of runQuery(context)) events.push(event)

    expect(executed).toEqual(['claim_folder_task_batch', 'request_folder_task_decision'])
    expect(requests).toHaveLength(3)
    expect(events.find((event) => event.type === 'message.completed')).toMatchObject({
      content: '请确认应使用规则 A 还是规则 B。',
    })
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  it('restores the open-batch checkpoint guard after a renderer restart', async () => {
    const requests: CompletionRequest[] = []
    const provider = scriptedProvider([
      [
        { type: 'content_delta', delta: '已完成，无需保存。' },
        { type: 'message_end', stopReason: 'end_turn' },
      ],
      toolTurn('checkpoint', 'update_folder_task_batch', {
        batchToken: 'lease-1',
        updates: [{ itemId: 'item-1', status: 'completed', result: {} }],
      }),
      [
        { type: 'content_delta', delta: '恢复后的检查点已保存。' },
        { type: 'message_end', stopReason: 'end_turn' },
      ],
    ], requests)
    const registry = new ProviderRegistry()
    registry.register('mock', provider)
    const snapshot: TurnSnapshot = {
      version: 2,
      runId: 'folder-task-restored',
      turn: 1,
      messages: [
        { role: 'user', content: '处理下一批' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'claim', name: 'claim_folder_task_batch', input: {} }] },
        {
          role: 'user',
          content: [{
            type: 'tool_result', tool_use_id: 'claim',
            content: JSON.stringify({ batch: { id: 'batch-1', leaseToken: 'lease-1' }, items: [{ id: 'item-1' }] }),
          }],
        },
      ],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, toolCalls: 1 },
      folderTaskState: { batchOpen: true, decisionPauseAllowed: false, checkpointReminders: 0 },
      ts: new Date().toISOString(),
    }
    const snapshots: SnapshotStore = {
      append: async () => undefined,
      loadLatest: async () => snapshot,
      clear: async () => undefined,
    }
    const executed: string[] = []
    const tools = folderTaskTools.map((tool) => ({
      ...tool,
      async execute(): Promise<ToolResult> {
        executed.push(tool.name)
        return { success: true, content: '{}', data: {}, metadata: { durationMs: 0 } }
      },
    })) as Tool[]
    const context: QueryContext = {
      runId: 'folder-task-restored',
      conversationId: 'folder-task-conversation',
      cwd: '/',
      messages: [{ role: 'user', content: 'stale renderer history' }],
      tools,
      folderTaskId: 'task-1',
      platform: 'tauri',
      memory: new InMemoryState(),
      model: { provider: 'mock', model: 'mock-model' },
      limits: { maxTurns: 6, maxTokens: 100_000, maxOutputTokens: 1000, maxToolCalls: 10, toolTimeoutMs: 1000 },
      signal: new AbortController().signal,
      providerRegistry: registry,
      snapshots,
      restoreSnapshot: true,
    }
    const events: QueryEvent[] = []

    for await (const event of runQuery(context)) events.push(event)

    expect(executed).toEqual(['update_folder_task_batch'])
    expect(JSON.stringify(requests[1].messages)).toContain('当前领取的批次尚未保存完整检查点')
    expect(events.find((event) => event.type === 'message.completed')).toMatchObject({
      content: '恢复后的检查点已保存。',
    })
    expect(events.at(-1)?.type).toBe('run.completed')
  })
})
