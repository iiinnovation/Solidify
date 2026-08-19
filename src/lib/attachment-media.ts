const DB_NAME = 'solidify-attachment-media'
const LEGACY_DB_NAME = 'solidify-attachments'
const STORE_NAME = 'media'
const memoryMedia = new Map<string, string>()

export function attachmentMediaPath(mediaId: string, name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'image'
  return `media/attachment-${mediaId}-${safeName}`
}

function canUseIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开附件媒体存储'))
    request.onblocked = () => reject(new Error('附件媒体存储升级被其他窗口阻塞'))
  })
}

export async function saveAttachmentMedia(mediaUrl: string): Promise<string> {
  const id = `media-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  memoryMedia.set(id, mediaUrl)
  if (!canUseIndexedDb()) return id
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put(mediaUrl, id)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('附件媒体写入失败'))
      transaction.onabort = () => reject(transaction.error ?? new Error('附件媒体写入已中止'))
    })
  } finally {
    db.close()
  }
  return id
}

export async function loadAttachmentMedia(id: string): Promise<string | undefined> {
  const cached = memoryMedia.get(id)
  if (cached) return cached
  if (!canUseIndexedDb()) return undefined
  let db: IDBDatabase | undefined
  try {
    db = await openDatabase()
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = db!.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    if (typeof value === 'string') {
      memoryMedia.set(id, value)
      return value
    }
  } catch (error) {
    console.warn('[attachments] IndexedDB read failed', error)
  } finally {
    db?.close()
  }
  const legacy = await loadLegacyAttachmentMedia(id)
  if (legacy) memoryMedia.set(id, legacy)
  return legacy
}

async function loadLegacyAttachmentMedia(id: string): Promise<string | undefined> {
  const db = await new Promise<IDBDatabase | undefined>((resolve) => {
    const request = indexedDB.open(LEGACY_DB_NAME)
    request.onupgradeneeded = () => request.transaction?.abort()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(undefined)
    request.onblocked = () => resolve(undefined)
  })
  if (!db || !db.objectStoreNames.contains(STORE_NAME)) {
    db?.close()
    return undefined
  }
  const value = await new Promise<unknown>((resolve) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(undefined)
  })
  db.close()
  return typeof value === 'string' ? value : undefined
}
