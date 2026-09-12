import type { PreviewKey, PreviewRecord, PreviewStore } from './types'
import { previewKey } from './types'
import { bumpPreviewRevision } from './events'

// Derived data in its own database, deliberately not inside `oversolved`: the
// workspace tree and its database hold documents, and a preview must never be
// one (I5). A wipe of this database costs a re-render, nothing else.
const DB_NAME = 'oversolved-previews'
const DB_VERSION = 1
const STORE = 'previews'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  const cached = dbPromise
  if (cached) return cached
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: ['workspace', 'entry'] })
      }
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => {
        db.close()
        if (dbPromise === opening) dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => reject(req.error)
  })
  dbPromise = opening
  opening.catch(() => {
    if (dbPromise === opening) dbPromise = null
  })
  return opening
}

// Test seam: drop the cached connection so the next use reopens against a fresh
// fake IndexedDB factory.
export function resetPreviewDbConnection(): void {
  dbPromise = null
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export class IndexedDbPreviewStore implements PreviewStore {
  async get(workspace: string, entry: string): Promise<string | undefined> {
    const db = await openDb()
    const store = db.transaction(STORE, 'readonly').objectStore(STORE)
    const record = await promisify(store.get([workspace, entry]) as IDBRequest<PreviewRecord | undefined>)
    return record?.image
  }

  async getMany(keys: PreviewKey[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const key of keys) {
      const image = await this.get(key.workspace, key.entry)
      if (image !== undefined) out.set(previewKey(key.workspace, key.entry), image)
    }
    return out
  }

  async put(workspace: string, entry: string, image: string): Promise<void> {
    const db = await openDb()
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
    await promisify(store.put({ workspace, entry, image, updatedAt: Date.now() }))
    bumpPreviewRevision()
  }

  async remove(workspace: string, entry: string): Promise<void> {
    const db = await openDb()
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
    await promisify(store.delete([workspace, entry]))
    bumpPreviewRevision()
  }

  // One transaction: read every row, delete the matching workspace's rows from
  // inside the read's success callback so the transaction cannot auto-commit
  // before the deletes are queued.
  async clearWorkspace(workspace: string): Promise<void> {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const all = store.getAll() as IDBRequest<PreviewRecord[]>
      all.onsuccess = () => {
        for (const record of all.result) {
          if (record.workspace === workspace) store.delete([record.workspace, record.entry])
        }
      }
      all.onerror = () => reject(all.error)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('preview clear failed'))
      tx.onabort = () => reject(tx.error ?? new Error('preview clear aborted'))
    })
    bumpPreviewRevision()
  }
}
