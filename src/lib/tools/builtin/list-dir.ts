import type { Tool } from '../types'
import { listWorkspaceDir } from '@/lib/tauri'
import { failure, success, errorMessage, validateWorkspacePath } from './helpers'

interface ListDirInput { path: string; depth?: number }

export const listDirTool: Tool<ListDirInput> = {
  name: 'list_dir',
  description: '列出工作区内目录的文件和子目录。需要了解当前目录结构时使用。',
  inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, depth: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['path'] },
  readOnly: true, concurrencySafe: true, destructive: false, requiresConfirmation: false,
  availability: 'tauri-only', permissions: ['fs:read'], timeoutMs: 30_000,
  async execute(input, ctx, signal) {
    if (signal.aborted) return failure('runtime', '目录读取已中断', true)
    const pathError = validateWorkspacePath(input.path, ctx)
    if (pathError) return pathError
    try {
      const entries = await listWorkspaceDir(input.path, ctx.cwd, input.depth)
      return success(JSON.stringify(entries), entries)
    } catch (error) { return failure('runtime', `无法列出目录：${errorMessage(error)}`) }
  },
  renderCall: (input) => `列出目录 ${input.path}`,
}
