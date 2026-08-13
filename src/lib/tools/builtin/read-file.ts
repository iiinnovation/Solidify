import type { Tool } from '../types'
import { readWorkspaceFile } from '@/lib/tauri'
import { failure, success, errorMessage } from './helpers'

interface ReadFileInput { path: string; offset?: number; limit?: number }

export const readFileTool: Tool<ReadFileInput> = {
  name: 'read_file',
  description: '读取工作区内文本文件，可用 offset 和 limit 读取片段；二进制文件只返回元信息。',
  inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, offset: { type: 'number', minimum: 0 }, limit: { type: 'number', minimum: 1 } }, required: ['path'] },
  readOnly: true, concurrencySafe: true, destructive: false, requiresConfirmation: false,
  availability: 'tauri-only', permissions: ['fs:read'], timeoutMs: 30_000,
  async execute(input, ctx, signal) {
    if (signal.aborted) return failure('runtime', '文件读取已中断', true)
    try {
      const result = await readWorkspaceFile(input.path, ctx.cwd, input.offset, input.limit)
      if (result.binary) return success(`文件为二进制，大小 ${result.bytes} 字节`, result)
      return { ...success(result.content ?? '', result), truncated: result.truncated, metadata: { durationMs: 0, bytesRead: result.bytes } }
    } catch (error) { return failure('not_found', `无法读取文件 ${input.path}：${errorMessage(error)}`) }
  },
  renderCall: (input) => `读取文件 ${input.path}`,
}
