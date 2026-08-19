const DB_NAME = 'solidify-attachments'
const STORE_NAME = 'media'
const memoryMedia = new Map<string, string>()

function canUseIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开附件媒体存储'))
  })
}

export async function saveAttachmentMedia(mediaUrl: string): Promise<string> {
  const id = `media-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  memoryMedia.set(id, mediaUrl)
  if (!canUseIndexedDb()) return id
  try {
    const db = await openDatabase()
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(mediaUrl, id)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
    db.close()
  } catch (error) {
    console.warn('[attachments] IndexedDB write failed; using in-memory media only', error)
  }
  return id
}

export async function loadAttachmentMedia(id: string): Promise<string | undefined> {
  const cached = memoryMedia.get(id)
  if (cached) return cached
  if (!canUseIndexedDb()) return undefined
  try {
    const db = await openDatabase()
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    if (typeof value === 'string') {
      memoryMedia.set(id, value)
      return value
    }
  } catch (error) {
    console.warn('[attachments] IndexedDB read failed', error)
  }
  return undefined
}
