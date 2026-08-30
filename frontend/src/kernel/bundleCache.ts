// IndexedDb-backed cache for PartBundles, keyed by (doc_id, doc_rev).
// A separate database from the document store, the bundle is a derivable
// artifact, not a document payload. A miss just triggers a cold rebuild via
// the OCC bundle builder worker; there is no invalidation API.
//
// A cache wipe is NOT a pure geometry miss, because mate refs persist against
// anchor ids minted in a bundle. Since anchor ids are deterministic from the
// element's stable geom_hash (anchorIdFor, partBundle.ts), a cold rebuild mints
// the same ids and refs survive with no cache at all; for documents whose refs
// predate that, bundleCacheGetStale keeps a stale record readable for the
// anchor-remap chain even when the schema/fingerprint rules call it a miss.

import { BUNDLE_BUILD_FINGERPRINT, BUNDLE_SCHEMA, type PartBundle } from './partBundle'

const DB_NAME = 'oversolved-bundles'
// v2 adds the `latest` store. Bumping DB_VERSION with no migration
// path for `bundles` is safe here specifically: a bundle is a derivable
// artifact, so wiping it just means the next lookup is a miss and cold-rebuilds,
// never wrong geometry. Cheaper and safer than backfilling `latest` by hand.
// The anchor-ids caveat to that: a wipe strands mate refs minted before
// deterministic ids existed, which is what bundleCacheGetStale's remap-chain
// read mitigates (see the file header).
const DB_VERSION = 2
const STORE = 'bundles'
const LATEST_STORE = 'latest'

// Newest N revs of a doc_id kept in the cache; older ones are pruned on put.
// N=3 buys the one-rev-back migration chain and nothing more, bundleCache has
// no other consumer of older revs.
const MAX_REVS_PER_DOC = 3

// Cap on distinct doc_ids the cache holds. Without it the cache grows
// monotonically with the number of parts ever bundled (rev pruning only bounds
// per-doc); on put, once this is exceeded the least-recently-written doc's revs
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

