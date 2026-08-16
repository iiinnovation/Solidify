import type { QueryContext } from '../../engine/types'
import { dispatchSubAgents } from '../../engine/sub-agent/spawn'
import {
  MAX_SUB_AGENT_CONCURRENCY,
  MAX_SUB_AGENTS_PER_DISPATCH,
  type SubAgentSpec,
} from '../../engine/sub-agent/types'
import type { Tool } from '../types'

export interface DispatchAgentInput {
  tasks: SubAgentSpec[]
  concurrency?: number
}

export interface DispatchAgentOutput {
  results: Awaited<ReturnType<typeof dispatchSubAgents>>
  budget?: ReturnType<NonNullable<QueryContext['taskTree']>['budget']['snapshot']>
}

/** A dispatch runs complete child query loops, so the single-I/O fallback is too short. */
export const DISPATCH_AGENT_TIMEOUT_MS = 30 * 60_000

/** Dynamic because each root run owns a distinct budget, signal and tool set. */
export function createDispatchAgentTool(getParent: () => QueryContext): Tool<DispatchAgentInput, DispatchAgentOutput> {
  return {
    name: 'dispatch_agent',
    description: [
      'Dispatch 1-5 independent, substantial tasks to bounded sub-agents and wait for all results.',
      'Use only when parallel work will materially reduce elapsed time or improve specialist quality.',
      'Do not use for simple, sequential, tightly coupled, or low-cost tasks.',
      'Each child is isolated, cannot delegate again, shares the root token budget, and receives read-only tools by default.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tasks'],
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_SUB_AGENTS_PER_DISPATCH,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['role', 'task'],
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 80 },
              role: { type: 'string', minLength: 1, maxLength: 80 },
              task: { type: 'string', minLength: 1, maxLength: 12_000 },
              systemPrompt: { type: 'string', maxLength: 4_000 },
              allowedTools: {
                type: 'array',
                maxItems: 20,
                items: { type: 'string', minLength: 1, maxLength: 80 },
              },
              model: { type: 'string', minLength: 1, maxLength: 160 },
              maxTokens: { type: 'integer', minimum: 1 },
              maxTurns: { type: 'integer', minimum: 1 },
            },
          },
        },
        concurrency: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_SUB_AGENT_CONCURRENCY,
          default: MAX_SUB_AGENT_CONCURRENCY,
        },
      },
    },
    readOnly: false,
    concurrencySafe: false,
    destructive: false,
    requiresConfirmation: false,
    availability: 'always',
    permissions: [],
    timeoutMs: DISPATCH_AGENT_TIMEOUT_MS,
    async execute(input, _ctx, signal, onProgress) {
      const parent = getParent()
      let completed = 0
      const results = await dispatchSubAgents(parent, input.tasks, {
        concurrency: input.concurrency,
        signal,
        onProgress(progress) {
          if (!['queued', 'running'].includes(progress.status)) completed++
          onProgress?.({
            phase: 'sub_agents',
            current: completed,
            total: input.tasks.length,
            message: `${progress.role}: ${statusLabel(progress.status)}`,
            detail: {
              agent: progress,
              budget: parent.taskTree?.budget.snapshot(),
            },
          })
        },
      })
      const succeeded = results.filter((result) => result.status === 'completed').length
      const output: DispatchAgentOutput = {
        results,
        ...(parent.taskTree ? { budget: parent.taskTree.budget.snapshot() } : {}),
      }
      return {
        success: true,
        content: JSON.stringify({
          summary: `${succeeded}/${results.length} sub-agents completed`,
          results: results.map(({ agentId, role, status, content, error, usage }) => ({
            agentId, role, status, content, error, usage,
          })),
          budget: output.budget,
        }),
        data: output,
      }
    },
    renderCall(input) {
      return `并行派发 ${input.tasks.length} 个子任务`
    },
  }
}

function statusLabel(status: string): string {
  if (status === 'running') return '运行中'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'aborted') return '已停止'
  if (status === 'exhausted') return '预算耗尽'
  return '排队中'
}
