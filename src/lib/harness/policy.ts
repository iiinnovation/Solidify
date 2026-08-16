import type { Tool, ToolCall, PermissionScope, ToolUseContext } from '../tools/types'
import type { SkillResourceResolver } from '../skills/types'

export type PolicySource = 'default' | 'project' | 'user' | 'session' | 'guard'
export type PolicyEffect = 'allow' | 'ask' | 'deny'

export interface ConfirmationPrompt {
  title: string
  detail: string
  diff?: { before?: string; after: string }
  options: Array<{ label: string; decision: 'allow' | 'allow_always_in_run' | 'deny' }>
}

export type PermissionDecision =
  | { kind: 'allow'; reason: string; source: PolicySource }
  | { kind: 'ask'; reason: string; prompt: ConfirmationPrompt }
  | { kind: 'deny'; reason: string; source: PolicySource }

export interface PolicyInput {
  project?: Partial<Record<PermissionScope | string, PolicyEffect>>
  user?: Partial<Record<PermissionScope | string, PolicyEffect>>
  session?: Set<string>
}

export interface PolicyContext extends Pick<ToolUseContext, 'workspace' | 'platform' | 'settings' | 'permissions'> {
  isOnline?: boolean
  toolContext?: ToolUseContext
  skillResources?: SkillResourceResolver
}

function effectFor<I>(source: Partial<Record<string, PolicyEffect>> | undefined, tool: Tool<I>): PolicyEffect | undefined {
  return source?.[tool.name] ?? source?.[tool.permissions[0] ?? '']
}

export class PolicyEngine {
  private readonly input: PolicyInput
  constructor(input: PolicyInput = {}) { this.input = input }

  evaluate<I>(tool: Tool<I>, call: ToolCall, ctx: PolicyContext): PermissionDecision {
    const skillResources = ctx.skillResources ?? ctx.toolContext?.skillResources
    if (ctx.settings.disabledTools.includes(tool.name)) {
      return { kind: 'deny', reason: `工具 ${tool.name} 已在设置中禁用。`, source: 'user' }
    }
    if (tool.availability === 'tauri-only' && ctx.platform !== 'tauri') {
      return { kind: 'deny', reason: `工具 ${tool.name} 仅可在桌面应用中使用。`, source: 'guard' }
    }
    if (tool.availability === 'tauri-or-skill-resource' && ctx.platform !== 'tauri') {
      const path = typeof call.input?.path === 'string' ? call.input.path : undefined
      if (!path || !canReadSkillResource(tool, path, skillResources)) {
        return { kind: 'deny', reason: `工具 ${tool.name} 在 Web 端只能读取当前 Skill 的资源。`, source: 'guard' }
      }
    }
    if (tool.availability === 'online-only' && ctx.isOnline === false) {
      return { kind: 'deny', reason: '当前没有网络连接，无法执行网络工具。', source: 'guard' }
    }
    if (tool.permissions.some((scope) => scope.startsWith('fs:'))) {
      const path = typeof call.input?.path === 'string' ? call.input.path : undefined
      if (path && !canReadSkillResource(tool, path, skillResources) && !ctx.workspace.contains(path)) {
        return { kind: 'deny', reason: `不允许访问工作区之外的路径。当前工作区是 ${ctx.workspace.root}，请改用相对路径。`, source: 'guard' }
      }
    }
    const permission = tool.permissions.find((scope) => ctx.permissions.get(scope)?.status === 'denied')
    if (permission) return { kind: 'deny', reason: `权限 ${permission} 已被拒绝。`, source: 'user' }
    const permissionPrompt = tool.permissions.some((scope) => ctx.permissions.get(scope)?.status === 'prompt')
    if (tool.permissions.includes('process:spawn')) {
      return { kind: 'deny', reason: '默认策略禁止启动外部进程；请改用受约束的内置工具。', source: 'default' }
    }
    const projectEffect = effectFor(this.input.project, tool)
    const userEffect = effectFor(this.input.user, tool)
    if (projectEffect === 'deny') {
      return { kind: 'deny', reason: `项目策略禁止使用 ${tool.name}。`, source: 'project' }
    }
    if (userEffect === 'deny') {
      return { kind: 'deny', reason: `用户设置禁止使用 ${tool.name}。`, source: 'user' }
    }
    if (this.input.session?.has(tool.name)) {
      return { kind: 'allow', reason: '本次运行已获得同类操作授权。', source: 'session' }
    }
    let requiresConfirmation: boolean
    try {
      requiresConfirmation = typeof tool.requiresConfirmation === 'function'
        ? ctx.toolContext
          ? tool.requiresConfirmation(call.input as I, ctx.toolContext)
          : true
        : tool.requiresConfirmation
    } catch {
      return { kind: 'deny', reason: `工具 ${tool.name} 的确认策略执行失败，操作已拒绝。`, source: 'guard' }
    }
    if (projectEffect === 'ask' || userEffect === 'ask' || requiresConfirmation || permissionPrompt || tool.permissions.includes('net:http')) {
      return askForConfirmation(tool, call)
    }
    if (tool.name === 'dispatch_agent') {
      return { kind: 'allow', reason: '子 Agent 调度由任务树预算与深度 guard 约束。', source: 'default' }
    }
    if (
      tool.name === 'materialize_document'
      && call.input?.intent === 'artifact_materialize'
      && call.input?.creating === true
      && typeof call.input?.path === 'string'
      && call.input.path.replace(/\\/g, '/').startsWith('03-交付物/')
    ) {
      return { kind: 'allow', reason: '交付物目录内的新文件按默认策略放行。', source: 'default' }
    }
    if (tool.readOnly) {
      return { kind: 'allow', reason: '工作区内只读操作。', source: 'default' }
    }
    if (projectEffect === 'allow' || userEffect === 'allow') {
      return { kind: 'allow', reason: '策略允许该操作。', source: projectEffect === 'allow' ? 'project' : 'user' }
    }
    return askForConfirmation(tool, call)
  }
}

function canReadSkillResource<I>(
  tool: Tool<I>,
  path: string,
  resolver: SkillResourceResolver | undefined,
): boolean {
  return tool.name === 'read_file' && tool.readOnly && Boolean(resolver?.canRead(path))
}

function askForConfirmation<I>(tool: Tool<I>, call: ToolCall): Extract<PermissionDecision, { kind: 'ask' }> {
  return {
    kind: 'ask',
    reason: tool.destructive ? '该操作可能覆盖或修改用户数据，需要确认。' : '该操作需要用户确认。',
    prompt: {
      title: tool.name === 'write_file' ? '写入文件' : '确认工具操作',
      detail: tool.renderCall(call.input),
      options: [
        { label: '允许', decision: 'allow' },
        ...(tool.name !== 'delete_file' ? [{ label: '本次运行内总是允许', decision: 'allow_always_in_run' as const }] : []),
        { label: '拒绝', decision: 'deny' },
      ],
    },
  }
}

export function createDefaultPolicyEngine(): PolicyEngine { return new PolicyEngine() }
