import type { QueryContext, Message } from '../engine/types'
import type { Tool, ToolCall, ToolResult } from '../tools/types'
import { ApprovalService, type ApprovalResponder, type ApprovalOutcome } from './approval'
import { HookManager, type GuardDecision } from './hooks'
import { RunLedger } from './ledger'
import { PolicyEngine, type PolicyInput, type PermissionDecision } from './policy'
import { approvalResponder } from './approval-channel'
import { builtinSkills } from '../skills'
import { prefetchMemory } from '../memory'

export interface HarnessRuntimeOptions {
  policy?: PolicyInput
  approvalResponder?: ApprovalResponder
  ledger?: RunLedger
  onApprovalEvent?: (event: { type: 'approval.asked' | 'approval.decided'; requestId: string; callId: string; outcome?: ApprovalOutcome }) => void | Promise<void>
}

export interface HarnessRuntime {
  hooks: HookManager
  policy: PolicyEngine
  approvals: ApprovalService
  ledger: RunLedger
}

export function createHarnessRuntime(ctx: QueryContext, options: HarnessRuntimeOptions = {}): HarnessRuntime {
  const ledger = options.ledger ?? new RunLedger(ctx.runId)
  const approvals = new ApprovalService({
    respond: options.approvalResponder ?? approvalResponder,
    onEvent: async (event) => {
      const request = event.request
      if (event.type === 'approval.asked') ledger.append('approval.asked', { requestId: request.requestId, callId: request.callId, toolName: request.toolName, reason: request.reason, prompt: request.prompt })
      else ledger.append('approval.decided', { requestId: request.requestId, callId: request.callId, outcome: event.outcome ?? 'unavailable' })
      await options.onApprovalEvent?.({ type: event.type, requestId: request.requestId, callId: request.callId, outcome: event.outcome })
    },
    onSessionGrant: (request) => {
      ledger.append('permission.grant_added', { requestId: request.requestId, toolName: request.toolName, grantKey: request.grantKey, scope: 'run' })
    },
  })
  const hooks = new HookManager()
  hooks.register({ id: 'injectEnvironment', type: 'before_query', mode: 'waterfall', priority: 10, handler: (value: unknown) => ({ action: 'continue' as const, value: appendQueryContext(value, `Environment: cwd=${ctx.cwd}; platform=${ctx.platform ?? 'web'}; time=${new Date().toISOString()}`) }) })
  hooks.register({ id: 'prefetchWorkspaceMemory', type: 'before_query', mode: 'waterfall', priority: 15, handler: async (value: unknown) => {
    // Retrieval is an optional enrichment: a failure here must never abort the
    // run. It also must not reach `context` — that array lands in the system
    // prompt, and retrieved file text is untrusted (M2-14). It travels in
    // `retrievedContext`, which buildMessages injects as a user message.
    try {
      const memoryContext = await prefetchMemory(ctx.messages, ctx.memory)
      if (!memoryContext || !isRecord(value)) return { action: 'continue' as const, value }
      return { action: 'continue' as const, value: { ...value, retrievedContext: memoryContext } }
    } catch (error) {
      console.warn('[harness] Workspace memory prefetch failed, continuing without it:', error)
      return { action: 'continue' as const, value }
    }
  } })
  hooks.register({ id: 'injectSkillIndex', type: 'before_query', mode: 'waterfall', priority: 20, handler: (value: unknown) => ({ action: 'continue' as const, value: appendQueryContext(value, `Available skills:\n${builtinSkills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')}`) }) })
  hooks.register({ id: 'enforceTokenBudget', type: 'before_model_call', mode: 'waterfall', priority: 30, handler: (value: unknown) => {
    const usage = isRecord(value) && isRecord(value.usage) ? Number(value.usage.totalTokens ?? 0) : 0
    return usage >= ctx.limits.maxTokens ? { action: 'abort' as const, reason: 'Run token budget exhausted' } : { action: 'continue' as const, value }
  } })
  return { hooks, policy: new PolicyEngine(options.policy), approvals, ledger }
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function appendQueryContext(value: unknown, text: string): unknown {
  if (!isRecord(value)) return value
  const current = Array.isArray(value.context) ? value.context : []
  return { ...value, context: [...current, text] }
}

export function permissionGate(runtime: HarnessRuntime, ctx: QueryContext, tool: Tool, call: ToolCall): Promise<PermissionDecision | { kind: 'deny'; reason: string; source: 'approval' }> {
  const fallbackSettings = {
    model: { provider: 'anthropic' as const, model: ctx.model.model, temperature: 0.7, maxTokens: ctx.limits.maxOutputTokens },
    ui: { theme: 'auto' as const, fontSize: 14, codeTheme: 'default', compactMode: false },
    privacy: { allowTelemetry: false, allowCrashReports: false, shareUsageData: false },
    features: { agentLoop: false, toolCalling: false, harness: true, localWorkspace: false, workbenchV2: false, skillV2: false, pptdEngine: false, subAgents: false },
    disabledTools: [], workspaceRoot: ctx.cwd,
  }
  const toolContext = {
    workspace: ctx.workspace ?? { root: ctx.cwd, name: 'workspace', resolve: (path: string) => path, contains: () => true },
    platform: ctx.platform ?? 'web',
    settings: ctx.settings ?? fallbackSettings,
    permissions: ctx.permissions ?? new Map(),
  }
  const decision = runtime.policy.evaluate(tool, call, toolContext)
  if (decision.kind !== 'ask') return Promise.resolve(decision)
  const grantKey = sessionGrantKey(tool, call)
  if (runtime.approvals.hasSessionGrant(grantKey)) return Promise.resolve({ kind: 'allow', reason: '本次运行已获得同类操作授权。', source: 'session' })
  return runtime.approvals.request({ runId: ctx.runId, callId: call.id, toolName: tool.name, grantKey, reason: decision.reason, prompt: decision.prompt, signal: ctx.signal }).then(({ outcome }) => {
    if (outcome === 'allowed_once') return { kind: 'allow', reason: '用户已确认该操作。', source: 'session' as const }
    return { kind: 'deny', reason: outcome === 'cancelled' ? '用户已停止运行，未执行该操作。' : '用户未授权该操作，已跳过执行。', source: 'approval' as const }
  })
}

/** Input keys that carry a filesystem path in any current or future fs tool. */
const PATH_INPUT_KEYS = ['path', 'source', 'destination', 'dest', 'from', 'to', 'filePath', 'file_path', 'target']

/**
 * Monotonic hard boundary: runs after approval and can only deny or abstain.
 *
 * Path candidates are derived from a key list rather than the single literal
 * `path`, so a tool that names its parameter `source`/`dest` cannot silently
 * escape the workspace boundary — the previous version simply abstained.
 */
export function hardGuard(ctx: QueryContext, tool: Tool, call: ToolCall): GuardDecision {
  if (tool.permissions.some((scope) => scope.startsWith('fs:'))) {
    const workspace = ctx.workspace
    for (const key of PATH_INPUT_KEYS) {
      const value = call.input?.[key]
      if (typeof value !== 'string') continue
      if (!workspace || !workspace.contains(value)) {
        return { kind: 'deny', reason: '路径超出当前工作区边界。', source: 'workspace-boundary' }
      }
    }
  }
  if (tool.availability === 'tauri-only' && ctx.platform !== 'tauri') return { kind: 'deny', reason: '当前平台不支持此工具。', source: 'platform' }
  return { kind: 'abstain' }
}

export function recordToolRequested(runtime: HarnessRuntime, call: ToolCall): void { runtime.ledger.append('tool.requested', { callId: call.id, name: call.name, input: call.input }) }
export function recordToolCompleted(runtime: HarnessRuntime, callId: string, result: ToolResult): void { runtime.ledger.append('tool.completed', { callId, success: result.success, content: result.content, error: result.error, metadata: result.metadata, handle: result.handle }) }

/**
 * Key under which a "always allow in this run" grant is stored.
 *
 * The grant must be no broader than what the confirmation dialog actually
 * showed. A bare tool name would turn "写入 03-交付物/需求规格.md" into blanket
 * authorization for every subsequent write to any path in the run — the user
 * approved one file and would have granted the whole workspace.
 */
export function sessionGrantKey(tool: Tool, call: ToolCall): string {
  if (tool.permissions.includes('net:http')) {
    const rawUrl = typeof call.input?.url === 'string' ? call.input.url : undefined
    if (!rawUrl) return `${tool.name}:call:${call.id}`
    try { return `${tool.name}:domain:${new URL(rawUrl).hostname.toLowerCase()}` }
    catch { return `${tool.name}:call:${call.id}` }
  }
  // Filesystem tools are scoped to the exact path the user saw and approved.
  if (tool.permissions.some((scope) => scope.startsWith('fs:'))) {
    const path = typeof call.input?.path === 'string' ? call.input.path : undefined
    return path ? `${tool.name}:path:${path}` : `${tool.name}:call:${call.id}`
  }
  return tool.name
}

export function injectEnvironment(_ctx: QueryContext, messages: readonly Message[]): Message[] {
  return [...messages]
}
