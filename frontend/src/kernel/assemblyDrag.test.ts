// The drag objective: capture, the synthetic mate, and the solve through it.
//
// The pure parts (captureGrabPoint, dragTargetMate) run with no solver. The three
// behaviour tests run the REAL mate solver, the same harness solveAssemblyReal
// uses, and skip when `mate-solver/pkg-node` has not been built. They pin the two
// user-visible promises of the rework:
//   A. rigid, no stretch  -- an unreachable cursor returns the constrained pose
//   B. grab-point drag     -- a free part translates its grab point to the cursor,
//                             a revolute part turns its grab point toward it (a
//                             moment, not just translation)

import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { captureGrabPoint, dragTargetMate, dragTargetPoseMate, solveDragPose, DRAG_MATE_ID, DRAG_WEIGHT } from './assemblyDrag'
import { identity } from '@/__tests__/fixtures'
import { bundleCachePut, resetBundleDbConnection } from './bundleCache'
import { loadPkgNodeExport, PKG_MATE } from '../wasm-kernel/loadPkgNode'
import { BUNDLE_SCHEMA, type PartBundle, type Anchor } from './partBundle'
import { solveAssembly, type MateSpec } from './solveAssembly'
import type { Transform3D } from '../types/cad'
import type { RelayService } from './worker/anchorSolverWorker'
import { ASSEMBLY_ORIGIN_ID, ASSEMBLY_RIGHT_ID } from '../utils/assemblyBuiltins'
import { makeTransform, rotateVector, quatFromAxisAngle, type Vec3 } from '../utils/transform3d'

const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeReal = solveMate ? describe : describe.skip

/** Apply a rigid transform to a point, the world position of a local grab. */
function worldPoint(t: Transform3D, p: Vec3): Vec3 {
  const r = rotateVector([t.qx, t.qy, t.qz, t.qw], p)
  return [r[0] + t.tx, r[1] + t.ty, r[2] + t.tz]
}

/** A one-body part whose single anchor sits at the local origin along `axis`. */
function anchoredBundle(doc_id: string, axis: Vec3): PartBundle {
  const anchor: Anchor = {
    kind: 'circle', point: [0, 0, 0], axis, geom_hash: 'h', created_by: 'feat1',
  }
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
    anchors: { hub: anchor },
  }
}

const relay: RelayService = {
  requestPartDoc: async () => ({ kind: 'part', features: [] }),
  requestBuildBundle: async () => { throw new Error('should not build: bundles are pre-cached') },
}

const revs = { 'doc-free': '1', 'doc-slide': '1', 'doc-crank': '1' }

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  resetBundleDbConnection()
  await bundleCachePut(anchoredBundle('doc-free', [0, 0, 1]))
  await bundleCachePut(anchoredBundle('doc-slide', [1, 0, 0]))
  await bundleCachePut(anchoredBundle('doc-crank', [0, 0, 1]))
})

describe('captureGrabPoint', () => {
  it('is the identity map when the part sits at the origin', () => {
    expect(captureGrabPoint([3, 4, 5], identity())).toEqual([3, 4, 5])
  })

  it('undoes the part pose so the grab is expressed in the part frame', () => {
    // Part rotated 90 deg about Z then shifted: a world grab of (1,0,0) came from
    // a local point that, re-posed, lands back on the world grab.
    const q = quatFromAxisAngle([0, 0, 1], Math.PI / 2)
    const pose = makeTransform([2, 3, 0], q)
    const local = captureGrabPoint([1, 0, 0], pose)
    // Re-posing the captured local point must return the original world grab.
    expect(worldPoint(pose, local)[0]).toBeCloseTo(1, 9)
    expect(worldPoint(pose, local)[1]).toBeCloseTo(0, 9)
  })
})

