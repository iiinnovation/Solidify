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
import { appendTextFile, readTextFile, removePath } from '../tauri'

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
      !Array.isArray(parsed.messages) ||
      typeof parsed.ts !== 'string'
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
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

  private path(conversationId: string): string {
    return `${this.workspaceRoot}/.solidify/conversations/${sanitizeId(conversationId)}.jsonl`
  }

  async append(conversationId: string, snapshot: TurnSnapshot): Promise<void> {
    const ok = await appendTextFile(
      this.path(conversationId),
      serializeSnapshot(snapshot) + '\n',
    )
    if (!ok) {
      throw new Error(`Failed to append snapshot for ${conversationId}`)
    }
  }

  async loadLatest(conversationId: string): Promise<TurnSnapshot | null> {
    const content = await readTextFile(this.path(conversationId))
    return content ? readLatestSnapshot(content) : null
  }

  async clear(conversationId: string): Promise<void> {
    await removePath(this.path(conversationId))
  }
}

// ============================================================================
// Web: localStorage fallback
// ============================================================================

const STORAGE_KEY_PREFIX = 'solidify:snapshots:'

/** Cap per conversation so localStorage quota isn't exhausted */
const MAX_SNAPSHOTS_PER_CONVERSATION = 20

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
    localStorage.setItem(key, trimmed.join('\n') + '\n')
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
