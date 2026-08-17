import { describe, expect, it, vi } from 'vitest'
import {
  createQuotaResilientStateStorage,
  isStorageQuotaError,
  setStorageItemWithQuotaRecovery,
} from './storage-quota'

function quotaError(): DOMException {
  return new DOMException('The quota has been exceeded.', 'QuotaExceededError')
}

function constrainedStorage(initial: Record<string, string>): Storage {
  const values = new Map(Object.entries(initial))
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem(key, value) {
      if (key === 'solidify-chat' && [...values.keys()].some((item) => item.startsWith('solidify:'))) {
        throw quotaError()
      }
      values.set(key, value)
    },
  }
}

describe('storage quota recovery', () => {
  it('recognizes WebKit quota errors from the screenshot', () => {
    expect(isStorageQuotaError(quotaError())).toBe(true)
  })

  it('evicts reconstructable snapshots before retrying important state', () => {
    const storage = constrainedStorage({
      'solidify:snapshots:old': 'large snapshot',
      'unrelated-setting': 'keep me',
    })

    setStorageItemWithQuotaRecovery(storage, 'solidify-chat', 'current chat')

    expect(storage.getItem('solidify-chat')).toBe('current chat')
    expect(storage.getItem('solidify:snapshots:old')).toBeNull()
    expect(storage.getItem('unrelated-setting')).toBe('keep me')
  })

  it('keeps Zustand updates alive when no transient record can free enough space', () => {
    const storage = constrainedStorage({})
    storage.setItem = vi.fn(() => { throw quotaError() })
    const adapter = createQuotaResilientStateStorage(storage)

    expect(() => adapter.setItem('solidify-chat', 'too large')).not.toThrow()
  })
})