describe('dragTargetMate', () => {
  it('is a spherical mate between the grab point and the world target', () => {
    const mate = dragTargetMate({ handle: 'p1', localGrab: [1, 2, 3], target: [4, 5, 6] })
    expect(mate.id).toBe(DRAG_MATE_ID)
    expect(mate.kind).toBe('spherical')
    expect(mate.ref_a.part).toBe('p1')
    expect(mate.ref_a.inlineAnchor?.point).toEqual([1, 2, 3])
    // ref_b rides the assembly frame (pinned at identity), so its point is world.
    expect(mate.ref_b.part).toBe('__assembly')
    expect(mate.ref_b.inlineAnchor?.point).toEqual([4, 5, 6])
    // The soft weight is what makes it yield to the real mates.
    expect(mate.weight).toBe(DRAG_WEIGHT)
  })
})

describe('dragTargetPoseMate', () => {
  it('is a weighted fixed mate whose target is the given pose', () => {
    const target = makeTransform([3, -2, 1], quatFromAxisAngle([0, 0, 1], Math.PI / 3))
    const mate = dragTargetPoseMate('p1', target)
    expect(mate.kind).toBe('fixed')
    expect(mate.ref_a.part).toBe('__assembly')
    expect(mate.ref_b.part).toBe('p1')
    expect(mate.weight).toBe(DRAG_WEIGHT)
  })
})

describeReal('dragTargetPoseMate through the real mate solver', () => {
  it('lands the part bit-close on the pose the geometry was derived for', async () => {
    const target = makeTransform([3, -2, 1], quatFromAxisAngle([0, 0, 1], Math.PI / 3))
    const mate = dragTargetPoseMate('p1', target)

    // Author the same target at full weight: with no real mates, the objective's
    // curvature dwarfs the solver's tiny seed anchor, so the part must land
    // bit-close on the pose the geometry was derived for. This validates the
    // encoding (point, axis and authored roll), independently of the soft drag
    // weight.
    const parts = [{ handle: 'p1', doc_id: 'doc-free', transform: identity() }]
    const res = await solveAssembly(parts, revs, [{ ...mate, weight: 1 }], relay, solveMate!)
    const t = res.transforms['p1']
    for (const k of ['tx', 'ty', 'tz', 'qx', 'qy', 'qz', 'qw'] as const) {
      expect(Math.abs(t[k] - target[k])).toBeLessThan(1e-3)
    }
  })
})

