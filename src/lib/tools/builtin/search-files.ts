import type { Tool } from '../types'
import { searchWorkspaceFiles, searchWorkspaceIndex } from '@/lib/tauri'
import { isEnabled } from '@/lib/harness/flags'
import { failure, success, errorMessage, validateWorkspacePath } from './helpers'

interface SearchFilesInput { query: string; path?: string; max_results?: number }

export const searchFilesTool: Tool<SearchFilesInput> = {
  name: 'search_files',
  description: '在工作区内按文件名和文本内容检索，返回匹配路径、行号和文本。',
  inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, path: { type: 'string' }, max_results: { type: 'number', minimum: 1, maximum: 500 } }, required: ['query'] },
  readOnly: true, concurrencySafe: true, destructive: false, requiresConfirmation: false,
  availability: 'tauri-only', permissions: ['fs:read'], timeoutMs: 60_000,
  async execute(input, ctx, signal) {
    if (signal.aborted) return failure('runtime', '文件检索已中断', true)
    const pathError = validateWorkspacePath(input.path ?? '.', ctx)
    if (pathError) return pathError
    try {
      const matches = isEnabled('localWorkspace')
        ? await searchWorkspaceIndex(ctx.cwd, input.query, input.max_results)
        : await searchWorkspaceFiles(input.query, input.path ?? '.', ctx.cwd, input.max_results)
      return success(JSON.stringify(matches), matches)
    }
    catch (error) { return failure('runtime', `无法检索文件：${errorMessage(error)}`) }
  },
  renderCall: (input) => `检索 ${input.query}`,
}
