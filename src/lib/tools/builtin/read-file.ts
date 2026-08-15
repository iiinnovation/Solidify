import type { Tool } from '../types'
import { readWorkspaceBytes, readWorkspaceFile } from '@/lib/tauri'
import { failure, success, errorMessage, validateWorkspacePath } from './helpers'

interface ReadFileInput { path: string; offset?: number; limit?: number }

export const readFileTool: Tool<ReadFileInput> = {
  name: 'read_file',
  description: '读取工作区内文本、PDF、Word 文件或当前 Skill 的虚拟资源，可用 offset 和 limit 读取片段。',
  inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1 } }, required: ['path'] },
  readOnly: true, concurrencySafe: true, destructive: false, requiresConfirmation: false,
  availability: 'tauri-or-skill-resource', permissions: ['fs:read'], timeoutMs: 30_000,
  async execute(input, ctx, signal) {
    if (signal.aborted) return failure('runtime', '文件读取已中断', true)
    if (ctx.skillResources?.canRead(input.path)) {
      try {
        const result = await ctx.skillResources.read(input.path, input.offset, input.limit)
        return {
          ...success(result.content, { path: input.path, bytes: result.bytes, binary: false, truncated: result.truncated }),
          truncated: result.truncated,
          metadata: { durationMs: 0, bytesRead: result.bytes },
        }
      } catch (error) {
        const message = errorMessage(error)
        return failure(skillReadErrorKind(message), `无法读取 Skill 资源 ${input.path}：${message}`, true)
      }
    }
    if (isSkillVirtualPath(input.path)) {
      return failure('permission_denied', '只能读取当前已选 Skill 的资源。', false)
    }
    const pathError = validateWorkspacePath(input.path, ctx)
    if (pathError) return pathError
    try {
      const result = await readWorkspaceFile(input.path, ctx.cwd, input.offset, input.limit)
      if (result.binary) {
        const extension = input.path.split('.').pop()?.toLowerCase()
        if (extension !== 'pdf' && extension !== 'docx') return success(`文件为二进制，大小 ${result.bytes} 字节`, result)
        const { extractText } = await import('@/lib/file-extractor')
        const bytes = new Uint8Array(await readWorkspaceBytes(input.path, ctx.cwd))
        const mime = extension === 'pdf'
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        const extracted = await extractText(new File([bytes], input.path.split('/').pop() ?? input.path, { type: mime }))
        const offset = input.offset ?? 0
        const content = input.limit === undefined
          ? Array.from(extracted).slice(offset).join('')
          : Array.from(extracted).slice(offset, offset + input.limit).join('')
        const truncated = offset + Array.from(content).length < Array.from(extracted).length
        return { ...success(content, { ...result, content, binary: false, truncated }), truncated, metadata: { durationMs: 0, bytesRead: result.bytes } }
      }
      return { ...success(result.content ?? '', result), truncated: result.truncated, metadata: { durationMs: 0, bytesRead: result.bytes } }
    } catch (error) { return failure(readErrorKind(error), `无法读取文件 ${input.path}：${errorMessage(error)}`, true) }
  },
  renderCall: (input) => `读取文件 ${input.path}`,
}

function isSkillVirtualPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return normalized === '.solidify/skills' || normalized.startsWith('.solidify/skills/')
}

function skillReadErrorKind(message: string): 'not_found' | 'invalid_input' | 'runtime' {
  if (message.includes('不存在')) return 'not_found'
  if (message.includes('必须指向具体文件')) return 'invalid_input'
  return 'runtime'
}

/**
 * Mapping every failure to `not_found` is unactionable: a permission error, a
 * failed rich-text extraction and a rejected argument all told the model the
 * file does not exist, so it retried the same call instead of changing strategy.
 */
function readErrorKind(error: unknown): 'not_found' | 'permission_denied' | 'invalid_input' | 'runtime' {
  const message = errorMessage(error).toLowerCase()
  if (message.includes('does not exist') || message.includes('not found') || message.includes('no such file')) {
    return 'not_found'
  }
  if (message.includes('escapes the workspace') || message.includes('permission') || message.includes('denied')) {
    return 'permission_denied'
  }
  if (message.includes('invalid type') || message.includes('expected')) return 'invalid_input'
  return 'runtime'
}
