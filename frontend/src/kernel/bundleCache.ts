// IndexedDb-backed cache for PartBundles, keyed by (doc_id, doc_rev).
// A separate database from the document store — the bundle is a derivable
// artifact, not a document payload. A miss just triggers a cold rebuild via
// the OCC bundle builder worker; there is no invalidation API.

import { BUNDLE_SCHEMA, type PartBundle } from './partBundle'

const DB_NAME = 'oversolved-bundles'
const DB_VERSION = 1
const STORE = 'bundles'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function prom<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openDb()
  return db.transaction(STORE, mode).objectStore(STORE)
}

function bundleKey(doc_id: string, doc_rev: number): string {
  return `${doc_id}@${doc_rev}`
}

// A record whose schema does not match the current one carries stale semantics
// (Stage A: cylinder/cone/sphere/torus anchor axes read the surface normal
// instead of its axis) -- treat it as a miss so the caller does a cold
// rebuild instead of trusting a bundle that means something different now.
export async function bundleCacheGet(doc_id: string, doc_rev: number): Promise<PartBundle | undefined> {
  const st = await store('readonly')
  const record = await prom(st.get(bundleKey(doc_id, doc_rev)) as IDBRequest<{ payload: PartBundle } | undefined>)
  const bundle = record?.payload
  if (bundle && bundle.schema !== BUNDLE_SCHEMA) return undefined
  return bundle
}

export async function bundleCachePut(bundle: PartBundle): Promise<void> {
  const st = await store('readwrite')
  await prom(st.put({ key: bundleKey(bundle.doc_id, bundle.doc_rev), payload: bundle }))
}

// Agrees with bundleCacheGet's schema-mismatch-is-a-miss rule, so a caller
// cannot see `has() === true` and then `get() === undefined` for the same key.
export async function bundleCacheHas(doc_id: string, doc_rev: number): Promise<boolean> {
  return (await bundleCacheGet(doc_id, doc_rev)) !== undefined
}

// Test seam: drop the cached connection so the next open picks up a fresh
// IndexedDB factory (needed when fake-indexeddb resets between test cases).
export function resetBundleDbConnection(): void {
  dbPromise = null
}
