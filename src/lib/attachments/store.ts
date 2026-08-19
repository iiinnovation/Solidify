import type { AttachmentResource } from './types'

interface StoredAttachment {
  id: string
  name: string
  size: number
  mimeType?: string
  text?: string
  mediaUrl?: string
  mediaId?: string
  updatedAt: number
}

const DB_NAME = 'solidify-attachments'
const STORE_NAME = 'resources'
const memory = new Map<string, StoredAttachment>()

function toStored(resource: AttachmentResource): StoredAttachment {
  return { ...resource, updatedAt: Date.now() }
}

function openDb(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开附件资源库'))
    request.onblocked = () => reject(new Error('附件资源库升级被其他窗口阻塞'))
  })
}

export async function saveAttachmentResource(resource: AttachmentResource): Promise<void> {
  const value = toStored(resource)
  memory.set(resource.id, value)
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(value)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('附件资源写入失败'))
    tx.onabort = () => reject(tx.error ?? new Error('附件资源写入已中止'))
  })
  db.close()
}

export async function loadAttachmentResource(id: string): Promise<AttachmentResource | undefined> {
  const cached = memory.get(id)
  if (cached) return { ...cached }
  const db = await openDb().catch(() => undefined)
  if (!db) return undefined
  const value = await new Promise<StoredAttachment | undefined>((resolve) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id)
    request.onsuccess = () => resolve(request.result as StoredAttachment | undefined)
    request.onerror = () => resolve(undefined)
  })
  db.close()
  if (!value) return undefined
  memory.set(id, value)
  const { updatedAt: _updatedAt, ...resource } = value
  return resource
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
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
  db.close()
}
