import type { AttachmentResource } from './types'
import { saveAttachmentMedia } from '../attachment-media'

interface StoredAttachment {
  id: string
  name: string
  size: number
  mimeType?: string
  text?: string
  mediaUrl?: string
  mediaId?: string
  textPresent: boolean
  updatedAt: number
}

interface StoredAttachmentChunk {
  attachmentId: string
  index: number
  text: string
}

const DB_NAME = 'solidify-attachment-resources'
const LEGACY_DB_NAME = 'solidify-attachments'
const DB_VERSION = 2
const STORE_NAME = 'resources'
const CHUNK_STORE_NAME = 'chunks'
const CHUNK_SIZE = 8_000
const memory = new Map<string, AttachmentResource>()

function toStored(resource: AttachmentResource): StoredAttachment {
  return {
    id: resource.id,
    name: resource.name,
    size: resource.size,
    mimeType: resource.mimeType,
    mediaId: resource.mediaId,
    textPresent: resource.text !== undefined,
    updatedAt: Date.now(),
  }
}

function openDb(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(CHUNK_STORE_NAME)) {
        const chunks = db.createObjectStore(CHUNK_STORE_NAME, { keyPath: ['attachmentId', 'index'] })
        chunks.createIndex('byAttachmentId', 'attachmentId', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开附件资源库'))
    request.onblocked = () => reject(new Error('附件资源库升级被其他窗口阻塞'))
  })
}

export async function saveAttachmentResource(resource: AttachmentResource): Promise<void> {
  const normalized = resource.mediaUrl && !resource.mediaId
    ? { ...resource, mediaId: await saveAttachmentMedia(resource.mediaUrl) }
    : resource
  const metadata = toStored(normalized)
  // Keep the complete value in the process cache for the current run, while
  // the durable representation stores text in bounded records and never
  // duplicates an image Data URL in the text-resource database.
  memory.set(resource.id, { ...normalized })
  const db = await openDb()
  if (!db) return
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_NAME, CHUNK_STORE_NAME], 'readwrite')
      tx.objectStore(STORE_NAME).put(metadata)
      const chunks = tx.objectStore(CHUNK_STORE_NAME)
      const cursorRequest = chunks.index('byAttachmentId').openCursor(IDBKeyRange.only(normalized.id))
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        } else {
          const text = normalized.text ?? ''
          for (let offset = 0, index = 0; offset < text.length; offset += CHUNK_SIZE, index++) {
            chunks.put({ attachmentId: normalized.id, index, text: text.slice(offset, offset + CHUNK_SIZE) } satisfies StoredAttachmentChunk)
          }
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('附件资源写入失败'))
      tx.onabort = () => reject(tx.error ?? new Error('附件资源写入已中止'))
    })
  } finally {
    db.close()
  }
}

export async function loadAttachmentResource(id: string): Promise<AttachmentResource | undefined> {
  const cached = memory.get(id)
  if (cached) return { ...cached }
  const db = await openDb().catch(() => undefined)
  const value = db ? await new Promise<StoredAttachment | undefined>((resolve) => {
    const transaction = db.transaction([STORE_NAME, CHUNK_STORE_NAME], 'readonly')
    const request = transaction.objectStore(STORE_NAME).get(id)
    let metadata: StoredAttachment | undefined
    let chunks: StoredAttachmentChunk[] = []
    request.onsuccess = () => {
      metadata = request.result as StoredAttachment | undefined
      const chunkRequest = transaction.objectStore(CHUNK_STORE_NAME).index('byAttachmentId').getAll(IDBKeyRange.only(id))
      chunkRequest.onsuccess = () => {
        chunks = (chunkRequest.result as StoredAttachmentChunk[]).sort((left, right) => left.index - right.index)
        if (!metadata) return resolve(undefined)
        resolve({ ...metadata, text: metadata.textPresent ? chunks.map((chunk) => chunk.text).join('') : undefined })
      }
      chunkRequest.onerror = () => resolve(metadata)
    }
    request.onerror = () => resolve(undefined)
  }) : undefined
  db?.close()
  if (!value) {
    const legacy = await loadLegacyAttachmentResource(id)
    if (!legacy) return undefined
    await saveAttachmentResource(legacy)
    const migrated = memory.get(id)
    return migrated ? { ...migrated } : legacy
  }
  const { updatedAt: _updatedAt, textPresent: _textPresent, ...resource } = value
  memory.set(id, resource)
  return resource
}

async function loadLegacyAttachmentResource(id: string): Promise<AttachmentResource | undefined> {
  if (typeof indexedDB === 'undefined') return undefined
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
  const value = await new Promise<AttachmentResource | undefined>((resolve) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id)
    request.onsuccess = () => {
      const record = request.result as Partial<StoredAttachment> | undefined
      if (!record || typeof record.id !== 'string' || typeof record.name !== 'string' || typeof record.size !== 'number') return resolve(undefined)
      resolve({
        id: record.id,
        name: record.name,
        size: record.size,
        mimeType: record.mimeType,
        text: record.text,
        mediaUrl: record.mediaUrl,
        mediaId: record.mediaId,
      })
    }
    request.onerror = () => resolve(undefined)
  })
  db.close()
  return value
}

export async function loadAttachmentResources(ids: readonly string[]): Promise<AttachmentResource[]> {
  const values = await Promise.all(ids.map((id) => loadAttachmentResource(id)))
  return values.filter((value): value is AttachmentResource => Boolean(value))
}

export async function deleteAttachmentResource(id: string): Promise<void> {
  memory.delete(id)
  const db = await openDb().catch(() => undefined)
  if (!db) return
  await new Promise<void>((resolve) => {
    const tx = db.transaction([STORE_NAME, CHUNK_STORE_NAME], 'readwrite')
    tx.objectStore(STORE_NAME).delete(id)
    const chunks = tx.objectStore(CHUNK_STORE_NAME)
    const cursorRequest = chunks.index('byAttachmentId').openCursor(IDBKeyRange.only(id))
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) return
      cursor.delete()
      cursor.continue()
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
  db.close()
}
