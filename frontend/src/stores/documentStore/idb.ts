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
//
// v4 adds the workspace stores. `workspace_meta` holds one row per workspace
// (name, references, provenance, trash and the tombstones); `workspace_entries`
// is the working copy, one row per entry keyed (workspace, id); and
// `workspace_saved` is the explicit-save checkpoint under the same key. The v1
// `documents` store stays in place but is never read by the workspace seam, so
// the pre-upgrade library survives the version bump untouched (A2).
//
// v5 adds `workspace_entry_meta`, a payload-free mirror of `workspace_entries`
// (same key, no text/bytes). The U1 grid lists entry counts, cover entries and
// revs without deserializing every document's payload just to count it.
export const DB_NAME = 'oversolved'
export const DB_VERSION = 5
export const STORE_DOCUMENTS = 'documents'
export const STORE_HANDLES = 'handles'
export const STORE_FILES = 'files'
export const STORE_WORKSPACE_META = 'workspace_meta'
export const STORE_WORKSPACE_ENTRIES = 'workspace_entries'
export const STORE_WORKSPACE_ENTRY_META = 'workspace_entry_meta'
export const STORE_WORKSPACE_SAVED = 'workspace_saved'

let dbPromise: Promise<IDBDatabase> | null = null

// The v4-to-v5 upgrade projects every existing working-copy row into the new
// payload-free mirror, so an existing database lists with real counts. This is
// the only place the pre-upgrade rows are visible; every later write keeps the
// mirror in step.
function backfillEntryMeta(transaction: IDBTransaction | null): void {
  if (!transaction) return
  const meta = transaction.objectStore(STORE_WORKSPACE_ENTRY_META)
  const cursorReq = transaction.objectStore(STORE_WORKSPACE_ENTRIES).openCursor()
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor) return
    const record = cursor.value as {
      workspace: string
      id: string
      path: string
      kind: 'document' | 'file'
      name: string
      docKind?: string
      mime?: string
      fileKind?: string
      rev?: number
      updatedAt?: number
    }
    const row: Record<string, unknown> = {
      workspace: record.workspace,
      id: record.id,
      path: record.path,
      kind: record.kind,
      name: record.name,
      rev: record.rev ?? 0,
      updatedAt: record.updatedAt ?? 0,
    }
    if (record.docKind !== undefined) row.docKind = record.docKind
    if (record.mime !== undefined) row.mime = record.mime
    if (record.fileKind !== undefined) row.fileKind = record.fileKind
    meta.put(row)
    cursor.continue()
  }
}

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
      // One row per workspace, keyed by its uuid.
      if (!db.objectStoreNames.contains(STORE_WORKSPACE_META)) {
        db.createObjectStore(STORE_WORKSPACE_META, { keyPath: 'workspace' })
      }
      // The working copy and its checkpoint: compound key (workspace, id) so a
      // per-entry write is one record and one workspace never collides with another.
      if (!db.objectStoreNames.contains(STORE_WORKSPACE_ENTRIES)) {
        db.createObjectStore(STORE_WORKSPACE_ENTRIES, { keyPath: ['workspace', 'id'] })
      }
      // The payload-free mirror of the working copy, kept in lock-step with it
      // by every write path so the grid can list without reading payload.
      if (!db.objectStoreNames.contains(STORE_WORKSPACE_ENTRY_META)) {
        db.createObjectStore(STORE_WORKSPACE_ENTRY_META, { keyPath: ['workspace', 'id'] })
      }
      if (!db.objectStoreNames.contains(STORE_WORKSPACE_SAVED)) {
        db.createObjectStore(STORE_WORKSPACE_SAVED, { keyPath: ['workspace', 'id'] })
      }
      // One-time backfill for a database upgraded from before the payload-free
      // mirror existed: project every working-copy record so the grid lists a
      // pre-existing workspace instead of counting it as empty.
      backfillEntryMeta(req.transaction)
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

// Store-scoped primitives for callers that own a store other than `documents`
// (the workspace stores today). They mirror the uuid-keyed helpers above but
// take the store name, so a workspace call cannot land in `documents` by accident.
export async function idbGetFrom<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const store = await tx('readonly', storeName)
  return promisify(store.get(key) as IDBRequest<T | undefined>)
}

export async function idbGetAllFrom<T>(storeName: string): Promise<T[]> {
  const store = await tx('readonly', storeName)
  return promisify(store.getAll() as IDBRequest<T[]>)
}

export async function idbPutTo<T>(storeName: string, value: T): Promise<void> {
  const store = await tx('readwrite', storeName)
  await promisify(store.put(value as unknown as Record<string, unknown>))
}

export async function idbDeleteFrom(storeName: string, key: IDBValidKey): Promise<void> {
  const store = await tx('readwrite', storeName)
  await promisify(store.delete(key))
}

// One transaction across every named store, the shape I7's IndexedDB clause
// needs: the working copy, its checkpoint and the workspace row move as a unit.
// `build` runs once the stores are open and must issue its requests
// synchronously, chaining a dependent read's callback rather than awaiting
// between requests (the discipline idbReadModifyWrite documents below). Resolves
// on the transaction's completion, rejects on error/abort, and a throw from
// `build` aborts the whole unit so a partial write never lands.
export function idbTransaction<T>(
  storeNames: string[],
  mode: IDBTransactionMode,
  build: (stores: Record<string, IDBObjectStore>) => T,
): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeNames, mode)
    const stores: Record<string, IDBObjectStore> = {}
    for (const name of storeNames) stores[name] = transaction.objectStore(name)
    let value: T
    try {
      value = build(stores)
    } catch (err) {
      transaction.abort()
      reject(err)
      return
    }
    transaction.oncomplete = () => resolve(value)
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  }))
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
