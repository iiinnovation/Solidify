import type { Tool } from '../types'
import { writeWorkspaceFile } from '@/lib/tauri'
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
      const bytes = await writeWorkspaceFile(input.path, input.content, ctx.cwd)
      return { ...success(`已写入 ${input.path}（${bytes} 字节）`, { path: input.path, bytes }), metadata: { durationMs: 0, bytesWritten: bytes } }
    } catch (error) { return failure('permission_denied', `无法写入文件 ${input.path}：${errorMessage(error)}`, false) }
  },
  renderCall: (input) => `写入 ${input.path}（${input.content.length} 字节，将覆盖已有文件）`,
}
