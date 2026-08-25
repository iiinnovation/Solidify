import { describe, expect, it } from 'vitest'
import { runQuery } from '../query'
import { ProviderRegistry } from '../../model'
import type { CompletionChunk, CompletionRequest, ModelProvider } from '../../model'
import type { QueryContext, QueryEvent } from '../types'
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
      toolTurn('read', 'read_folder_task_file', { relativePath: 'input/resource.txt' }),
      toolTurn('checkpoint', 'update_folder_task_batch', {
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
          'folder-task-claim': { maxCalls: 1, softThreshold: 1, hardThreshold: 1 },
          'folder-task-read': { maxCalls: 45, softThreshold: 36, hardThreshold: 45 },
          'folder-task-checkpoint': { maxCalls: 2, softThreshold: 2, hardThreshold: 2 },
          'folder-task-decision': { maxCalls: 1, softThreshold: 1, hardThreshold: 1 },
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
    expect(requests[0].tools?.map((tool) => tool.name)).toContain('get_folder_task_context')
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
})
