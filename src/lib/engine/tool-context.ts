/**
 * ToolUseContext synthesis for the query loop (M1-14)
 * Uses harness-provided environment when present on QueryContext and
 * conservative fallbacks for non-chat callers.
 *
 * @module lib/engine/tool-context
 * @see docs/specs/tool-interface.md §2
 */

import type { QueryContext } from './types'
import type { ToolUseContext } from '../tools/types'
import type { WorkspaceHandle } from '../workspace/types'
import type { Settings, RunLogger } from '../harness/types'
import { getDefaultFlags } from '../harness/flags'

/** Build the immutable per-turn tool execution context */
export function buildToolUseContext(
  ctx: QueryContext,
  logger: RunLogger,
): ToolUseContext {
  return {
    runId: ctx.runId,
    cwd: ctx.cwd,
    workspace: ctx.workspace ?? createFallbackWorkspace(ctx.cwd),
    memory: ctx.memory,
    settings: ctx.settings ?? createFallbackSettings(ctx),
    permissions: ctx.permissions ?? new Map(),
    // 'web' is the safe default: blocks tauri-only tools when unknown
    platform: ctx.platform ?? 'web',
    logger,
    skillResources: ctx.skillResources,
    skillRegistry: ctx.skillRegistry,
    attachments: ctx.attachments,
    messages: ctx.messages,
  }
}

/**
 * Resolve '.' / '..' segments without Node's path module (runs in browser)
 */
function normalizePath(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

/**
 * Minimal workspace handle rooted at cwd.
 * TS-side containment is an early-failure optimization only —
 * the real security boundary is Rust-side (M1-22, tool-interface.md §8).
 */
function createFallbackWorkspace(cwd: string): WorkspaceHandle {
  const root = normalizePath(cwd)
  const name = root.split('/').filter(Boolean).pop() ?? root

  const resolve = (path: string): string => {
    if (/^(?:[A-Za-z]:)?[\\/]/.test(path)) {
      throw new Error(`Path must be relative: ${path}`)
    }
    const joined = `${root}/${path}`
    const normalized = normalizePath(joined)
    if (normalized !== root && !normalized.startsWith(root + '/')) {
      throw new Error(`Path escapes workspace: ${path}`)
    }
    return normalized
  }

  return {
    root,
    name,
    resolve,
    contains(path: string): boolean {
      try {
        resolve(path)
        return true
      } catch {
        return false
      }
    },
  }
}

/** Conservative settings fallback for non-chat callers. */
function createFallbackSettings(ctx: QueryContext): Settings {
  return {
    model: {
      provider: ctx.model.provider === 'openai' ? 'openai' : 'anthropic',
      model: ctx.model.model,
      temperature: ctx.model.temperature ?? 0.7,
      maxTokens: ctx.limits.maxOutputTokens,
    },
    ui: { theme: 'auto', fontSize: 14, codeTheme: 'default', compactMode: false },
    privacy: {
      allowTelemetry: false,
      allowCrashReports: false,
      shareUsageData: false,
    },
    features: getDefaultFlags(),
    disabledTools: [],
    workspaceRoot: ctx.cwd,
  }
}
