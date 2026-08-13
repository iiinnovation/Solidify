/**
 * Memory state types
 * @see docs/reference/memory_state_management.md
 */

export interface MemoryState {
  /** Store large result and return handle */
  store(data: string): Promise<string>

  /** Retrieve data by handle */
  retrieve(handle: string): Promise<string | null>

  /** Search memory fragments by query */
  search(query: string, limit?: number): Promise<MemoryFragment[]>

  /** Clear all stored handles */
  clear(): Promise<void>
}

export interface MemoryFragment {
  content: string
  relevance: number
  source: string
  timestamp: string
}
