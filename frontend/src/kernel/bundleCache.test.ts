import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { bundleCacheGet, bundleCachePut, bundleCachePutIfAbsent, bundleCacheHas, resetBundleDbConnection, MAX_DOCS } from './bundleCache'
import { BUNDLE_SCHEMA, type PartBundle, type Anchor } from './partBundle'

const DB_NAME = 'oversolved-bundles'
// The module's pinned version plus one, so a test can drive a live upgrade
// against whatever the module currently opens at.
const UPGRADE_VERSION = 4

function freshDb(): void {
  globalThis.indexedDB = new IDBFactory()
  resetBundleDbConnection()
}

// Open the live database at whatever version it currently holds, creating the
// two stores if it does not exist yet. Never bumps the version, so it reads the
// module's writes without wiping them.
function openRaw(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('bundles')) db.createObjectStore('bundles', { keyPath: 'key' })
      if (!db.objectStoreNames.contains('latest')) db.createObjectStore('latest', { keyPath: 'doc_id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// Rewrite a stored bundle record's built_by tag, simulating a record cached by
// a different build of the bundle-producing code.
async function overwriteBuiltBy(key: string, builtBy: string): Promise<void> {
  const db = await openRaw()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('bundles', 'readwrite')
    const st = tx.objectStore('bundles')
    const getReq = st.get(key)
    getReq.onsuccess = () => {
      st.put({ ...getReq.result, built_by: builtBy })
    }
    getReq.onerror = () => reject(getReq.error)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => reject(tx.error)
  })
}

// The per-doc index keys, oldest first, which the module does not expose.
async function readIndexKeys(doc_id: string): Promise<string[] | undefined> {
  const db = await openRaw()
  return await new Promise((resolve, reject) => {
    const getReq = db.transaction('latest', 'readonly').objectStore('latest').get(doc_id)
    getReq.onsuccess = () => { db.close(); resolve(getReq.result?.keys) }
    getReq.onerror = () => { db.close(); reject(getReq.error) }
  })
}

async function readBundleCount(): Promise<number> {
  const db = await openRaw()
  return await new Promise((resolve, reject) => {
    const countReq = db.transaction('bundles', 'readonly').objectStore('bundles').count()
    countReq.onsuccess = () => { db.close(); resolve(countReq.result) }
    countReq.onerror = () => { db.close(); reject(countReq.error) }
  })
}

function fixtureBundle(doc_id: string, content_hash: string): PartBundle {
  // Use small typed arrays so we can assert byte-level round-trip fidelity.
  return {
    doc_id,
    content_hash,
    schema: BUNDLE_SCHEMA,
    bodies: [
      {
        mesh: {
          vertices: new Float32Array([0, 1, 2, 3, 4, 5]),
          indices: new Uint32Array([0, 1, 2]),
          faceIdsPerTriangle: new Uint32Array([7]),
        },
        edges: [
          {
            id: 'e1',
            kind: 'line',
            point: [0, 0, 0],
            endpoints: [[0, 0, 0], [10, 0, 0]],
          },
        ],
      },
    ],
    anchors: {
      a1: {
        kind: 'plane',
        point: [0, 0, 5],
        axis: [0, 0, 1],
        geom_hash: 'gface_abc',
        created_by: 'extrude1',
      },
    },
  }
}

