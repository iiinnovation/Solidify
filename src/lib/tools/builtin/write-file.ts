import type { Tool } from '../types'
import { materializeWorkspaceDocument, writeWorkspaceFile } from '@/lib/tauri'
import { failure, success, errorMessage, validateWorkspacePath } from './helpers'

interface WriteFileInput { path: string; content: string }

export const writeFileTool: Tool<WriteFileInput> = {
  name: 'write_file',
  description: '将文本写入工作区内文件，必要时创建父目录；已有文件会被覆盖。',
  inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' } }, required: ['path', 'content'] },
  readOnly: false, concurrencySafe: false, destructive: true, requiresConfirmation: true,
  availability: 'tauri-only', permissions: ['fs:write'], timeoutMs: 30_000,
  async execute(input, ctx, signal) {
    if (signal.aborted) return failure('runtime', '文件写入已中断', true)
    const pathError = validateWorkspacePath(input.path, ctx)
    if (pathError) return pathError
    try {
      if (input.path.replace(/\\/g, '/').startsWith('03-交付物/')) {
        const result = await materializeWorkspaceDocument({
          path: input.path,
          content: input.content,
          workspaceRoot: ctx.cwd,
          runId: ctx.runId,
          messageId: `tool-${ctx.runId}`,
        })
        const bytes = new TextEncoder().encode(input.content).byteLength
        return { ...success(`已写入 ${input.path}（${bytes} 字节）`, { path: input.path, bytes, version: result.currentVersion }), metadata: { durationMs: 0, bytesWritten: bytes } }
      }
      const bytes = await writeWorkspaceFile(input.path, input.content, ctx.cwd)
      return { ...success(`已写入 ${input.path}（${bytes} 字节）`, { path: input.path, bytes }), metadata: { durationMs: 0, bytesWritten: bytes } }
    } catch (error) { return failure(writeErrorKind(error), `无法写入文件 ${input.path}：${errorMessage(error)}`, true) }
  },
  // Byte count, not `content.length`: the latter counts UTF-16 code units and
  // under-reports Chinese content 3x in the approval dialog the user decides on.
  renderCall: (input) => `写入 ${input.path}（${new TextEncoder().encode(input.content).byteLength} 字节，将覆盖已有文件）`,
}

/**
 * A write can fail for reasons the model can work around (path protected, disk
 * full, transient IO). Reporting everything as an unrecoverable permission
 * error tells the model the operation can never succeed.
 */
function writeErrorKind(error: unknown): 'permission_denied' | 'runtime' {
  const message = errorMessage(error).toLowerCase()
  if (message.includes('protected') || message.includes('escapes the workspace')
    || message.includes('permission') || message.includes('denied')) {
    return 'permission_denied'
  }
  return 'runtime'
}
