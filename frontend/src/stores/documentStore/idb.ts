// Minimal promise wrapper over IndexedDB. Kept tiny and dependency-free rather
// than pulling a database library in for what is essentially a keyed object
// store. One database; `documents` is keyed by document uuid, `handles` holds
// out-of-line values under names this module's callers choose.
//
// v2 adds `handles`, whose only inhabitant is the FileSystemDirectoryHandle of
// a library folder the user opened. A handle is structured-cloneable, so
// IndexedDB is the only place it CAN be kept across sessions -- which is the
// role IndexedDB takes on once a document can live in a real file: the handle
// registry rather than the library itself.
//
// v3 adds `files`, a flat uuid-keyed registry of imported file bytes (STEP
// today). It is additive: `documents` and `handles` are untouched and there is
// no migration, because a pre-v3 document carrying an inline `file_data`
// payload is disposable (A2 in the workspace-format plan).
export const DB_NAME = 'oversolved'
export const DB_VERSION = 3
export const STORE_DOCUMENTS = 'documents'
export const STORE_HANDLES = 'handles'
export const STORE_FILES = 'files'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  const cached = dbPromise
  if (cached) return cached
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_DOCUMENTS)) {
        db.createObjectStore(STORE_DOCUMENTS, { keyPath: 'uuid' })
      }
      // Created without a keyPath: a directory handle is an opaque platform
      // object with no field to key on, so the caller supplies the key.
      if (!db.objectStoreNames.contains(STORE_HANDLES)) {
        db.createObjectStore(STORE_HANDLES)
      }
      // Keyed by the registry record's own `id`, like `documents` is by uuid.
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        db.createObjectStore(STORE_FILES, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => {
      const db = req.result
      // Yield to another tab's version upgrade instead of blocking it, and
      // drop the cached connection so the next use reopens at the new version.
      db.onversionchange = () => {
        db.close()
        if (dbPromise === opening) dbPromise = null
      }
      resolve(db)
    }
    // Never memoize a rejection: one transient failure must not poison local
    // persistence for the whole session.
    req.onerror = () => reject(req.error)
  })
  dbPromise = opening
  // Any rejection (including a synchronous open() throw, which never reaches
  // the request handlers above) must drop the cached seam so the next call
  // retries instead of replaying the failure for the rest of the session.
  opening.catch(() => {
    if (dbPromise === opening) dbPromise = null
  })
  return opening
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

async function tx(mode: IDBTransactionMode, name = STORE_DOCUMENTS): Promise<IDBObjectStore> {
  const db = await openDb()
  return db.transaction(name, mode).objectStore(name)
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

// The `handles` store, whose values carry no key of their own. Separate
// entry points rather than an optional store argument on idbGet/idbPut, so a
// keyed-by-uuid document call can never accidentally address it.
export async function idbGetHandle<T>(key: string): Promise<T | undefined> {
  const store = await tx('readonly', STORE_HANDLES)
  return promisify(store.get(key) as IDBRequest<T | undefined>)
}

export async function idbPutHandle<T>(key: string, value: T): Promise<void> {
  const store = await tx('readwrite', STORE_HANDLES)
  await promisify(store.put(value as unknown as Record<string, unknown>, key))
}

export async function idbDeleteHandle(key: string): Promise<void> {
  const store = await tx('readwrite', STORE_HANDLES)
  await promisify(store.delete(key))
}

// The `files` store, keyed by the record's own id. Separate entry points for
// the same reason as the handle helpers: a keyed-by-uuid document call must
// never be able to address the file registry by accident.
export async function idbGetFile<T>(key: string): Promise<T | undefined> {
  const store = await tx('readonly', STORE_FILES)
  return promisify(store.get(key) as IDBRequest<T | undefined>)
}

export async function idbGetAllFiles<T>(): Promise<T[]> {
  const store = await tx('readonly', STORE_FILES)
  return promisify(store.getAll() as IDBRequest<T[]>)
}

export async function idbPutFile<T>(value: T): Promise<void> {
  const store = await tx('readwrite', STORE_FILES)
  await promisify(store.put(value as unknown as Record<string, unknown>))
}

export async function idbDeleteFile(key: string): Promise<void> {
  const store = await tx('readwrite', STORE_FILES)
  await promisify(store.delete(key))
}

export async function idbClearFiles(): Promise<void> {
  const store = await tx('readwrite', STORE_FILES)
  await promisify(store.clear())
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
