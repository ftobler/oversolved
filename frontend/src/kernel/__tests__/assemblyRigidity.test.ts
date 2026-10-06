/**
 * Rigid-mate exactness against the REAL mate solver WASM.
 *
 * The pre-existing real-WASM tests only ever asserted loose tolerances
 * (`dist < 0.01`, `toBeCloseTo(5, 2)`), so a weld could violate its own
 * constraint by a visible fraction of a millimetre and still pass. The user's
 * acceptance is ~0.0001 mm, which is what these rows pin, component by
 * component and in the roll. Skips when `mate-solver/pkg-node` is not built.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { solveAssembly, type MateSpec } from '../solveAssembly'
import { bundleCachePut, resetBundleDbConnection } from '../bundleCache'
import { loadPkgNodeExport, PKG_MATE } from '../../wasm-kernel/loadPkgNode'
import { BUNDLE_SCHEMA, type PartBundle } from '../partBundle'
import { canonicalPerp, rollAboutAxisDeg } from '../../utils/mateOrientation'
import { rotateVector, type Vec3 } from '../../utils/transform3d'
import type { Transform3D } from '../../types/cad'
import type { RelayService } from '../worker/solverProtocol'

const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeReal = solveMate ? describe : describe.skip

/** Acceptance tolerance the user set: ~0.0001 mm and 1e-4 rad. */
const TOL = 1e-4

const LOCAL_AXIS: Vec3 = [0, 0, 1]

/** A non-trivial grounded pose: translated and rolled about a diagonal axis. */
function tilted(): Transform3D {
  const h = Math.sin(Math.PI / 8)
  const c = Math.cos(Math.PI / 8)
  return { tx: 12, ty: -7, tz: 5, qx: h * 0.6, qy: h * 0.8, qz: 0, qw: c }
}

/** A part whose single anchor is a plane at the local origin facing +Z. */
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
        kind: 'plane',
        point: [0, 0, 0],
        axis: [0, 0, 1],
        geom_hash: '@gdf|0.000|0.000|0.000|0.000|0.000|1.000',
        created_by: 'feat1',
      },
    },
  }
}

const relay: RelayService = {
  requestPartDoc: async () => ({ kind: 'part', features: [] }),
  requestBuildBundle: async () => { throw new Error('should not build: bundles are pre-cached') },
}

const revs = { 'doc-a': '1', 'doc-b': '1', 'doc-c': '1' }

async function seedBundles(): Promise<void> {
  await bundleCachePut(planeBundle('doc-a'))
  await bundleCachePut(planeBundle('doc-b'))
  await bundleCachePut(planeBundle('doc-c'))
}

/** A local point carried into world space by a rigid transform. */
function worldPoint(t: Transform3D, p: Vec3): Vec3 {
  const r = rotateVector([t.qx, t.qy, t.qz, t.qw], p)
  return [r[0] + t.tx, r[1] + t.ty, r[2] + t.tz]
}

/** The world direction of the part's local +Z axis. */
function worldAxis(t: Transform3D): Vec3 {
  return rotateVector([t.qx, t.qy, t.qz, t.qw], LOCAL_AXIS)
}

/** Wrap an angle in radians into (-pi, pi], the solver's roll residual range. */
function wrapToPi(v: number): number {
  const d = ((v + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
  return d === -Math.PI ? Math.PI : d
}

/** The authored roll (rad) between the two parts' canonical frames at solve. */
function measuredRoll(a: Transform3D, b: Transform3D): number {
  // The wire perp is canonicalPerp(LOCAL axis), carried by each part's rotation.
  const aPerpW = rotateVector([a.qx, a.qy, a.qz, a.qw], canonicalPerp(LOCAL_AXIS))
  const bPerpW = rotateVector([b.qx, b.qy, b.qz, b.qw], canonicalPerp(LOCAL_AXIS))
  return (rollAboutAxisDeg(aPerpW, bPerpW, worldAxis(a)) * Math.PI) / 180
}

function maxAbs(v: Vec3): number {
  return Math.max(Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]))
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  resetBundleDbConnection()
  await seedBundles()
})

describeReal('rigid mate exactness with the real mate solver', () => {
  it('a fixed mate between a grounded and a free part holds to 1e-4', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: tilted(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: { tx: 40, ty: 40, tz: 40, qx: 0, qy: 0, qz: 0, qw: 1 } },
    ]
    const angle = 45
    const mates: MateSpec[] = [{
      id: 'm1', kind: 'fixed', angle,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }]

    const result = await solveAssembly(parts, revs, mates, relay, solveMate!)
    expect(result.status.mates['m1'].stale).toBe(false)

    const a = result.transforms['pa']
    const b = result.transforms['pb']

    // Point coincidence: both anchors sit at the local origin, so the world
    // translations must match componentwise.
    const pointGap = maxAbs(sub(worldPoint(b, [0, 0, 0]), worldPoint(a, [0, 0, 0])))
    expect(pointGap).toBeLessThanOrEqual(TOL)

    // Axis alignment: the local +Z axes must coincide (flip false).
    const axisGap = maxAbs(sub(worldAxis(b), worldAxis(a)))
    expect(axisGap).toBeLessThanOrEqual(TOL)

    // Roll about the shared axis holds the authored angle.
    const rollError = wrapToPi(measuredRoll(a, b) - (angle * Math.PI) / 180)
    expect(Math.abs(rollError)).toBeLessThanOrEqual(TOL)

    // The per-mate residual the solver reports rides the output wire and is
    // under the same tolerance the solved transforms show.
    expect(result.status.mates['m1'].residual).toBeDefined()
    expect(result.status.mates['m1'].residual!).toBeLessThan(TOL)
  })

  it('a rigid chain accumulates no more than 1e-4', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: tilted(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: { tx: 30, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } },
      { handle: 'pc', doc_id: 'doc-c', transform: { tx: 0, ty: 30, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } },
    ]
    const mates: MateSpec[] = [
      { id: 'mAB', kind: 'fixed', ref_a: { part: 'pa', anchor: 'face' }, ref_b: { part: 'pb', anchor: 'face' } },
      { id: 'mBC', kind: 'fixed', ref_a: { part: 'pb', anchor: 'face' }, ref_b: { part: 'pc', anchor: 'face' } },
    ]

    const result = await solveAssembly(parts, revs, mates, relay, solveMate!)
    const a = result.transforms['pa']
    const c = result.transforms['pc']

    // End to end: C's anchor lands on A's anchor, so the chain added no error.
    expect(maxAbs(sub(worldPoint(c, [0, 0, 0]), worldPoint(a, [0, 0, 0])))).toBeLessThanOrEqual(TOL)
    expect(maxAbs(sub(worldAxis(c), worldAxis(a)))).toBeLessThanOrEqual(TOL)

    expect(result.status.mates['mAB'].residual!).toBeLessThan(TOL)
    expect(result.status.mates['mBC'].residual!).toBeLessThan(TOL)
  })
})
