/**
 * Workspace types
 * @see docs/specs/workspace-format.md
 */

export interface WorkspaceHandle {
  root: string
  name: string

  /** Resolve path relative to workspace root, with sandbox validation */
  resolve(path: string): string

  /** Check if path is within workspace boundaries */
  contains(path: string): boolean
}

export interface WorkspaceMetadata {
  name: string
  root: string
  createdAt: string
  lastAccessedAt: string
}