interface LatestRecord {
  doc_id: string
  revs: number[]  // ascending, at most MAX_REVS_PER_DOC entries
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

function bundleKey(doc_id: string, doc_rev: number): string {
  return `${doc_id}@${doc_rev}`
}

// A record whose schema does not match the current one carries stale semantics
// (older schemas: cylinder/cone/sphere/torus anchor axes read the surface
// normal instead of its axis) -- treat it as a miss so the caller does a cold
// rebuild instead of trusting a bundle that means something different now. A
// `built_by` mismatch means the record was built by different code (or before
// fingerprints existed); a bundle is a derivable artifact, so both degrade to a
// cold rebuild, never wrong geometry.
export async function bundleCacheGet(doc_id: string, doc_rev: number): Promise<PartBundle | undefined> {
  const st = await store(STORE, 'readonly')
  const record = await prom(st.get(bundleKey(doc_id, doc_rev)) as IDBRequest<CachedBundleRecord | undefined>)
  const bundle = record?.payload
  if (bundle && (bundle.schema !== BUNDLE_SCHEMA || record?.built_by !== BUNDLE_BUILD_FINGERPRINT)) {
    return undefined
  }
  return bundle
}

// The migration chain's read for the newest cached rev of a doc. It deliberately
// skips the schema/fingerprint rules bundleCacheGet applies: anchorIdRemap's
// tier-1 match runs on geom_hash, which is schema- and code-independent, so a
// stale record is the one surviving source of the old random-id lineage after a
// cache wipe or schema bump. The caller must never trust this bundle's geometry
// or semantics, only its anchors dict, and only to migrate a freshly built
// bundle's ids onto.
export async function bundleCacheGetStale(doc_id: string, doc_rev: number): Promise<PartBundle | undefined> {
  const st = await store(STORE, 'readonly')
  const record = await prom(st.get(bundleKey(doc_id, doc_rev)) as IDBRequest<CachedBundleRecord | undefined>)
  return record?.payload
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

  await prom(bundles.put({
    key: bundleKey(bundle.doc_id, bundle.doc_rev),
    payload: bundle,
    built_by: BUNDLE_BUILD_FINGERPRINT,
  }))

  const existing = await prom(latest.get(bundle.doc_id) as IDBRequest<LatestRecord | undefined>)
  const revs = Array.from(new Set([...(existing?.revs ?? []), bundle.doc_rev])).sort((a, b) => a - b)
  const evicted = revs.length > MAX_REVS_PER_DOC ? revs.splice(0, revs.length - MAX_REVS_PER_DOC) : []
  for (const rev of evicted) {
    await prom(bundles.delete(bundleKey(bundle.doc_id, rev)))
  }
  await prom(latest.put({ doc_id: bundle.doc_id, revs, last_written: nextLastWritten() }))
  await evictBeyondMaxDocs(bundles, latest, bundle.doc_id)
}

// A late relay salvage writes a finished build whose original solve timed out.
// It must never clobber a bundle a concurrent or later solve already cached
// (a migrated record under the same key, for instance). Unlike bundleCachePut
// this refuses to overwrite: the read of the existing key and the write run in
// one transaction, so there is no check-then-act window for a racing solve to
// slip its own write in between. Returns true when it wrote, false when the key
// was already present and the write was skipped.
export async function bundleCachePutIfAbsent(bundle: PartBundle): Promise<boolean> {
  const db = await openDb()
  const tx = db.transaction([STORE, LATEST_STORE], 'readwrite')
  const bundles = tx.objectStore(STORE)
  const latest = tx.objectStore(LATEST_STORE)

  const existing = await prom(bundles.getKey(bundleKey(bundle.doc_id, bundle.doc_rev)) as IDBRequest<IDBValidKey | undefined>)
  if (existing !== undefined) {
    // Something already owns this key (a migrated or newer build): the late
    // salvage yields rather than revert it. The read has already resolved, so
    // the aborted transaction will commit on its own (no write was issued).
    return false
  }

  await prom(bundles.put({
    key: bundleKey(bundle.doc_id, bundle.doc_rev),
    payload: bundle,
    built_by: BUNDLE_BUILD_FINGERPRINT,
  }))

  const prev = await prom(latest.get(bundle.doc_id) as IDBRequest<LatestRecord | undefined>)
  const revs = Array.from(new Set([...(prev?.revs ?? []), bundle.doc_rev])).sort((a, b) => a - b)
  const evicted = revs.length > MAX_REVS_PER_DOC ? revs.splice(0, revs.length - MAX_REVS_PER_DOC) : []
  for (const rev of evicted) {
    await prom(bundles.delete(bundleKey(bundle.doc_id, rev)))
  }
  await prom(latest.put({ doc_id: bundle.doc_id, revs, last_written: nextLastWritten() }))
  await evictBeyondMaxDocs(bundles, latest, bundle.doc_id)
  return true
}

// Bound the cache across docs: once `latest` exceeds MAX_DOCS, drop the
// least-recently-written doc's revs from both stores. The doc just written is
// by definition the most recent, so it is never the eviction victim.
async function evictBeyondMaxDocs(
  bundles: IDBObjectStore,
  latest: IDBObjectStore,
  keepDocId: string,
): Promise<void> {
  const records = await prom(latest.getAll() as IDBRequest<LatestRecord[]>)
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
    for (const rev of doc.revs) {
      await prom(bundles.delete(bundleKey(doc.doc_id, rev)))
    }
    await prom(latest.delete(doc.doc_id))
    evicted++
  }
}

// Agrees with bundleCacheGet's schema/fingerprint-mismatch-is-a-miss rule, so
// a caller cannot see `has() === true` and then `get() === undefined` for the
// same key.
export async function bundleCacheHas(doc_id: string, doc_rev: number): Promise<boolean> {
  return (await bundleCacheGet(doc_id, doc_rev)) !== undefined
}

// Test seam: drop the cached connection so the next open picks up a fresh
// IndexedDB factory (needed when fake-indexeddb resets between test cases).
export function resetBundleDbConnection(): void {
  dbPromise = null
}
