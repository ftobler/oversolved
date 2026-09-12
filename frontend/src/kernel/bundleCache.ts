// IndexedDb-backed cache for PartBundles, keyed by (doc_id, content_hash).
// A separate database from the document store, the bundle is a derivable
// artifact, not a document payload. A miss just triggers a cold rebuild via
// the OCC bundle builder worker; there is no invalidation API.
//
// The key is a content hash, not a revision (A11): a revision cannot express
// "the content is back to a state that was already built", which is exactly the
// undo case this re-key exists to win. The hash folds in the content hashes of
// the part document's one-level file dependencies, so replacing a referenced
// STEP's bytes also invalidates.
//
// Anchor ids are deterministic from an element's stable geom_hash
// (anchorIdFor, partBundle.ts), so a cold rebuild mints the same ids and mate
// refs survive a cache wipe with no remap chain at all.

import { BUNDLE_BUILD_FINGERPRINT, BUNDLE_SCHEMA, type PartBundle } from './partBundle'

const DB_NAME = 'oversolved-bundles'
// v3 makes the key a content hash and the per-doc index insertion-ordered by
// key. Bumping with no migration path for `bundles` is safe here specifically:
// a bundle is a derivable artifact, so wiping it just means the next lookup is
// a miss and cold-rebuilds, never wrong geometry.
const DB_VERSION = 3
const STORE = 'bundles'
const INDEX_STORE = 'latest'

// Distinct content states of a doc_id kept in the cache; older ones are pruned
// on put. N=3 bounds the history so a part under active edit cannot grow the
// cache without limit, while still retaining enough states for an undo of a
// couple of edits to hit.
const MAX_BUNDLES_PER_DOC = 3

// Cap on distinct doc_ids the cache holds. Without it the cache grows
// monotonically with the number of parts ever bundled (key pruning only bounds
// per-doc); on put, once this is exceeded the least-recently-written doc's keys
// leave both stores.
export const MAX_DOCS = 32

// Monotonic LRU clock. Date.now() alone would tie every put inside one fast
// fake-indexeddb test run (all ticks share a wall-clock instant), which would
// make LRU order fall back to doc_id instead of write order. Seeding from
// Date.now() keeps cross-page-load ordering intact, since a fresh session's
// first put always advances past the last session's.
let lastWrittenClock = 0

function nextLastWritten(): number {
  lastWrittenClock = Math.max(lastWrittenClock + 1, Date.now())
  return lastWrittenClock
}

// The per-doc insertion-ordered index. `keys` holds the content hashes, oldest
// first, at most MAX_BUNDLES_PER_DOC. A hash has no order, so recency is the
// insertion order, which is what makes an undo back to a recent state a hit.
interface DocIndex {
  doc_id: string
  keys: string[]
  // When this doc was last written, for LRU eviction across docs. Absent on a
  // record from a pre-LRU database; such a record sorts as the oldest, so the
  // stale entry is the first to go once MAX_DOCS is exceeded.
  last_written?: number
}

interface CachedBundleRecord {
  key: string
  payload: PartBundle
  // Fingerprint of the code that built the bundle (see BUNDLE_BUILD_FINGERPRINT).
  // A record cached before fingerprints existed carries no built_by, which
  // reads back as a mismatch on get: a derivable artifact cold-rebuilds.
  built_by: string
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  const cached = dbPromise
  if (cached) return cached
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (event) => {
      const db = req.result
      if (event.oldVersion < DB_VERSION) {
        if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE)
        if (db.objectStoreNames.contains(INDEX_STORE)) db.deleteObjectStore(INDEX_STORE)
      }
      db.createObjectStore(STORE, { keyPath: 'key' })
      db.createObjectStore(INDEX_STORE, { keyPath: 'doc_id' })
    }
    req.onblocked = () => {
      // A tab running older code holds the previous DB_VERSION open. Rejecting
      // unsticks the actor queue: the retry blocks again until that tab closes,
      // failing fast instead of silently hanging every assembly solve behind
      // the upgrade.
      reject(new Error(`open of '${DB_NAME}' v${DB_VERSION} blocked by another connection holding an older version`))
    }
    req.onsuccess = () => {
      const db = req.result
      // Yield to another tab's version upgrade instead of blocking it, and
      // drop the cached connection so the next use reopens at the new version.
      db.onversionchange = () => {
        db.close()
        if (dbPromise === opening) dbPromise = null
      }
      // A blocked open (onblocked already rejected this promise and cleared the
      // cached seam) can still settle onsuccess later, once the tab holding the
      // older version closes. That connection has no cached seam and would live
      // until the next version bump: close it so it never leaks.
      if (dbPromise !== opening) {
        db.close()
        return
      }
      resolve(db)
    }
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

function bundleKey(doc_id: string, content_hash: string): string {
  return `${doc_id}@${content_hash}`
}

// A record whose schema does not match the current one carries stale semantics
// (older schemas: cylinder/cone/sphere/torus anchor axes read the surface
// normal instead of its axis) -- treat it as a miss so the caller does a cold
// rebuild instead of trusting a bundle that means something different now. A
// `built_by` mismatch means the record was built by different code (or before
// fingerprints existed); a bundle is a derivable artifact, so both degrade to a
// cold rebuild, never wrong geometry.
export async function bundleCacheGet(doc_id: string, content_hash: string): Promise<PartBundle | undefined> {
  const st = await store(STORE, 'readonly')
  const record = await prom(st.get(bundleKey(doc_id, content_hash)) as IDBRequest<CachedBundleRecord | undefined>)
  const bundle = record?.payload
  if (bundle && (bundle.schema !== BUNDLE_SCHEMA || record?.built_by !== BUNDLE_BUILD_FINGERPRINT)) {
    return undefined
  }
  return bundle
}

