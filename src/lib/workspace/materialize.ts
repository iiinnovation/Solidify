import { ApprovalService } from '@/lib/harness/approval'
import { approvalResponder } from '@/lib/harness/approval-channel'
import { getFlags } from '@/lib/harness/flags'
import { createDefaultPolicyEngine } from '@/lib/harness/policy'
import { materializeWorkspaceDocument, rollbackWorkspaceDocument } from '@/lib/tauri'
import type { Tool } from '@/lib/tools/types'
import type { ArtifactType } from '@/stores/chat-store'
import { useDocumentStore } from '@/stores/document-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

export interface ParsedArtifact {
  title: string
  type: ArtifactType
  path: string
  content: string
}

const TYPE_EXTENSION: Record<Exclude<ArtifactType, 'code'>, string> = {
  document: 'md',
  mermaid: 'mmd',
  chart: 'json',
  drawio: 'drawio',
  slides: 'md',
}

const CODE_EXTENSIONS: Record<string, string> = {
  javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', tsx: 'tsx', jsx: 'jsx',
  python: 'py', py: 'py', rust: 'rs', rs: 'rs', go: 'go', java: 'java',
  html: 'html', css: 'css', json: 'json', yaml: 'yaml', yml: 'yml', shell: 'sh', bash: 'sh',
}

export function normalizeArtifactType(raw: string): ArtifactType {
  const type = raw.toLowerCase().trim()
  if (['document', 'slides', 'code', 'mermaid', 'chart', 'drawio'].includes(type)) return type as ArtifactType
  if (['diagram', 'flowchart', 'flow', 'sequence', 'graph'].includes(type)) return 'mermaid'
  if (['bar', 'line', 'pie'].includes(type)) return 'chart'
  return 'document'
}

export function deriveArtifactPath(title: string, type: ArtifactType, content = ''): string {
  const safeTitle = title.trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80) || '未命名交付物'
  let extension = type === 'code' ? codeExtension(content) : TYPE_EXTENSION[type]
  if (!extension) extension = 'txt'
  return `03-交付物/${safeTitle}.${extension}`
}

export function normalizeArtifactPath(path: string | undefined, title: string, type: ArtifactType, content = ''): string {
  const normalized = path?.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    return deriveArtifactPath(title, type, content)
  }
  return normalized
}

