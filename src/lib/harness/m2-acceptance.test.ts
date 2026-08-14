import { describe, expect, it, vi } from 'vitest'
import { ApprovalService } from './approval'
import { RunLedger, recoverLedger, snapshotJson } from './ledger'
import { deriveRunTelemetry, loadRecentRunTelemetry, sanitizeTelemetry } from './telemetry'
import { PolicyEngine } from './policy'
import { HookManager } from './hooks'
import type { Tool } from '../tools/types'
import { PluginManager } from './plugin'
import { sessionGrantKey } from './builtin-hooks'
import { ToolRegistry } from '../tools/registry'

const writeTool: Tool<{ path: string; content: string }> = {
  name: 'write_file', description: 'write', inputSchema: { type: 'object' }, readOnly: false, concurrencySafe: false, destructive: true, requiresConfirmation: true,
  availability: 'tauri-only', permissions: ['fs:write'], execute: async () => ({ success: true, content: 'ok' }), renderCall: (input) => `写入 ${input.path}`,
}

const context = {
  workspace: { root: '/workspace', name: 'workspace', resolve: (path: string) => `/workspace/${path}`, contains: (path: string) => !path.startsWith('/') },
  platform: 'tauri' as const,
  settings: { disabledTools: [] } as never,
  permissions: new Map(),
}

