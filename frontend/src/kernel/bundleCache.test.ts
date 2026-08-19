import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { bundleCacheGet, bundleCachePut, bundleCacheHas, bundleCacheLatestRev, bundleCacheGetStale, resetBundleDbConnection, MAX_DOCS } from './bundleCache'
import { BUNDLE_SCHEMA, type PartBundle } from './partBundle'

function freshDb(): void {
  globalThis.indexedDB = new IDBFactory()
  resetBundleDbConnection()
}

// Rewrite a stored bundle record's built_by tag, simulating a record cached by
// a different build of the bundle-producing code.
async function overwriteBuiltBy(key: string, builtBy: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('oversolved-bundles')
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('bundles', 'readwrite')
      const st = tx.objectStore('bundles')
      const getReq = st.get(key)
      getReq.onsuccess = () => {
        st.put({ ...getReq.result, built_by: builtBy })
      }
      getReq.onerror = () => reject(getReq.error)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
    req.onerror = () => reject(req.error)
  })
}

// The whole rev list of a doc, which the module only exposes the maximum of.
async function readLatestRevs(doc_id: string): Promise<number[] | undefined> {
  return await new Promise((resolve, reject) => {
    const req = indexedDB.open('oversolved-bundles')
    req.onsuccess = () => {
      const db = req.result
      const getReq = db.transaction('latest', 'readonly').objectStore('latest').get(doc_id)
      getReq.onsuccess = () => { db.close(); resolve(getReq.result?.revs) }
      getReq.onerror = () => { db.close(); reject(getReq.error) }
    }
    req.onerror = () => reject(req.error)
  })
}

