import type { ToolResult, ToolUseContext } from '../types'

export function success<T>(content: string, data?: T): ToolResult<T> {
  return { success: true, content, data }
}

export function failure<T = unknown>(kind: 'not_found' | 'permission_denied' | 'runtime' | 'invalid_input' | 'loop_detected', message: string, recoverable = true): ToolResult<T> {
  return { success: false, content: message, error: { kind, message, recoverable } }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Renderer-side early rejection; Rust canonicalization remains authoritative. */
export function validateWorkspacePath(path: string, ctx: ToolUseContext): ToolResult | null {
  try {
    ctx.workspace.resolve(path)
    return null
  } catch (error) {
    return failure(
      'permission_denied',
      `路径必须是工作区内的相对路径：${path}（${errorMessage(error)}）`,
      false,
    )
  }
}
