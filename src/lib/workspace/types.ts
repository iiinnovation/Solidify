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
  schemaVersion: number
  id: string
  name: string
  createdAt: string
  stage: string
}

export interface WorkspaceInfo {
  root: string
  project: WorkspaceMetadata
}

export interface WorkspaceEntry {
  path: string
  name: string
  kind: 'file' | 'directory'
  size: number
  modifiedAt: number
}

export interface WorkspaceSearchResult {
  path: string
  text: string
  score: number
}
