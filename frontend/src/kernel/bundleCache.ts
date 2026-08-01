// IndexedDb-backed cache for PartBundles, keyed by (doc_id, doc_rev).
// A separate database from the document store, the bundle is a derivable
// artifact, not a document payload. A miss just triggers a cold rebuild via
// the OCC bundle builder worker; there is no invalidation API.

import { BUNDLE_SCHEMA, type PartBundle } from './partBundle'

const DB_NAME = 'oversolved-bundles'
// v2 adds the `latest` store. Bumping DB_VERSION with no migration
// path for `bundles` is safe here specifically: a bundle is a derivable
// artifact, so wiping it just means the next lookup is a miss and cold-rebuilds,
// never wrong geometry. Cheaper and safer than backfilling `latest` by hand.
const DB_VERSION = 2
const STORE = 'bundles'
const LATEST_STORE = 'latest'

// Newest N revs of a doc_id kept in the cache; older ones are pruned on put.
// N=3 buys the one-rev-back migration chain and nothing more, bundleCache has
// no other consumer of older revs.
const MAX_REVS_PER_DOC = 3

interface LatestRecord {
  doc_id: string
  revs: number[]  // ascending, at most MAX_REVS_PER_DOC entries
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (event) => {
      const db = req.result
      if (event.oldVersion < 2 && db.objectStoreNames.contains(STORE)) {
        db.deleteObjectStore(STORE)
      }
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains(LATEST_STORE)) {
        db.createObjectStore(LATEST_STORE, { keyPath: 'doc_id' })
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

async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openDb()
  return db.transaction(name, mode).objectStore(name)
}

function bundleKey(doc_id: string, doc_rev: number): string {
  return `${doc_id}@${doc_rev}`
}

// A record whose schema does not match the current one carries stale semantics
// (older schemas: cylinder/cone/sphere/torus anchor axes read the surface
// normal instead of its axis) -- treat it as a miss so the caller does a cold
// rebuild instead of trusting a bundle that means something different now.
export async function bundleCacheGet(doc_id: string, doc_rev: number): Promise<PartBundle | undefined> {
  const st = await store(STORE, 'readonly')
  const record = await prom(st.get(bundleKey(doc_id, doc_rev)) as IDBRequest<{ payload: PartBundle } | undefined>)
  const bundle = record?.payload
  if (bundle && bundle.schema !== BUNDLE_SCHEMA) return undefined
  return bundle
}

// The newest rev of `doc_id` ever cached (regardless of eviction, pruning in
// bundleCachePut only drops the OLDEST revs, never the newest, so this always
// points at a record that still exists in `bundles`). Lets solveAssembly's
// anchor-migration lookup do one get instead of an O(rev) downward scan.
export async function bundleCacheLatestRev(doc_id: string): Promise<number | undefined> {
  const st = await store(LATEST_STORE, 'readonly')
  const record = await prom(st.get(doc_id) as IDBRequest<LatestRecord | undefined>)
  if (!record || record.revs.length === 0) return undefined
  return record.revs[record.revs.length - 1]
}

export async function bundleCachePut(bundle: PartBundle): Promise<void> {
  const db = await openDb()
  const tx = db.transaction([STORE, LATEST_STORE], 'readwrite')
  const bundles = tx.objectStore(STORE)
  const latest = tx.objectStore(LATEST_STORE)

  await prom(bundles.put({ key: bundleKey(bundle.doc_id, bundle.doc_rev), payload: bundle }))

  const existing = await prom(latest.get(bundle.doc_id) as IDBRequest<LatestRecord | undefined>)
  const revs = Array.from(new Set([...(existing?.revs ?? []), bundle.doc_rev])).sort((a, b) => a - b)
  const evicted = revs.length > MAX_REVS_PER_DOC ? revs.splice(0, revs.length - MAX_REVS_PER_DOC) : []
  for (const rev of evicted) {
    await prom(bundles.delete(bundleKey(bundle.doc_id, rev)))
  }
  await prom(latest.put({ doc_id: bundle.doc_id, revs }))
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
