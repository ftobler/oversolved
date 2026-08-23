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

// Read-modify-write in ONE readwrite transaction: the get and the put share a
// single `db.transaction(...)` call instead of each going through `tx()`
// separately. Two transactions would let a concurrent writer (another save,
// another tab against the same origin) land its own put between this read and
// this write, and this write would then silently clobber it -- a classic lost
// update. Opening one transaction for both requests makes IndexedDB serialize
// this whole read+write against any other transaction touching the store, per
// spec.
//
// `mutate` sees the current record (or undefined if none exists) and returns
// the record to write, or undefined to skip the write entirely -- a read,
// decide-nothing-to-do, bail, still inside the same transaction as the read.
//
// The put is issued SYNCHRONOUSLY from inside the get request's onsuccess
// handler rather than after `await`ing a promisified get (contrast idbPut,
// idbGet above). A transaction auto-commits once its request queue drains and
// control returns to the event loop without a new request being placed; an
// `await` between the get and the put yields to the microtask/task queue; a
// caller running under fake timers can advance that queue far enough for the
// transaction to close before the continuation runs, throwing
// TransactionInactiveError on the put (real IndexedDB requests fire as tasks,
// not microtasks, which is what fake-indexeddb's queueTask reproduces).
// Chaining the put inside the onsuccess callback keeps both requests in the
// same task, so the transaction is provably still open when the put is placed.
export async function idbReadModifyWrite<T>(
  key: string,
  mutate: (existing: T | undefined) => T | undefined,
): Promise<T | undefined> {
  const db = await openDb()
  return new Promise<T | undefined>((resolve, reject) => {
    const transaction = db.transaction(STORE_DOCUMENTS, 'readwrite')
    const objectStore = transaction.objectStore(STORE_DOCUMENTS)
    let result: T | undefined
    const getReq = objectStore.get(key) as IDBRequest<T | undefined>
    getReq.onsuccess = () => {
      result = mutate(getReq.result)
      if (result !== undefined) {
        const putReq = objectStore.put(result as unknown as Record<string, unknown>)
        putReq.onerror = () => reject(putReq.error)
      }
    }
    getReq.onerror = () => reject(getReq.error)
    // Resolve on the transaction's completion, not the individual requests':
    // that is the point at which the write is durably committed, matching
    // idbPut's existing contract (its `await promisify(store.put(...))`
    // resolves on the put request, which for a solo request in its own
    // transaction happens at essentially the same moment).
    transaction.oncomplete = () => resolve(result)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}