describe('bundleCache', () => {
  beforeEach(() => {
    freshDb()
  })

  it('round-trips a PartBundle with typed arrays intact', async () => {
    const bundle = fixtureBundle('docA', 'h1')
    await bundleCachePut(bundle)
    const loaded = await bundleCacheGet('docA', 'h1')
    expect(loaded).toBeDefined()
    expect(loaded!.doc_id).toBe('docA')
    expect(loaded!.content_hash).toBe('h1')
    expect(loaded!.bodies).toHaveLength(1)
    const mesh = loaded!.bodies[0].mesh
    expect(mesh.vertices).toBeDefined()
    expect([...mesh.vertices]).toEqual([0, 1, 2, 3, 4, 5])
    expect(mesh.indices).toBeDefined()
    expect([...mesh.indices]).toEqual([0, 1, 2])
    expect(mesh.faceIdsPerTriangle).toBeDefined()
    expect([...mesh.faceIdsPerTriangle]).toEqual([7])
    expect(loaded!.bodies[0].edges).toEqual(bundle.bodies[0].edges)
    expect(loaded!.anchors).toEqual(bundle.anchors)
  })

  it('returns undefined on a miss', async () => {
    const loaded = await bundleCacheGet('nope', 'h1')
    expect(loaded).toBeUndefined()
  })

  it('has returns false on a miss and true after put', async () => {
    expect(await bundleCacheHas('nope', 'h1')).toBe(false)
    const bundle = fixtureBundle('docA', 'h1')
    await bundleCachePut(bundle)
    expect(await bundleCacheHas('docA', 'h1')).toBe(true)
  })

  describe('bundleCachePutIfAbsent', () => {
    it('writes when the key is free and reports true', async () => {
      const bundle = fixtureBundle('docA', 'h1')
      expect(await bundleCachePutIfAbsent(bundle)).toBe(true)
      expect(await bundleCacheGet('docA', 'h1')).toBeDefined()
      expect(await bundleCacheHas('docA', 'h1')).toBe(true)
    })

    it('refuses to overwrite an existing key and reports false', async () => {
      const migrated = { ...fixtureBundle('docA', 'h1'), anchors: { a1: { kind: 'point', point: [1, 2, 3], axis: [0, 0, 1], geom_hash: 'g1', created_by: 'f1' } as Anchor } }
      await bundleCachePut(migrated)
      // A late relay salvage carrying a different build for the same key must
      // not clobber the stored record: the if-absent write skips and reports false.
      const raw = fixtureBundle('docA', 'h1')
      expect(await bundleCachePutIfAbsent(raw)).toBe(false)
      const loaded = await bundleCacheGet('docA', 'h1')
      expect(loaded && loaded.anchors).toEqual(migrated.anchors)
    })

    it('also bounds the per-doc history to the newest three states', async () => {
      // The late-salvage path must obey the same history bound as a normal put,
      // or a doc under active edit could grow the cache without limit.
      await bundleCachePut(fixtureBundle('d', 'h1'))
      await bundleCachePut(fixtureBundle('d', 'h2'))
      await bundleCachePut(fixtureBundle('d', 'h3'))
      expect(await bundleCachePutIfAbsent(fixtureBundle('d', 'h4'))).toBe(true)
      expect(await readIndexKeys('d')).toEqual(['h2', 'h3', 'h4'])
      expect(await bundleCacheGet('d', 'h1')).toBeUndefined()
      expect(await bundleCacheGet('d', 'h4')).toBeDefined()
    })

    it('two concurrent if-absent writes race cleanly: the loser never clobbers the winner', async () => {
      // Fire both without awaiting between them so the transactions overlap.
      // IndexedDB serializes same-scope readwrite transactions, so the second
      // getKey observes the first commit and skips instead of overwriting it.
      const a = { ...fixtureBundle('docA', 'h1'), anchors: { a1: { kind: 'point', point: [1, 1, 1], axis: [0, 0, 1], geom_hash: 'ga', created_by: 'f1' } as Anchor } }
      const b = { ...fixtureBundle('docA', 'h1'), anchors: { b1: { kind: 'point', point: [2, 2, 2], axis: [0, 0, 1], geom_hash: 'gb', created_by: 'f1' } as Anchor } }
      const [first, second] = await Promise.all([bundleCachePutIfAbsent(a), bundleCachePutIfAbsent(b)])
      expect(first).toBe(true)
      expect(second).toBe(false)
      const loaded = await bundleCacheGet('docA', 'h1')
      expect(loaded && loaded.anchors).toEqual(a.anchors)
    })
  })

  it('a stored bundle with an older schema reads back as a miss', async () => {
    const bundle = { ...fixtureBundle('docA', 'h1'), schema: BUNDLE_SCHEMA - 1 }
    await bundleCachePut(bundle)
    expect(await bundleCacheGet('docA', 'h1')).toBeUndefined()
    expect(await bundleCacheHas('docA', 'h1')).toBe(false)
  })

  it('a record built by different code reads back as a miss; a matching fingerprint is a hit', async () => {
    await bundleCachePut(fixtureBundle('docA', 'h1'))
    expect(await bundleCacheGet('docA', 'h1')).toBeDefined()

    await overwriteBuiltBy('docA@h1', 'stale-build')

    // The record now carries a different fingerprint than the current build,
    // the exact state a deploy that changed geometry without a bump leaves
    // behind. Treat it as a miss so the caller cold-rebuilds.
    expect(await bundleCacheGet('docA', 'h1')).toBeUndefined()
    expect(await bundleCacheHas('docA', 'h1')).toBe(false)

    // Self-heal: the next put re-stamps the current fingerprint.
    await bundleCachePut(fixtureBundle('docA', 'h1'))
    expect(await bundleCacheGet('docA', 'h1')).toBeDefined()
  })

  it('evicts the least-recently-written doc once the cache holds more than MAX_DOCS docs', async () => {
    for (let i = 0; i < MAX_DOCS; i++) {
      await bundleCachePut(fixtureBundle(`doc-${i}`, 'h1'))
    }
    expect(await bundleCacheGet('doc-0', 'h1')).toBeDefined()

    await bundleCachePut(fixtureBundle('new-doc', 'h1'))

    // doc-0 is the least-recently-written: its keys leave both stores.
    expect(await bundleCacheGet('doc-0', 'h1')).toBeUndefined()
    expect(await readIndexKeys('doc-0')).toBeUndefined()
    // A non-LRU doc stays, and the most-recent doc stays.
    expect(await bundleCacheGet('doc-1', 'h1')).toBeDefined()
    expect(await bundleCacheGet('new-doc', 'h1')).toBeDefined()
    expect(await readIndexKeys('new-doc')).toEqual(['h1'])
  })

  it('two content states of the same doc_id coexist as separate entries', async () => {
    const v1 = fixtureBundle('docA', 'hA')
    const v2 = fixtureBundle('docA', 'hB')
    v2.bodies[0].mesh.indices = new Uint32Array([5, 6, 7])

    await bundleCachePut(v1)
    await bundleCachePut(v2)

    const loaded1 = await bundleCacheGet('docA', 'hA')
    const loaded2 = await bundleCacheGet('docA', 'hB')

    expect(loaded1).toBeDefined()
    expect(loaded2).toBeDefined()
    expect(loaded1!.content_hash).toBe('hA')
    expect(loaded2!.content_hash).toBe('hB')
    expect([...loaded1!.bodies[0].mesh.indices]).toEqual([0, 1, 2])
    expect([...loaded2!.bodies[0].mesh.indices]).toEqual([5, 6, 7])
  })

  it('different doc_ids at the same hash coexist', async () => {
    const a = fixtureBundle('docA', 'h1')
    const b = fixtureBundle('docB', 'h1')
    b.bodies[0].mesh.indices = new Uint32Array([9, 9, 9])

    await bundleCachePut(a)
    await bundleCachePut(b)

    const loadedA = await bundleCacheGet('docA', 'h1')
    const loadedB = await bundleCacheGet('docB', 'h1')

    expect([...loadedA!.bodies[0].mesh.indices]).toEqual([0, 1, 2])
    expect([...loadedB!.bodies[0].mesh.indices]).toEqual([9, 9, 9])
  })

  it('keeps the newest N content states insertion-ordered and evicts the oldest beyond N=3', async () => {
    await bundleCachePut(fixtureBundle('d', 'h1'))
    await bundleCachePut(fixtureBundle('d', 'h2'))
    await bundleCachePut(fixtureBundle('d', 'h3'))
    expect(await readIndexKeys('d')).toEqual(['h1', 'h2', 'h3'])
    expect(await bundleCacheGet('d', 'h4')).toBeUndefined()  // never cached

    await bundleCachePut(fixtureBundle('d', 'h4'))

    expect(await readIndexKeys('d')).toEqual(['h2', 'h3', 'h4'])
    expect(await bundleCacheGet('d', 'h1')).toBeUndefined()  // evicted: oldest beyond N=3
    expect(await bundleCacheGet('d', 'h2')).toBeDefined()
    expect(await bundleCacheGet('d', 'h3')).toBeDefined()
    expect(await bundleCacheGet('d', 'h4')).toBeDefined()
  })

  it('moves a re-put content state to the newest slot instead of duplicating it', async () => {
    await bundleCachePut(fixtureBundle('d', 'h1'))
    await bundleCachePut(fixtureBundle('d', 'h2'))
    await bundleCachePut(fixtureBundle('d', 'h1'))
    expect(await readIndexKeys('d')).toEqual(['h2', 'h1'])
    expect(await readBundleCount()).toBe(2)
  })

  it('hits after an undo: state A stays cached after state B is built', async () => {
    // The case a revision-keyed cache could not express. Edit A, edit B, undo to
    // A: the A hash was already built and is still inside the retained window.
    await bundleCachePut(fixtureBundle('d', 'hA'))
    await bundleCachePut(fixtureBundle('d', 'hB'))
    expect(await bundleCacheGet('d', 'hA')).toBeDefined()
  })

  it('mints exactly one bundle record for a burst of writes at one content state', async () => {
    // A11's failure mode: a per-edit mint. The cache is written once per solve,
    // and repeated puts of the same content hash dedupe to one record.
    for (let i = 0; i < 5; i++) await bundleCachePut(fixtureBundle('d', 'hA'))
    expect(await readBundleCount()).toBe(1)
    expect(await readIndexKeys('d')).toEqual(['hA'])
  })

  it('merges concurrent puts of one doc without losing a key', async () => {
    // The key list is a read-modify-write: a lost update would drop a key from
    // `latest` (leaving its bundle record unreachable and unprunable). Every put
    // runs in ONE readwrite transaction spanning both stores, and IndexedDB
    // serializes overlapping-scope transactions in creation order.
    await Promise.all([1, 2, 3, 4, 5].map(n => bundleCachePut(fixtureBundle('d', `h${n}`))))

    // The newest three survive pruning; the two oldest are gone from both stores.
    expect(await readIndexKeys('d')).toEqual(['h3', 'h4', 'h5'])
    expect(await bundleCacheGet('d', 'h1')).toBeUndefined()
    expect(await bundleCacheGet('d', 'h2')).toBeUndefined()
    expect(await bundleCacheGet('d', 'h3')).toBeDefined()
    expect(await bundleCacheGet('d', 'h4')).toBeDefined()
    expect(await bundleCacheGet('d', 'h5')).toBeDefined()
  })

  it('upgrades a pre-v3 database without throwing, and treats every pre-existing record as a miss', async () => {
    // Simulate a database left behind by the pre-C5 code: only the `bundles`
    // store exists, no `latest` store.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore('bundles', { keyPath: 'key' })
      }
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('bundles', 'readwrite')
        tx.objectStore('bundles').put({ key: 'docA@h1', payload: fixtureBundle('docA', 'h1') })
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })

    resetBundleDbConnection()

    // The module now opens at DB_VERSION 3, triggering the upgrade. A bundle
    // is a derivable artifact, so the migration is delete-and-rebuild: no
    // throw, and the old record reads back as a miss instead of being
    // backfilled into the new index.
    await expect(bundleCacheGet('docA', 'h1')).resolves.toBeUndefined()
    await expect(readIndexKeys('docA')).resolves.toBeUndefined()
  })

  describe('openDb robustness', () => {
    it('recovers on the next call after a failed open, without resetBundleDbConnection', async () => {
      // A broken factory poisons the open once; the module must drop the
      // rejected promise itself so later calls retry instead of replaying the
      // failure for the rest of the session.
      const real = globalThis.indexedDB
      globalThis.indexedDB = { open: () => { throw new Error('storage unavailable') } } as unknown as IDBFactory
      await expect(bundleCacheGet('docA', 'h1')).rejects.toThrow('storage unavailable')

      globalThis.indexedDB = real
      await bundleCachePut(fixtureBundle('docA', 'h1'))
      expect(await bundleCacheGet('docA', 'h1')).toBeDefined()
    })

    it('rejects fast while the upgrade is blocked by an older-version connection, then recovers once it closes', async () => {
      // Stand-in for a pre-deploy background tab holding an older version open:
      // the module's open cannot proceed until that connection closes.
      const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => {
          req.result.createObjectStore('bundles', { keyPath: 'key' })
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })

      // The blocked open must REJECT (unstick whatever awaited it), not hang.
      await expect(bundleCacheGet('nope', 'h1')).rejects.toThrow(/blocked/)

      blocker.close()
      await bundleCachePut(fixtureBundle('docA', 'h1'))
      expect(await bundleCacheGet('docA', 'h1')).toBeDefined()
    })

    it('closes the connection that resolves only after its open was abandoned (blocked-open zombie)', async () => {
      // Stand-in for a pre-deploy tab holding an older version open: the open
      // blocks, rejects fast, and the cached seam is cleared. Once the blocker
      // closes the blocked request settles via onsuccess with a connection
      // nobody holds -- the zombie. Count opens via the success event (the
      // module overwrites onsuccess, so a listener catches it) and every close,
      // then assert they balance.
      let opens = 0
      let closes = 0
      const origClose = IDBDatabase.prototype.close
      IDBDatabase.prototype.close = function (this: IDBDatabase) { closes++; return origClose.call(this) }
      const origOpen = indexedDB.open.bind(indexedDB)
      indexedDB.open = ((...args: Parameters<IDBFactory['open']>) => {
        const req = origOpen(...args)
        req.addEventListener('success', () => {
          // Only the module's opens matter; the v1 blocker is excluded.
          if (req.result.name === DB_NAME && req.result.version === UPGRADE_VERSION - 1) opens++
        })
        return req
      }) as typeof indexedDB.open

      const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => { req.result.createObjectStore('bundles', { keyPath: 'key' }) }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })

      await expect(bundleCacheGet('nope', 'h1')).rejects.toThrow(/blocked/)

      blocker.close()
      // The blocked open now settles through onsuccess (orphan) before work.
      await new Promise(r => setTimeout(r, 0))
      await bundleCachePut(fixtureBundle('docA', 'h1'))

      expect(closes).toBe(opens)  // every opened connection was also closed

      IDBDatabase.prototype.close = origClose
      indexedDB.open = origOpen
    })

    it('closes its connection when another party upgrades, letting the upgrade proceed', async () => {
      // Caches a live connection first.
      await bundleCachePut(fixtureBundle('docA', 'h1'))

      // An upgrader stuck on `blocked` would never settle and fail this test
      // on timeout; the module's onversionchange close must let it through.
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, UPGRADE_VERSION)
        req.onupgradeneeded = () => {}
        req.onsuccess = () => { req.result.close(); resolve() }
        req.onerror = () => reject(req.error)
        req.onblocked = () => reject(new Error('upgrade blocked: cached connection never closed'))
      })

      // The cached promise was dropped along with the closed connection, so
      // the next use attempts a genuine reopen. Its pinned DB_VERSION is older
      // than the upgraded database, which is exactly the VersionError a
      // pre-upgrade tab should see.
      try {
        await bundleCacheGet('docA', 'h1')
        expect.unreachable('expected a VersionError against the upgraded database')
      } catch (e) {
        expect((e as DOMException).name).toBe('VersionError')
      }
    })
  })
})
