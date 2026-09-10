import type { FolderInventory } from './types'

/** Do not infer new scope from legacy extensionCounts; only use scanned metadata. */
export function folderTaskParseableFiles(inventory: FolderInventory): number {
  return inventory.readableFiles + (inventory.externalFiles ?? 0)
}
