/**
 * Mate seeding against the REAL mate solver: identity seeds are the norm
 * headlessly, and a face-to-face weld needs a half turn LM cannot find from
 * there. The closed-form seed (assemblySeed.ts) plus the solver's own
 * symmetry break must make such chains solve, and a consistent chain must not
 * move when a roughly placed part joins it.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { solveAssembly } from '../solveAssembly'
import { identity } from '@/__tests__/fixtures'
import { bundleCachePut, resetBundleDbConnection } from '../bundleCache'
import { loadPkgNodeExport, PKG_MATE } from '../../wasm-kernel/loadPkgNode'
import { BUNDLE_SCHEMA, type PartBundle } from '../partBundle'
import type { Transform3D } from '../../types/cad'
import type { RelayService } from '../worker/solverProtocol'

const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeReal = solveMate ? describe : describe.skip

function planeBundle(doc_id: string): PartBundle {
  return {
    doc_id,
    content_hash: '1',
    schema: BUNDLE_SCHEMA,
    bodies: [{
      mesh: {
        vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
        faceIdsPerTriangle: new Uint32Array([0]),
      },
      edges: [],
      entityAnchors: { faces: [], edges: [], vertices: [] },
    }],
    anchors: {
      face: {
        kind: 'plane', point: [0, 0, 5], axis: [0, 0, 1],
        geom_hash: '@gdf|0.000|0.000|5.000|0.000|0.000|1.000', created_by: 'feat1',
      },
    },
  }
}

const relay: RelayService = {
  requestPartDoc: async () => ({ kind: 'part', features: [] }),
  requestBuildBundle: async () => { throw new Error('should not build: bundles are pre-cached') },
}
const revs = { 'doc-a': '1', 'doc-b': '1', 'doc-c': '1' }

const weld = (id: string, a: string, b: string) => ({
  id, kind: 'fixed' as const, flip: true,
  ref_a: { part: a, anchor: 'face' }, ref_b: { part: b, anchor: 'face' },
})

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  resetBundleDbConnection()
  for (const id of ['doc-a', 'doc-b', 'doc-c']) await bundleCachePut(planeBundle(id))
})

describeReal('mate seeding with the real mate solver', () => {
  it('a flipped weld chain solves from identity seeds', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: identity() },
      { handle: 'pc', doc_id: 'doc-c', transform: identity() },
    ]
    const result = await solveAssembly(parts, revs, [weld('m1', 'pa', 'pb'), weld('m2', 'pb', 'pc')], relay, solveMate!)
    expect(result.status.verdict).toBe('fully_constrained')
    for (const id of ['m1', 'm2']) expect(result.status.mates[id].residual!).toBeLessThan(1e-6)
  })

  it('a welded part keeps its pose when a roughly seeded part joins', async () => {
    const base = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: identity() },
    ]
    const solved = await solveAssembly(base, revs, [weld('m1', 'pa', 'pb')], relay, solveMate!)
    const pb: Transform3D = solved.transforms['pb']
    const rough: Transform3D = { tx: 3, ty: -2, tz: 40, qx: 0.1, qy: 0, qz: 0, qw: Math.sqrt(1 - 0.01) }
    const parts = [
      base[0],
      { handle: 'pb', doc_id: 'doc-b', transform: pb },
      { handle: 'pc', doc_id: 'doc-c', transform: rough },
    ]
    const joined = await solveAssembly(parts, revs, [weld('m1', 'pa', 'pb'), weld('m2', 'pb', 'pc')], relay, solveMate!)
    const after = joined.transforms['pb']
    for (const k of ['tx', 'ty', 'tz', 'qx', 'qy', 'qz', 'qw'] as const) {
      expect(after[k]).toBeCloseTo(pb[k], 9)
    }
    expect(joined.status.verdict).toBe('fully_constrained')
  })
})