function codeExtension(content: string): string {
  const language = content.trim().match(/^```([\w+-]+)/)?.[1]?.toLowerCase()
  return (language && CODE_EXTENSIONS[language]) || 'txt'
}

export async function materializeArtifact(
  artifact: ParsedArtifact,
  options: { workspaceRoot: string; runId: string; messageId: string; expectedModifiedAt?: number },
): Promise<void> {
  const entries = useWorkspaceStore.getState().entries
  const existing = entries.find((entry) => entry.kind === 'file' && entry.path === artifact.path)
  await authorizeDocumentWrite(artifact.path, artifact.content, Boolean(existing), options.runId)
  const write = async (force: boolean) => materializeWorkspaceDocument({
    path: artifact.path,
    content: artifact.content,
    workspaceRoot: options.workspaceRoot,
    runId: options.runId,
    messageId: options.messageId,
    expectedModifiedAt: options.expectedModifiedAt ?? existing?.modifiedAt ?? 0,
    force,
  })
  let result
  try {
    result = await write(false)
  } catch (error) {
    if (!String(error).includes('DOCUMENT_CONFLICT:')) throw error
    await authorizeConflict(artifact.path, options.runId)
    result = await write(true)
  }
  useDocumentStore.getState().upsertDocument({
    ...artifact,
    messageId: options.messageId,
    streaming: false,
    version: result.currentVersion,
    modifiedAt: result.modifiedAt,
  })
  useWorkspaceStore.getState().selectPath(artifact.path)
  await useWorkspaceStore.getState().refreshTree()
}

export async function rollbackArtifact(path: string, version: number, messageId: string): Promise<void> {
  const workspace = useWorkspaceStore.getState()
  if (!workspace.workspaceRoot) throw new Error('没有打开的本地工作区')
  const existing = workspace.entries.find((entry) => entry.kind === 'file' && entry.path === path)
  const runId = `rollback-${Date.now()}`
  await authorizeDocumentWrite(path, `回滚到 v${version}`, true, runId)
  const execute = (force: boolean) => rollbackWorkspaceDocument({
    path,
    version,
    workspaceRoot: workspace.workspaceRoot!,
    runId,
    messageId,
    expectedModifiedAt: existing?.modifiedAt ?? 0,
    force,
  })
  let result
  try {
    result = await execute(false)
  } catch (error) {
    if (!String(error).includes('DOCUMENT_CONFLICT:')) throw error
    await authorizeConflict(path, runId)
    result = await execute(true)
  }
  await workspace.refreshTree()
  const { readWorkspaceFile } = await import('@/lib/tauri')
  const read = await readWorkspaceFile(path, workspace.workspaceRoot)
  useDocumentStore.getState().patchDocument(path, {
    content: read.content ?? '', version: result.currentVersion, modifiedAt: result.modifiedAt,
  })
}

async function authorizeDocumentWrite(path: string, content: string, exists: boolean, runId: string): Promise<void> {
  const tool: Tool<{ path: string; content: string; creating: boolean; intent: string }> = {
    name: 'materialize_document', description: '', inputSchema: { type: 'object' }, readOnly: false,
    concurrencySafe: false, destructive: exists, requiresConfirmation: exists,
    availability: 'tauri-only', permissions: ['fs:write'],
    execute: async () => ({ success: true, content: '', metadata: { durationMs: 0 } }),
    renderCall: (input) => `${exists ? '覆盖' : '新建'} ${input.path}（${new TextEncoder().encode(input.content).byteLength} 字节）`,
  }
  const input = { path, content, creating: !exists, intent: 'artifact_materialize' }
  const decision = createDefaultPolicyEngine().evaluate(tool, { id: runId, name: tool.name, input }, policyContext())
  if (decision.kind === 'deny') throw new Error(decision.reason)
  if (decision.kind === 'allow') return
  const controller = new AbortController()
  const result = await new ApprovalService({ respond: approvalResponder }).request({
    runId, callId: runId, toolName: tool.name, reason: decision.reason, prompt: decision.prompt,
    signal: controller.signal,
  })
  if (result.outcome !== 'allowed_once') throw new Error('用户取消了文档写入')
}

async function authorizeConflict(path: string, runId: string): Promise<void> {
  const controller = new AbortController()
  const result = await new ApprovalService({ respond: approvalResponder }).request({
    runId, callId: `${runId}:conflict`, toolName: 'materialize_document',
    reason: '该文件在 AI 开始生成后被外部程序修改。继续会先保存外部版本，再写入 AI 内容。',
    prompt: {
      title: '文件已在外部修改', detail: `确认覆盖 ${path}？`,
      options: [{ label: '允许', decision: 'allow' }, { label: '拒绝', decision: 'deny' }],
    },
    signal: controller.signal,
  })
  if (result.outcome !== 'allowed_once') throw new Error('检测到外部修改，已取消覆盖')
}

function policyContext() {
  const workspaceRoot = useWorkspaceStore.getState().workspaceRoot ?? '/'
  return {
    workspace: {
      root: workspaceRoot,
      name: workspaceRoot.split('/').pop() ?? workspaceRoot,
      resolve: (path: string) => `${workspaceRoot}/${path}`,
      contains: (path: string) => !path.startsWith('/') && !path.replace(/\\/g, '/').split('/').includes('..'),
    },
    platform: 'tauri' as const,
    settings: {
      model: { provider: 'anthropic' as const, model: '', temperature: 0, maxTokens: 0 },
      ui: { theme: 'auto' as const, fontSize: 14, codeTheme: '', compactMode: false },
      privacy: { allowTelemetry: false, allowCrashReports: false, shareUsageData: false },
      features: getFlags(), disabledTools: [], workspaceRoot,
    },
    permissions: new Map(),
  }
}
