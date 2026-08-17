import type { StateStorage } from 'zustand/middleware'

const TRANSIENT_STORAGE_PREFIXES = [
  'solidify:snapshots:',
  'solidify-ledger:',
] as const

/** Browser engines disagree on the DOMException name and message. */
export function isStorageQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; message?: unknown; code?: unknown }
  const name = typeof candidate.name === 'string' ? candidate.name : ''
  const message = typeof candidate.message === 'string' ? candidate.message : ''
  return name === 'QuotaExceededError'
    || name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || candidate.code === 22
    || candidate.code === 1014
    || /quota.*exceed|storage.*full/i.test(message)
}

/**
 * Write important state after evicting old, reconstructable runtime records.
 * Conversation/artifact data is never selected as an eviction candidate.
 */
export function setStorageItemWithQuotaRecovery(
  storage: Storage,
  key: string,
  value: string,
): void {
  try {
    storage.setItem(key, value)
    return
  } catch (error) {
    if (!isStorageQuotaError(error)) throw error
  }

  const candidates: string[] = []
  for (let index = 0; index < storage.length; index++) {
    const candidate = storage.key(index)
    if (
      candidate
      && candidate !== key
      && TRANSIENT_STORAGE_PREFIXES.some((prefix) => candidate.startsWith(prefix))
    ) candidates.push(candidate)
  }

  // localStorage preserves insertion order. Old entries are tried first so a
  // recent in-progress run is the last thing discarded under pressure.
  for (const candidate of candidates) {
    storage.removeItem(candidate)
    try {
      storage.setItem(key, value)
      return
    } catch (error) {
      if (!isStorageQuotaError(error)) throw error
    }
  }

  // Preserve the browser's native error shape for callers that must fail
  // closed (for example an approval audit write).
  storage.setItem(key, value)
}

/** Zustand adapter: quota pressure must not terminate an active model run. */
export function createQuotaResilientStateStorage(storage: Storage): StateStorage {
  return {
    getItem: (name) => storage.getItem(name),
    removeItem: (name) => storage.removeItem(name),
    setItem(name, value) {
      try {
        setStorageItemWithQuotaRecovery(storage, name, value)
      } catch (error) {
        if (!isStorageQuotaError(error)) throw error
        console.warn('[storage] Chat persistence skipped because browser storage is full')
      }
    },
  }
}