describeReal('solveDragPose through the real mate solver', () => {
  // Change B (translation): a FREE part grabbed off its origin must translate so
  // the grabbed POINT lands under the cursor, and it must get there by sliding,
  // not by rotating (translation is the default priority).
  it('translates a free part so its grab point reaches the cursor', async () => {
    const parts = [{ handle: 'p1', doc_id: 'doc-free', transform: identity() }]
    const localGrab: Vec3 = [0, 3, 0]  // off the origin
    const target: Vec3 = [5, 8, 0]

    const res = await solveDragPose(parts, revs, [], { handle: 'p1', localGrab, target }, relay, solveMate!)

    const t = res.transforms['p1']
    const grab = worldPoint(t, localGrab)
    expect(grab[0]).toBeCloseTo(5, 1)
    expect(grab[1]).toBeCloseTo(8, 1)
    // Reached by translation, not a turn: the quaternion stays near identity.
    expect(t.qw).toBeGreaterThan(0.98)
  })

  // Change A (rigid, no stretch): a part on a slider dragged OFF its axis cannot
  // put the grab point at the cursor. The solved pose is the nearest the slider
  // allows, and crucially NOT the raw cursor -- the part never detaches.
  it('holds a slider part on its axis instead of stretching to the cursor', async () => {
    const parts = [{ handle: 'p1', doc_id: 'doc-slide', transform: identity() }]
    // Slider along world X: the part's hub axis (+X) welded parallel to the
    // assembly Right plane's normal (+X), pinned through the origin.
    const mates: MateSpec[] = [{
      id: 'm1', kind: 'sliding',
      ref_a: { part: '__assembly', anchor: ASSEMBLY_RIGHT_ID },
      ref_b: { part: 'p1', anchor: 'hub' },
    }]
    const localGrab: Vec3 = [0, 2, 0]  // rides 2 above the slide axis
    const target: Vec3 = [5, 8, 0]     // 8 in Y is unreachable on an X slider

    const res = await solveDragPose(parts, revs, mates, { handle: 'p1', localGrab, target }, relay, solveMate!)

    const t = res.transforms['p1']
    const grab = worldPoint(t, localGrab)
    // X slides toward the cursor; Y stays on the slider. The soft drag mate is
    // outvoted on the unreachable Y, which is the whole point -- the part never
    // detaches to chase the raw cursor, it settles on the axis the constraint
    // allows.
    expect(grab[0]).toBeGreaterThan(2)
    // The slider holds to the user's tolerance, not the old 1 mm slack: the
    // grab point rides 2 above the axis, exactly.
    expect(Math.abs(grab[1] - 2)).toBeLessThanOrEqual(1e-4)
    expect(Math.abs(grab[1] - 8)).toBeGreaterThan(4)  // never the raw target
    // And the roll about Z did not drift (the broken solve turned ~75 deg): the
    // sliding mate pins all three rotational DOF.
    const rollZ = 2 * Math.atan2(t.qz, t.qw)
    expect(Math.abs(rollZ)).toBeLessThanOrEqual(1e-4)
  })

  // Drop fidelity: with the drag objective removed, re-solving from the dropped
  // pose must be a no-op. Before the weighting the part jumped 2.59 mm and 75
  // deg at pointer-up, because the soft objective and the real mates traded at
  // equal weight.
  it('the committed pose equals the dropped pose within 1e-4', async () => {
    const parts = [{ handle: 'p1', doc_id: 'doc-slide', transform: identity() }]
    const mates: MateSpec[] = [{
      id: 'm1', kind: 'sliding',
      ref_a: { part: '__assembly', anchor: ASSEMBLY_RIGHT_ID },
      ref_b: { part: 'p1', anchor: 'hub' },
    }]
    const localGrab: Vec3 = [0, 2, 0]
    const target: Vec3 = [5, 8, 0]

    const dragRes = await solveDragPose(parts, revs, mates, { handle: 'p1', localGrab, target }, relay, solveMate!)
    const dropped = dragRes.transforms['p1']

    // The commit path bakes the dropped pose into the seed, then cold-solves the
    // real mates alone. That solve must not move the part.
    const bakedParts = [{ ...parts[0], transform: dropped }]
    const commitRes = await solveAssembly(bakedParts, revs, mates, relay, solveMate!)
    const committed = commitRes.transforms['p1']

    for (const k of ['tx', 'ty', 'tz', 'qx', 'qy', 'qz', 'qw'] as const) {
      expect(Math.abs(committed[k] - dropped[k])).toBeLessThanOrEqual(1e-4)
    }
  })

  // Change B (moment): a revolute part (pinned pivot, free spin about Z) grabbed
  // at its rim and dragged tangentially must TURN -- translation is spent, so the
  // drag injects a rotation, which is what turning a crank wheel needs.
  it('turns a revolute part when its rim is dragged tangentially', async () => {
    const parts = [{ handle: 'p1', doc_id: 'doc-crank', transform: identity() }]
    // Revolute about Z through the origin: hub point pinned, hub axis (+Z) aligned.
    const mates: MateSpec[] = [{
      id: 'm1', kind: 'rotating',
      ref_a: { part: '__assembly', anchor: ASSEMBLY_ORIGIN_ID },
      ref_b: { part: 'p1', anchor: 'hub' },
    }]
    const localGrab: Vec3 = [10, 0, 0]  // a point on the rim, radius 10
    const target: Vec3 = [7, 7, 0]      // tangential pull, ~45 deg around

    const res = await solveDragPose(parts, revs, mates, { handle: 'p1', localGrab, target }, relay, solveMate!)

    const t = res.transforms['p1']
    // The part turned about Z: a real angle change, not a translation.
    const angle = 2 * Math.atan2(t.qz, t.qw) * 180 / Math.PI
    expect(angle).toBeGreaterThan(20)
    // The hub stayed pinned at the origin (translation is spent, so it is a spin).
    expect(Math.hypot(t.tx, t.ty)).toBeLessThan(0.1)
    // And the grab point swung toward the cursor's bearing.
    const grab = worldPoint(t, localGrab)
    expect(grab[1]).toBeGreaterThan(3)
  })
})
