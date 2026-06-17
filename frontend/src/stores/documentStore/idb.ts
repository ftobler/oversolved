// Minimal promise wrapper over IndexedDB. Kept tiny and dependency-free so the
// static build does not pull a database library for what is essentially a
// keyed object store. One database, one object store keyed by document uuid.

export const DB_NAME = 'oversolved'
export const DB_VERSION = 1
export const STORE_DOCUMENTS = 'documents'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_DOCUMENTS)) {
        db.createObjectStore(STORE_DOCUMENTS, { keyPath: 'uuid' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

// Drops the cached connection so a closed/deleted database is reopened on next
// use. Primarily a test seam (fake-indexeddb resets between cases).
export function resetDbConnection(): void {
  dbPromise = null
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openDb()
  return db.transaction(STORE_DOCUMENTS, mode).objectStore(STORE_DOCUMENTS)
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const store = await tx('readonly')
  return promisify(store.get(key) as IDBRequest<T | undefined>)
}

export async function idbGetAll<T>(): Promise<T[]> {
  const store = await tx('readonly')
  return promisify(store.getAll() as IDBRequest<T[]>)
}

export async function idbPut<T>(value: T): Promise<void> {
  const store = await tx('readwrite')
  await promisify(store.put(value as unknown as Record<string, unknown>))
}

export async function idbDelete(key: string): Promise<void> {
  const store = await tx('readwrite')
  await promisify(store.delete(key))
}
