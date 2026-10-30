/**
 * The lever-arm half of the residual-honesty guarantee, against the REAL mate
 * solver WASM: an assembly whose mate anchor sits 400 mm from the part it is
 * anchored in, so the two ways of closing a point gap (move the body, or
 * rotate the one whose anchor is far from its origin) differ by six orders of
 * magnitude in cost. What `mate_residuals[i]` reports must equal the distance
 * between the anchors as the host poses them -- if it does not, the editor is
 * marking mates green against a pose nobody is looking at.
 *
 * Skips (rather than fails) when `mate-solver/pkg-node` has not been built,
 * matching the other real-kernel harnesses.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { solveAssembly, type MateSpec } from '../solveAssembly'
import { identity } from '@/__tests__/fixtures'
import { bundleCachePut, resetBundleDbConnection } from '../bundleCache'
import { loadPkgNodeExport, PKG_MATE } from '../../wasm-kernel/loadPkgNode'
import { BUNDLE_SCHEMA, type PartBundle } from '../partBundle'
import type { Transform3D } from '../../types/cad'
import type { RelayService } from '../worker/solverProtocol'

const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeReal = solveMate ? describe : describe.skip

function at(tx: number, ty: number, tz: number): Transform3D {
  return { tx, ty, tz, qx: 0, qy: 0, qz: 0, qw: 1 }
}

/** A part whose only anchor is a plane at `point`, facing +Z in local space. */
function planeBundle(doc_id: string, content_hash: string, anchorId: string, point: [number, number, number]): PartBundle {
  return {
    doc_id,
    content_hash,
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
      [anchorId]: {
        kind: 'plane',
        point,
        axis: [0, 0, 1],
        geom_hash: `@gdf|${doc_id}|${point.join('|')}`,
        created_by: 'feat1',
      },
    },
  }
}

const relay: RelayService = {
  requestPartDoc: async () => ({ kind: 'part', features: [] }),
  requestBuildBundle: async () => { throw new Error('should not build: bundles are pre-cached') },
}

const revs = { 'doc-a': '1', 'doc-b': '1' }

async function seedBundles(): Promise<void> {
  // pa's anchor is the lever: 400 mm from its own origin. pb's is at its
  // origin, so only pb's position and pa's (echoed) orientation decide where
  // the posed anchors end up.
  await bundleCachePut(planeBundle('doc-a', '1', 'far', [0, 400, 0]))
  await bundleCachePut(planeBundle('doc-b', '1', 'near', [0, 0, 0]))
}

function dist3(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  resetBundleDbConnection()
  await seedBundles()
})

describeReal('mate residuals agree with posed anchors at a 400 mm lever', () => {
  // The regression: the solver could close this 10 mm gap by rotating the
  // GROUNDED part -- its anchor is 400 mm from its origin, so a 0.025 rad
  // turn costs a quaternion-norm residual of ~1e-5 against a translation cost
  // of ~50 -- and the host then echoed that part's seed, leaving the shown
  // gap at 10 mm while the wire reported a mate that read as solved.
  it('reports the gap the posed anchors actually show', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: at(0, 410, 0) },
    ]
    const mates: MateSpec[] = [{
      id: 'm1',
      kind: 'fixed',
      ref_a: { part: 'pa', anchor: 'far' },
      ref_b: { part: 'pb', anchor: 'near' },
    }]

    const result = await solveAssembly(parts, revs, mates, relay, solveMate!)

    expect(result.status.mates['m1'].error).toBeUndefined()
    expect(result.status.verdict).toBe('fully_constrained')
    const residual = result.status.mates['m1'].residual
    expect(residual).toBeDefined()

    const pa = result.anchors['pa']['far'].point
    const pb = result.anchors['pb']['near'].point
    const gap = dist3(pa, pb)
    expect(gap).toBeLessThan(1e-9)
    expect(residual!).toBeLessThan(1e-9)
    expect(Math.abs(residual! - gap)).toBeLessThanOrEqual(1e-9 * Math.max(residual!, 1))
    // The grounded part is where it was placed, bit for bit: the solver never
    // had it as a parameter to move in the first place.
    expect(result.transforms['pa']).toEqual(identity())
  })

  // The same agreement with teeth in it: two mates demanding incompatible
  // offsets along z leave a residual that is NOT near zero (5 units each),
  // so "reported equals posed" is checked against a real number rather than
  // two coincident zeros.
  it('agrees at a non-zero residual when the mates conflict', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: at(0, 400, 0) },
    ]
    const mates: MateSpec[] = [
      { id: 'm1', kind: 'fixed', offset: 0, ref_a: { part: 'pa', anchor: 'far' }, ref_b: { part: 'pb', anchor: 'near' } },
      { id: 'm2', kind: 'fixed', offset: 10, ref_a: { part: 'pa', anchor: 'far' }, ref_b: { part: 'pb', anchor: 'near' } },
    ]

    const result = await solveAssembly(parts, revs, mates, relay, solveMate!)

    expect(result.status.verdict).toBe('overconstrained')
    const pa = result.anchors['pa']['far'].point
    const pb = result.anchors['pb']['near'].point
    const gap = dist3(pa, pb)
    // The least-squares compromise splits the 10 mm conflict down the middle,
    // and the residual must be that same number to six decimals: what the
    // anchor-biased polish leaves behind is ~1e-8 of a unit, five orders below
    // the gap itself, where the pre-manifold disagreement was the whole gap.
    expect(gap).toBeCloseTo(5, 6)
    for (const id of ['m1', 'm2']) {
      const residual = result.status.mates[id].residual
      expect(residual).toBeDefined()
      expect(Math.abs(residual! - gap)).toBeLessThanOrEqual(1e-6 * gap)
    }
  })
})
