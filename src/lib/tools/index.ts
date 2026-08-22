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
export { readHandleTool } from './builtin/read-handle'
export { searchAttachmentsTool, readAttachmentTool, prepareAttachmentEvidenceTool, type PrepareAttachmentEvidenceInput } from './builtin/attachments'
export { activateSkillTool, type ActivateSkillResult } from './builtin/activate-skill'
export { createDispatchAgentTool, type DispatchAgentInput, type DispatchAgentOutput } from './builtin/dispatch-agent'
export { createGeneratePptdTool, type GeneratePptdInput, type GeneratePptdOutput } from './builtin/generate-pptd'

export {
  validateInput,
  prepareCall,
  executeCall,
  canRunInParallel,
  type ValidationResult,
  type PreparedCall,
  type ExecuteCallOptions,
} from './executor'
