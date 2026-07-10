import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { bundleCacheGet, bundleCachePut, bundleCacheHas, resetBundleDbConnection } from './bundleCache'
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
})
