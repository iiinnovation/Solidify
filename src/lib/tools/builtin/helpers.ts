import type { ToolResult } from '../types'

export function success<T>(content: string, data?: T): ToolResult<T> {
  return { success: true, content, data }
}

export function failure(kind: 'not_found' | 'permission_denied' | 'runtime' | 'invalid_input', message: string, recoverable = true): ToolResult {
  return { success: false, content: message, error: { kind, message, recoverable } }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
