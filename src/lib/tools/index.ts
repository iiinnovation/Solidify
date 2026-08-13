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

export { listDirTool } from './builtin/list-dir'
export { readFileTool } from './builtin/read-file'
export { writeFileTool } from './builtin/write-file'
export { searchFilesTool } from './builtin/search-files'
export { capturePreviewTool } from './builtin/capture-preview'

export {
  validateInput,
  prepareCall,
  executeCall,
  canRunInParallel,
  type ValidationResult,
  type PreparedCall,
  type ExecuteCallOptions,
} from './executor'