describe('M2 harness acceptance', () => {
  it('停止审批立即取消，晚到回答无效', async () => {
    let requestId = ''
    let responder!: (answer: 'allow' | 'deny') => void
    const controller = new AbortController()
    const service = new ApprovalService({ respond: (request) => { requestId = request.requestId; return new Promise((resolve) => { responder = resolve }) } })
    const pending = service.request({ runId: 'run', callId: 'call', toolName: 'write_file', reason: 'write', prompt: { title: 'write', detail: 'x', options: [{ label: 'allow', decision: 'allow' }, { label: 'deny', decision: 'deny' }] }, signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    expect((await pending).outcome).toBe('cancelled')
    expect(service.answer(requestId, 'allow')).toBe(false)
    responder?.('allow')
  })

  it('审批后硬 guard 仍拒绝越界路径', () => {
    const policy = new PolicyEngine()
    const result = policy.evaluate(writeTool, { id: 'c', name: 'write_file', input: { path: '/outside', content: 'x' } }, context)
    expect(result.kind).toBe('deny')
  })

  it('只读网络仍 ask，进程执行默认 deny', () => {
    const network = { ...writeTool, name: 'fetch_url', readOnly: true, destructive: false, requiresConfirmation: false, permissions: ['net:http' as const], availability: 'online-only' as const }
    const process = { ...writeTool, name: 'run_command', permissions: ['process:spawn' as const] }
    const policy = new PolicyEngine()
    expect(policy.evaluate(network, { id: 'n', name: network.name, input: {} }, { ...context, isOnline: true }).kind).toBe('ask')
    expect(policy.evaluate(process, { id: 'p', name: process.name, input: {} }, context).kind).toBe('deny')
    expect(sessionGrantKey(network, { id: 'a', name: network.name, input: { url: 'https://API.Example.com/a' } })).toBe('fetch_url:domain:api.example.com')
    expect(sessionGrantKey(network, { id: 'b', name: network.name, input: { url: 'https://other.example/b' } })).toBe('fetch_url:domain:other.example')
  })

  it('恢复未完成工具标记 outcome_unknown', () => {
    const ledger = new RunLedger('r', 'test-ledger')
    ledger.clear()
    ledger.append('tool.requested', { callId: 'c', name: 'write_file', input: { path: 'x' } })
    expect(recoverLedger(ledger.events())[0].outcomeUnknown).toBe(true)
  })

  it('脱敏器异常时扣留事件', () => {
    const event = { seq: 1, runId: 'r', ts: new Date().toISOString(), type: 'run.started' as const, payload: null }
    expect(sanitizeTelemetry([event], () => { throw new Error('bad rule') })).toEqual([])
  })

  it('非法审批回答 fail-closed', async () => {
    const service = new ApprovalService({ respond: vi.fn(async () => 'invalid' as never) })
    const result = await service.request({ runId: 'r', callId: 'c', toolName: 'write_file', reason: 'x', prompt: { title: 'x', detail: 'x', options: [] }, signal: new AbortController().signal })
    expect(result.outcome).toBe('unavailable')
  })

  it('预中止审批仍成对记录 asked/decided', async () => {
    const events: string[] = []
    const controller = new AbortController()
    controller.abort()
    const service = new ApprovalService({ onEvent: (event) => { events.push(`${event.type}:${event.outcome ?? ''}`) } })
    const result = await service.request({ runId: 'r', callId: 'c', toolName: 'write_file', reason: 'x', prompt: { title: 'x', detail: 'x', options: [] }, signal: controller.signal })
    expect(result.outcome).toBe('cancelled')
    expect(events).toEqual(['approval.asked:', 'approval.decided:cancelled'])
  })

  it('decided 审计失败时不提交运行级授权', async () => {
    const service = new ApprovalService({
      respond: async () => 'allow_always_in_run' as const,
      onEvent: (event) => { if (event.type === 'approval.decided') throw new Error('storage full') },
    })
    const result = await service.request({ runId: 'r', callId: 'c', toolName: 'write_file', reason: 'x', prompt: { title: 'x', detail: 'x', options: [] }, signal: new AbortController().signal })
    expect(result.outcome).toBe('unavailable')
    expect(service.hasSessionGrant('write_file')).toBe(false)
  })

  it('账本拒绝 AbortSignal 等运行时对象', () => {
    const ledger = new RunLedger('runtime-object', 'test-runtime-object')
    ledger.clear()
    expect(() => ledger.append('run.started', { signal: new AbortController().signal })).toThrow(/runtime objects/)
  })

  it('账本忽略对象可选 undefined 并保持 JSON 可回放', () => {
    const ledger = new RunLedger('optional', 'test-optional')
    ledger.clear()
    expect(() => ledger.append('tool.completed', { callId: 'c', success: true, error: undefined, metadata: undefined })).not.toThrow()
    expect(ledger.events()[0].payload).toEqual({ callId: 'c', success: true })
    expect(() => ledger.append('tool.completed', { values: [undefined] })).toThrow(/undefined/)
    const shared: unknown[] = ['same']
    expect(snapshotJson([shared, shared])).toEqual([['same'], ['same']])
    shared.push(shared)
    expect(() => snapshotJson(shared)).toThrow(/Circular/)
  })

  it('恢复时整批拒绝损坏或伪造的账本事件', () => {
    localStorage.setItem('test-corrupt-ledger', JSON.stringify([
      { seq: 7, runId: 'restored', ts: 'not-a-date', type: 'permission.granted', payload: { forged: true } },
    ]))
    expect(new RunLedger('restored', 'test-corrupt-ledger').events()).toEqual([])

    localStorage.setItem('solidify-ledger:forged', JSON.stringify([
      { seq: 1, runId: 'forged', ts: new Date().toISOString(), type: 'unknown.event', payload: null },
    ]))
    expect(loadRecentRunTelemetry()).toEqual([])
  })

  it('观察 hook 异常隔离且继续通知其他观察者', async () => {
    const hooks = new HookManager()
    const called: string[] = []
    hooks.register({ id: 'bad', type: 'on_error', mode: 'observe', priority: 1, handler: () => { throw new Error('bad') } })
    hooks.register({ id: 'good', type: 'on_error', mode: 'observe', priority: 2, handler: () => { called.push('good') } })
    await hooks.observe('on_error', { type: 'on_error' })
    expect(called).toEqual(['good'])
  })

  it('函数式 requiresConfirmation 生效且异常 fail-closed', () => {
    const policy = new PolicyEngine()
    const conditional = { ...writeTool, readOnly: true, destructive: false, requiresConfirmation: (input: { path: string }) => input.path.endsWith('.secret') }
    const toolContext = { ...context, runId: 'r', cwd: '/workspace', memory: {} as never, logger: {} as never }
    expect(policy.evaluate(conditional, { id: 'a', name: conditional.name, input: { path: 'plain.txt' } }, { ...context, toolContext }).kind).toBe('allow')
    expect(policy.evaluate(conditional, { id: 'b', name: conditional.name, input: { path: 'data.secret' } }, { ...context, toolContext }).kind).toBe('ask')
    const broken = { ...conditional, requiresConfirmation: () => { throw new Error('bad policy') } }
    expect(policy.evaluate(broken, { id: 'c', name: broken.name, input: { path: 'x' } }, { ...context, toolContext }).kind).toBe('deny')
  })

  it('项目和用户 ask 可以收紧默认或显式 allow', () => {
    const readTool = { ...writeTool, readOnly: true, destructive: false, requiresConfirmation: false }
    expect(new PolicyEngine({ project: { write_file: 'ask' } }).evaluate(readTool, { id: 'a', name: readTool.name, input: { path: 'x' } }, context).kind).toBe('ask')
    expect(new PolicyEngine({ project: { write_file: 'allow' }, user: { write_file: 'ask' } }).evaluate(readTool, { id: 'b', name: readTool.name, input: { path: 'x' } }, context).kind).toBe('ask')
  })

  it('插件 onLoad 失败时回滚已注册 hook 和工具', async () => {
    const hooks = new HookManager()
    const registry = new ToolRegistry()
    const plugins = new PluginManager(hooks, (tool) => registry.register(tool))
    await expect(plugins.load({ id: 'broken', version: '1', tools: [writeTool], hooks: [{ id: 'plugin-hook', type: 'on_error', mode: 'observe', priority: 0, handler: () => undefined }], onLoad: () => { throw new Error('load failed') } })).rejects.toThrow('load failed')
    expect(registry.get('write_file')).toBeUndefined()
    expect(plugins.list()).toEqual([])
  })

  it('插件工具注册器必须在运行时返回 disposer', async () => {
    const plugins = new PluginManager(new HookManager(), (() => undefined) as never)
    await expect(plugins.load({ id: 'bad-registry', version: '1', tools: [writeTool] })).rejects.toThrow(/disposer/)
    expect(plugins.list()).toEqual([])
  })

  it('失败运行遥测保留终态前已消耗的 token', () => {
    const ts = new Date().toISOString()
    const telemetry = deriveRunTelemetry([
      { seq: 1, runId: 'failed', ts, type: 'run.started', payload: null },
      { seq: 2, runId: 'failed', ts, type: 'run.failed', payload: { kind: 'internal', usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } } },
    ])
    expect(telemetry).toMatchObject({ inputTokens: 12, outputTokens: 3, totalTokens: 15, failed: true })
  })

  it('遥测脱敏器不能修改权威账本 payload', () => {
    const ledger = new RunLedger('redact', 'test-redact')
    ledger.clear()
    ledger.append('run.started', { secret: 'original' })
    const authoritative = ledger.events()
    const sanitized = sanitizeTelemetry(authoritative, (event) => {
      const payload = event.payload as { secret: string }
      expect(() => { payload.secret = 'leaked' }).toThrow()
      return { ...event, payload: { secret: 'redacted' } }
    })
    expect((authoritative[0].payload as { secret: string }).secret).toBe('original')
    expect((sanitized[0].payload as { secret: string }).secret).toBe('redacted')
  })
})