function fixtureBundle(doc_id: string, doc_rev: number): PartBundle {
  // Use small typed arrays so we can assert byte-level round-trip fidelity.
  return {
    doc_id,
    doc_rev,
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
    const bundle = fixtureBundle('docA', 1)
    await bundleCachePut(bundle)
    const loaded = await bundleCacheGet('docA', 1)
    expect(loaded).toBeDefined()
    expect(loaded!.doc_id).toBe('docA')
    expect(loaded!.doc_rev).toBe(1)
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
    const loaded = await bundleCacheGet('nope', 1)
    expect(loaded).toBeUndefined()
  })

  it('bundleCacheGetStale misses when nothing is cached', async () => {
    expect(await bundleCacheGetStale('nope', 1)).toBeUndefined()
  })

  it('bundleCacheGetStale reads a stale-schema bundle that bundleCacheGet treats as a miss', async () => {
    // The migration chain's read: a record the schema/fingerprint rules call a
    // miss must still serve its anchors, because anchorIdRemap matches by
    // geom_hash, which is schema-independent. Without it a schema bump would
    // destroy the remap chain and strand every persisted mate ref.
    const stale = { ...fixtureBundle('docA', 1), schema: BUNDLE_SCHEMA - 1 }
    await bundleCachePut(stale)
    expect(await bundleCacheGet('docA', 1)).toBeUndefined()
    expect(await bundleCacheGetStale('docA', 1)).toBeDefined()
    expect((await bundleCacheGetStale('docA', 1))!.schema).toBe(BUNDLE_SCHEMA - 1)
  })

  it('bundleCacheGetStale reads a record built by different code that bundleCacheGet misses', async () => {
    await bundleCachePut(fixtureBundle('docA', 1))
    await overwriteBuiltBy('docA@1', 'stale-build')
    expect(await bundleCacheGet('docA', 1)).toBeUndefined()
    expect(await bundleCacheGetStale('docA', 1)).toBeDefined()
  })

  it('bundleCacheGetStale returns the fresh bundle unchanged when the record is valid', async () => {
    await bundleCachePut(fixtureBundle('docA', 1))
    expect(await bundleCacheGetStale('docA', 1)).toBeDefined()
  })

  it('has returns false on a miss', async () => {
    expect(await bundleCacheHas('nope', 1)).toBe(false)
  })

  it('has returns true after put', async () => {
    const bundle = fixtureBundle('docA', 1)
    await bundleCachePut(bundle)
    expect(await bundleCacheHas('docA', 1)).toBe(true)
  })

  it('a stored bundle with an older schema reads back as a miss', async () => {
    const bundle = { ...fixtureBundle('docA', 1), schema: BUNDLE_SCHEMA - 1 }
    await bundleCachePut(bundle)
    expect(await bundleCacheGet('docA', 1)).toBeUndefined()
    expect(await bundleCacheHas('docA', 1)).toBe(false)
  })

  it('a record built by different code reads back as a miss; a matching fingerprint is a hit', async () => {
    await bundleCachePut(fixtureBundle('docA', 1))
    expect(await bundleCacheGet('docA', 1)).toBeDefined()

    await overwriteBuiltBy('docA@1', 'stale-build')

    // The record now carries a different fingerprint than the current build,
    // the exact state a deploy that changed geometry without a bump leaves
    // behind. Treat it as a miss so the caller cold-rebuilds.
    expect(await bundleCacheGet('docA', 1)).toBeUndefined()
    expect(await bundleCacheHas('docA', 1)).toBe(false)

    // Self-heal: the next put re-stamps the current fingerprint.
    await bundleCachePut(fixtureBundle('docA', 1))
    expect(await bundleCacheGet('docA', 1)).toBeDefined()
  })

  it('evicts the least-recently-written doc once the cache holds more than MAX_DOCS docs', async () => {
    for (let i = 0; i < MAX_DOCS; i++) {
      await bundleCachePut(fixtureBundle(`doc-${i}`, 1))
    }
    expect(await bundleCacheGet('doc-0', 1)).toBeDefined()

    await bundleCachePut(fixtureBundle('new-doc', 1))

    // doc-0 is the least-recently-written: its revs leave both stores.
    expect(await bundleCacheGet('doc-0', 1)).toBeUndefined()
    expect(await bundleCacheLatestRev('doc-0')).toBeUndefined()
    // A non-LRU doc stays, and the most-recent doc stays.
    expect(await bundleCacheGet('doc-1', 1)).toBeDefined()
    expect(await bundleCacheGet('new-doc', 1)).toBeDefined()
    expect(await bundleCacheLatestRev('new-doc')).toBe(1)
  })

  it('two revs of the same doc_id coexist as separate entries', async () => {
    const v1 = fixtureBundle('docA', 1)
    const v2 = fixtureBundle('docA', 2)
    v2.bodies[0].mesh.indices = new Uint32Array([5, 6, 7])

    await bundleCachePut(v1)
    await bundleCachePut(v2)

    const loaded1 = await bundleCacheGet('docA', 1)
    const loaded2 = await bundleCacheGet('docA', 2)

    expect(loaded1).toBeDefined()
    expect(loaded2).toBeDefined()
    expect(loaded1!.doc_rev).toBe(1)
    expect(loaded2!.doc_rev).toBe(2)
    expect([...loaded1!.bodies[0].mesh.indices]).toEqual([0, 1, 2])
    expect([...loaded2!.bodies[0].mesh.indices]).toEqual([5, 6, 7])
  })

  it('different doc_ids at same rev coexist', async () => {
    const a = fixtureBundle('docA', 1)
    const b = fixtureBundle('docB', 1)
    b.bodies[0].mesh.indices = new Uint32Array([9, 9, 9])

    await bundleCachePut(a)
    await bundleCachePut(b)

    const loadedA = await bundleCacheGet('docA', 1)
    const loadedB = await bundleCacheGet('docB', 1)

    expect([...loadedA!.bodies[0].mesh.indices]).toEqual([0, 1, 2])
    expect([...loadedB!.bodies[0].mesh.indices]).toEqual([9, 9, 9])
  })

  it('latestRev misses for a doc_id that was never cached', async () => {
    expect(await bundleCacheLatestRev('nope')).toBeUndefined()
  })

  it('tracks the latest cached rev per doc_id and evicts the oldest beyond N=3', async () => {
    await bundleCachePut(fixtureBundle('d', 1))
    await bundleCachePut(fixtureBundle('d', 5))
    await bundleCachePut(fixtureBundle('d', 9))

    expect(await bundleCacheLatestRev('d')).toBe(9)
    expect(await bundleCacheGet('d', 4)).toBeUndefined()  // never cached

    await bundleCachePut(fixtureBundle('d', 12))

    expect(await bundleCacheLatestRev('d')).toBe(12)
    expect(await bundleCacheGet('d', 1)).toBeUndefined()  // evicted: oldest beyond N=3
    expect(await bundleCacheGet('d', 5)).toBeDefined()
    expect(await bundleCacheGet('d', 9)).toBeDefined()
    expect(await bundleCacheGet('d', 12)).toBeDefined()
  })

  it('merges concurrent puts of one doc without losing a rev', async () => {
    // The rev list is a read-modify-write: a lost update would drop a rev from
    // `latest` (leaving its bundle record unreachable and unprunable). Every put
    // runs in ONE readwrite transaction spanning both stores, and IndexedDB
    // serializes overlapping-scope transactions in creation order, so the
    // interleaving cannot happen. Five overlapping puts, no awaits between them.
    await Promise.all([1, 2, 3, 4, 5].map(rev => bundleCachePut(fixtureBundle('d', rev))))

    // The newest three survive pruning; the two oldest are gone from both stores.
    expect(await readLatestRevs('d')).toEqual([3, 4, 5])
    expect(await bundleCacheLatestRev('d')).toBe(5)
    expect(await bundleCacheGet('d', 1)).toBeUndefined()
    expect(await bundleCacheGet('d', 2)).toBeUndefined()
    expect(await bundleCacheGet('d', 3)).toBeDefined()
    expect(await bundleCacheGet('d', 4)).toBeDefined()
    expect(await bundleCacheGet('d', 5)).toBeDefined()
  })

  it('upgrades a v1 database to v2 without throwing, and treats every pre-existing record as a miss', async () => {
    // Simulate a database left behind by the pre-Stage-F code: only the
    // `bundles` store exists, no `latest` store.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('oversolved-bundles', 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore('bundles', { keyPath: 'key' })
      }
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('bundles', 'readwrite')
        tx.objectStore('bundles').put({ key: 'docA@1', payload: fixtureBundle('docA', 1) })
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })

    resetBundleDbConnection()

    // The module now opens at DB_VERSION 2, triggering the upgrade. A bundle
    // is a derivable artifact, so the migration is delete-and-rebuild: no
    // throw, and the old record reads back as a miss instead of being
    // backfilled into the new `latest` index.
    await expect(bundleCacheGet('docA', 1)).resolves.toBeUndefined()
    await expect(bundleCacheLatestRev('docA')).resolves.toBeUndefined()
  })
})
