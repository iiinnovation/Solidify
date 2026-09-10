/**
 * Session snapshot & restore (M1-13)
 * One jsonl line per completed turn; restore reads the last valid line.
 *
 * v1 scope per ADR-0002: survives page refresh / app restart.
 * Does NOT keep running in the background after the window closes.
 *
 * @module lib/engine/snapshot
 * @see docs/specs/agent-loop.md §4 (恢复)
 */

import type { TurnSnapshot, SnapshotStore } from './types'
import {
  appendWorkspaceSnapshot,
  clearWorkspaceSnapshot,
  readWorkspaceSnapshot,
} from '../tauri'
import { setStorageItemWithQuotaRecovery } from '../storage-quota'

// ============================================================================
// Serialization (pure, testable)
// ============================================================================

/** Serialize a snapshot to one jsonl line (no trailing newline) */
export function serializeSnapshot(snapshot: TurnSnapshot): string {
  return JSON.stringify(snapshot)
}

/** Parse one jsonl line; null on corrupt/incomplete lines (torn writes) */
export function parseSnapshotLine(line: string): TurnSnapshot | null {
  try {
    const parsed = JSON.parse(line) as TurnSnapshot
    if (
      typeof parsed.turn !== 'number' ||
      typeof parsed.runId !== 'string' ||
      !Array.isArray(parsed.messages) ||
      typeof parsed.ts !== 'string'
    ) {
      return null
    }
    if (parsed.version !== undefined && parsed.version !== 2) return null
    if (parsed.version === 2 && (!isRunPlan(parsed.runPlan) || !isPhaseState(parsed.phaseState))) return null
    if (parsed.folderTaskState !== undefined && !isFolderTaskState(parsed.folderTaskState)) return null
    return parsed
  } catch {
    return null
  }
}

function isFolderTaskState(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Record<string, unknown>
  return typeof state.batchOpen === 'boolean'
    && typeof state.decisionPauseAllowed === 'boolean'
    && Number.isInteger(state.checkpointReminders)
    && Number(state.checkpointReminders) >= 0
    && (state.stage === undefined || FOLDER_TASK_STAGES.has(String(state.stage)))
}

const FOLDER_TASK_STAGES = new Set(['context', 'plan', 'claim', 'batch', 'decision', 'review', 'terminal'])
const RUN_MODES = new Set(['direct', 'agent', 'staged-delivery'])
const RUN_PHASES = new Set(['preparing', 'retrieving', 'generating', 'validating', 'repairing', 'completed', 'failed', 'exhausted'])

function isRunPlan(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const plan = value as Record<string, unknown>
  return RUN_MODES.has(String(plan.mode))
    && RUN_PHASES.has(String(plan.initialPhase))
    && ['none', 'inline', 'retrieval'].includes(String(plan.attachmentMode))
    && typeof plan.maxRepairAttempts === 'number'
    && typeof plan.reason === 'string'
    && (plan.contractId === undefined || typeof plan.contractId === 'string')
}

function isPhaseState(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Record<string, unknown>
  return RUN_PHASES.has(String(state.phase))
    && typeof state.turn === 'number'
    && typeof state.repairAttempts === 'number'
    && typeof state.evidenceComplete === 'boolean'
    && Array.isArray(state.closedGroups)
    && state.closedGroups.every((group) => typeof group === 'string')
}

/**
 * Read the latest valid snapshot from jsonl content.
 * Walks backwards so a torn trailing line (crash mid-write) is skipped
 * instead of losing the whole history — tombstone principle.
 */
export function readLatestSnapshot(content: string): TurnSnapshot | null {
  const lines = content.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    const snapshot = parseSnapshotLine(line)
    if (snapshot) return snapshot
  }
  return null
}

/** Conversation ids become filenames/keys; strip anything path-unsafe */
function sanitizeId(conversationId: string): string {
  return conversationId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

// ============================================================================
// Tauri: append to .solidify/conversations/<id>.jsonl
// ============================================================================

export class FileSnapshotStore implements SnapshotStore {
  private readonly workspaceRoot: string

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot
  }

  async append(conversationId: string, snapshot: TurnSnapshot): Promise<void> {
    await appendWorkspaceSnapshot(
      sanitizeId(conversationId),
      serializeSnapshot(snapshot) + '\n',
      this.workspaceRoot,
    )
  }

  async loadLatest(conversationId: string): Promise<TurnSnapshot | null> {
    const content = await readWorkspaceSnapshot(
      sanitizeId(conversationId),
      this.workspaceRoot,
    )
    return content ? readLatestSnapshot(content) : null
  }

  async clear(conversationId: string): Promise<void> {
    await clearWorkspaceSnapshot(sanitizeId(conversationId), this.workspaceRoot)
  }
}

// ============================================================================
// Web: localStorage fallback
// ============================================================================

const STORAGE_KEY_PREFIX = 'solidify:snapshots:'

// localStorage writes are atomic, and restore only consumes the tail. Keeping
// every cumulative turn duplicates large attachment/tool context many times.
const MAX_SNAPSHOTS_PER_CONVERSATION = 1

export class LocalStorageSnapshotStore implements SnapshotStore {
  private key(conversationId: string): string {
    return STORAGE_KEY_PREFIX + sanitizeId(conversationId)
  }

  async append(conversationId: string, snapshot: TurnSnapshot): Promise<void> {
    const key = this.key(conversationId)
    const existing = localStorage.getItem(key) ?? ''
    const lines = existing.split('\n').filter(Boolean)
    lines.push(serializeSnapshot(snapshot))
    // Restore only needs the tail; trim to respect quota
    const trimmed = lines.slice(-MAX_SNAPSHOTS_PER_CONVERSATION)
    setStorageItemWithQuotaRecovery(localStorage, key, trimmed.join('\n') + '\n')
  }

  async loadLatest(conversationId: string): Promise<TurnSnapshot | null> {
    const content = localStorage.getItem(this.key(conversationId))
    return content ? readLatestSnapshot(content) : null
  }

  async clear(conversationId: string): Promise<void> {
    localStorage.removeItem(this.key(conversationId))
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create the right store for the current platform.
 * Tauri without a workspace root falls back to localStorage.
 */
export function createSnapshotStore(options: {
  platform: 'web' | 'tauri'
  workspaceRoot?: string
}): SnapshotStore {
  if (options.platform === 'tauri' && options.workspaceRoot) {
    return new FileSnapshotStore(options.workspaceRoot)
  }
  return new LocalStorageSnapshotStore()
}
