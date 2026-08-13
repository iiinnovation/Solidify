/**
 * Tools module exports
 */

export type {
  Tool,
  ToolAvailability,
  PermissionScope,
  ToolProgress,
  ToolUseContext,
  ToolError,
  ToolErrorKind,
  ToolResult,
  ToolResultMetadata,
  ToolCall,
  ResolveContext,
  ToolRegistry as IToolRegistry,
} from './types'

export { ToolRegistry, toolRegistry } from './registry'
