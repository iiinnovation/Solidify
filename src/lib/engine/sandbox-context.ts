import type { QueryContext } from './types'
import { folderTaskClient } from '../folder-tasks/client'
import { extractDocumentTextTool } from '../tools/builtin/folder-tasks'

/** Refresh at the public run boundary, including restored runs. Fail closed. */
export async function prepareSandboxContext(ctx: QueryContext): Promise<QueryContext> {
  let capabilities: NonNullable<QueryContext['sandboxCapabilities']> = []
  if (ctx.platform === 'tauri' && ctx.folderTaskId && !ctx.signal.aborted
    && ctx.tools.some((tool) => Object.is(tool, extractDocumentTextTool))) {
    try { capabilities = await folderTaskClient.sandboxCapabilities() } catch { /* unavailable */ }
  }
  if (ctx.signal.aborted) capabilities = []
  return {
    ...ctx,
    sandboxCapabilities: capabilities,
    tools: ctx.tools.filter((tool) => tool.name !== extractDocumentTextTool.name
      || (tool === extractDocumentTextTool && capabilities.some((item) => item.available))),
  }
}