export async function bundleCachePut(bundle: PartBundle): Promise<void> {
  const db = await openDb()
  const tx = db.transaction([STORE, INDEX_STORE], 'readwrite')
  const bundles = tx.objectStore(STORE)
  const index = tx.objectStore(INDEX_STORE)

  await prom(bundles.put({
    key: bundleKey(bundle.doc_id, bundle.content_hash),
    payload: bundle,
    built_by: BUNDLE_BUILD_FINGERPRINT,
  }))

  const existing = await prom(index.get(bundle.doc_id) as IDBRequest<DocIndex | undefined>)
  // Recency by insertion: an existing key moves to the newest end rather than
  // keeping its old slot, so the index always reads oldest-first.
  const keys = [...(existing?.keys ?? []).filter(k => k !== bundle.content_hash), bundle.content_hash]
  const evicted = keys.length > MAX_BUNDLES_PER_DOC ? keys.splice(0, keys.length - MAX_BUNDLES_PER_DOC) : []
  for (const key of evicted) {
    await prom(bundles.delete(bundleKey(bundle.doc_id, key)))
  }
  await prom(index.put({ doc_id: bundle.doc_id, keys, last_written: nextLastWritten() }))
  await evictBeyondMaxDocs(bundles, index, bundle.doc_id)
}

// A late relay salvage writes a finished build whose original solve timed out.
// It must never clobber a bundle a concurrent or later solve already cached.
// Unlike bundleCachePut this refuses to overwrite: the read of the existing key
// and the write run in one transaction, so there is no check-then-act window
// for a racing solve to slip its own write in between. Returns true when it
// wrote, false when the key was already present and the write was skipped.
export async function bundleCachePutIfAbsent(bundle: PartBundle): Promise<boolean> {
  const db = await openDb()
  const tx = db.transaction([STORE, INDEX_STORE], 'readwrite')
  const bundles = tx.objectStore(STORE)
  const index = tx.objectStore(INDEX_STORE)

  const existing = await prom(bundles.getKey(bundleKey(bundle.doc_id, bundle.content_hash)) as IDBRequest<IDBValidKey | undefined>)
  if (existing !== undefined) {
    // Something already owns this key: the late salvage yields rather than
    // revert it. The read has already resolved, so the aborted transaction will
    // commit on its own (no write was issued).
    return false
  }

  await prom(bundles.put({
    key: bundleKey(bundle.doc_id, bundle.content_hash),
    payload: bundle,
    built_by: BUNDLE_BUILD_FINGERPRINT,
  }))

  const prev = await prom(index.get(bundle.doc_id) as IDBRequest<DocIndex | undefined>)
  const keys = [...(prev?.keys ?? []).filter(k => k !== bundle.content_hash), bundle.content_hash]
  const evicted = keys.length > MAX_BUNDLES_PER_DOC ? keys.splice(0, keys.length - MAX_BUNDLES_PER_DOC) : []
  for (const key of evicted) {
    await prom(bundles.delete(bundleKey(bundle.doc_id, key)))
  }
  await prom(index.put({ doc_id: bundle.doc_id, keys, last_written: nextLastWritten() }))
  await evictBeyondMaxDocs(bundles, index, bundle.doc_id)
  return true
}

// Bound the cache across docs: once `latest` exceeds MAX_DOCS, drop the
// least-recently-written doc's keys from both stores. The doc just written is
// by definition the most recent, so it is never the eviction victim.
async function evictBeyondMaxDocs(
  bundles: IDBObjectStore,
  index: IDBObjectStore,
  keepDocId: string,
): Promise<void> {
  const records = await prom(index.getAll() as IDBRequest<DocIndex[]>)
  if (records.length <= MAX_DOCS) return
  // Oldest last_written first; a pre-LRU record (no timestamp) sorts as oldest.
  // Ties break deterministically by doc_id.
  records.sort(
    (a, b) => (a.last_written ?? 0) - (b.last_written ?? 0) || (a.doc_id < b.doc_id ? -1 : 1),
  )
  let evicted = 0
  const evictable = records.length - MAX_DOCS
  for (const doc of records) {
    if (evicted >= evictable) break
    if (doc.doc_id === keepDocId) continue
    for (const key of doc.keys) {
      await prom(bundles.delete(bundleKey(doc.doc_id, key)))
    }
    await prom(index.delete(doc.doc_id))
    evicted++
  }
}

// Agrees with bundleCacheGet's schema/fingerprint-mismatch-is-a-miss rule, so
// a caller cannot see `has() === true` and then `get() === undefined` for the
// same key.
export async function bundleCacheHas(doc_id: string, content_hash: string): Promise<boolean> {
  return (await bundleCacheGet(doc_id, content_hash)) !== undefined
}

// Test seam: drop the cached connection so the next open picks up a fresh
// IndexedDB factory (needed when fake-indexeddb resets between test cases).
export function resetBundleDbConnection(): void {
  dbPromise = null
}
