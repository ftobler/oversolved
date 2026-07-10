import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { bundleCacheGet, bundleCachePut, bundleCacheHas, bundleCacheLatestRev, resetBundleDbConnection } from './bundleCache'
import { BUNDLE_SCHEMA, type PartBundle } from './partBundle'

function freshDb(): void {
  globalThis.indexedDB = new IDBFactory()
  resetBundleDbConnection()
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
