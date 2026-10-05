/**
 * solveAssembly against the REAL mate solver WASM.
 *
 * `solveAssembly.test.ts` drives every mate case through `makeEchoSolver`, which
 * returns the seed params untouched. That leaves the encode -> WASM -> decode
 * chain unexercised: a wire-format or body-index bug there cannot fail any test,
 * and shows up in the app as a mate that simply never moves anything.
 *
 * Skips (rather than fails) when `sketch-solver/pkg-node` has not been built,
 * matching the other real-kernel harnesses.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { solveAssembly, encodeMateInput, type MateSpec } from './solveAssembly'
import { identity } from '@/__tests__/fixtures'
import { bundleCachePut, resetBundleDbConnection } from './bundleCache'
import { loadPkgNodeExport, PKG_MATE } from '../wasm-kernel/loadPkgNode'
import { BUNDLE_SCHEMA, type PartBundle } from './partBundle'
import { assemblyVerdict } from '../utils/core/assemblyStatus'
import { rotateVector } from '../utils/transform3d'
import type { MateKind, Transform3D } from '../types/cad'
import type { RelayService } from './worker/solverProtocol'

const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeReal = solveMate ? describe : describe.skip

function at(tx: number, ty: number, tz: number): Transform3D {
  return { tx, ty, tz, qx: 0, qy: 0, qz: 0, qw: 1 }
}

/** At the origin, rolled `deg` about world Z. */
function rollZ(deg: number): Transform3D {
  const half = (deg * Math.PI) / 360
  return { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: Math.sin(half), qw: Math.cos(half) }
}

/** A part whose single anchor is a plane at the local origin facing +Z. */
function planeBundle(doc_id: string, content_hash: string): PartBundle {
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

/** `planeBundle` with its one anchor's surface kind swapped. The Tangential
 *  row needs a cylinder on B: a plane/plane tangential can zero its residual by
 *  rotating B's normal, while plane/cylinder reads A's axis only and cannot. */
function bundleWithAnchor(kind: 'plane' | 'cylinder', doc_id: string, content_hash: string): PartBundle {
  const bundle = planeBundle(doc_id, content_hash)
  bundle.anchors = {
    face: {
      kind,
      point: [0, 0, 0],
      axis: [0, 0, 1],
      geom_hash: `@gdf|${kind}|0.000|0.000|0.000|0.000|0.000|1.000`,
      created_by: 'feat1',
    },
  }
  return bundle
}

const relay: RelayService = {
  requestPartDoc: async () => ({ kind: 'part', features: [] }),
  requestBuildBundle: async () => { throw new Error('should not build: bundles are pre-cached') },
}

const revs = { 'doc-a': '1', 'doc-b': '1' }

async function seedBundles(): Promise<void> {
  await bundleCachePut(planeBundle('doc-a', '1'))
  await bundleCachePut(planeBundle('doc-b', '1'))
}

function dist(t: Transform3D): number {
  return Math.hypot(t.tx, t.ty, t.tz)
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  resetBundleDbConnection()
  await seedBundles()
})

describeReal('solveAssembly with the real mate solver', () => {
  // The user-visible bug: author a fixed mate, nothing springs into place.
  it('a fixed mate pulls a free part onto one marked fixed', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: at(30, 40, 50) },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }]

    const result = await solveAssembly(parts, revs, mates, relay, solveMate!)

    expect(result.status.mates['m1'].stale).toBe(false)
    expect(result.status.mates['m1'].error).toBeUndefined()
    // The instance `fixed` pin is a soft residual, not a hard clamp, so `pa` drifts by
    // ~1e-6 rather than staying bit-exact at its seed.
    expect(dist(result.transforms['pa'])).toBeLessThan(0.001)
    // pb's anchor must land on pa's anchor, i.e. at the world origin.
    expect(dist(result.transforms['pb'])).toBeLessThan(0.01)
  })

  // An unsatisfiable-mate assembly has to tell the user instead of drawing the
  // least-squares compromise in silence. Two fixed mates demand incompatible
  // offsets (0 and 10 along A's axis) between the same pair, so no pose
  // satisfies both; the Rust solve returns the overconstrained verdict and a
  // positive residual, and the pure predicate turns that into a banner.
  it('reports an overconstrained verdict for conflicting fixed mates', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: at(30, 0, 0) },
    ]
    const mates = [
      { id: 'm1', kind: 'fixed' as const, offset: 0, ref_a: { part: 'pa', anchor: 'face' }, ref_b: { part: 'pb', anchor: 'face' } },
      { id: 'm2', kind: 'fixed' as const, offset: 10, ref_a: { part: 'pa', anchor: 'face' }, ref_b: { part: 'pb', anchor: 'face' } },
    ]

    const result = await solveAssembly(parts, revs, mates, relay, solveMate!)

    expect(result.status.verdict).toBe('overconstrained')
    expect(result.status.residualNorm).toBeGreaterThan(0)
    const mark = assemblyVerdict(result.status)
    expect(mark.failed).toBe(true)
    expect(mark.level).toBe('error')
    expect(mark.message).toContain('m1')
    expect(mark.message).toContain('m2')
  })

  it('leaves the fixed part exactly where it was placed', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: at(5, 5, 5), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: at(30, 0, 0) },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }]

    const result = await solveAssembly(parts, revs, mates, relay, solveMate!)

    expect(result.transforms['pa'].tx).toBeCloseTo(5, 3)
    expect(result.transforms['pb'].tx).toBeCloseTo(5, 2)
    expect(result.transforms['pb'].ty).toBeCloseTo(5, 2)
    expect(result.transforms['pb'].tz).toBeCloseTo(5, 2)
  })

  // Fixed means fixed: ORIENTATION as much as position. Nothing used to
  // assert this -- the test above checks `tx` only -- and the pin behind it is a
  // soft residual that can be outvoted, over a body whose rotation is the least
  // damped DOF in the system. `solveAssembly` now echoes a fixed part's seed
  // verbatim, so these are exact equalities, not tolerances: any drift at all,
  // in any configuration, is a bug, because `bakeSolvedTransforms` would write
  // it into the document and compound it on the next solve.
  it('leaves a fixed part bit-exact in ORIENTATION, not just position', async () => {
    // 30 degrees about X, so a drift in any rotational DOF shows.
    const seed: Transform3D = { tx: 2, ty: -3, tz: 4, qx: 0.2588190451025207, qy: 0, qz: 0, qw: 0.9659258262890683 }
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: seed, fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: at(30, 10, -5) },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
      angle: 45,
    }]

    const result = await solveAssembly(parts, revs, mates, relay, solveMate!)

    expect(result.transforms['pa']).toEqual(seed)
    // The free part still solves onto it: the pin is not achieved by refusing
    // to solve.
    expect(result.status.mates['m1'].error).toBeUndefined()
    expect(dist({ ...result.transforms['pb'], tx: result.transforms['pb'].tx - seed.tx, ty: result.transforms['pb'].ty - seed.ty, tz: result.transforms['pb'].tz - seed.tz })).toBeLessThan(0.01)
  })

  // The adversarial case for a soft pin: the mate CANNOT be satisfied by moving
  // anything free, because nothing is free. A least-squares optimum would split
  // the error across both pinned bodies and rotate them.
  it('holds both parts when two fixed parts are mated to each other', async () => {
    const seedA: Transform3D = at(0, 0, 0)
    const seedB: Transform3D = at(4, 0, 0)
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: seedA, fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: seedB, fixed: true },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
      angle: 90,
    }]

    const result = await solveAssembly(parts, revs, mates, relay, solveMate!)

    expect(result.transforms['pa']).toEqual(seedA)
    expect(result.transforms['pb']).toEqual(seedB)
  })

  // Nothing fixed is the default an assembly starts in: the user inserts two
  // parts and mates them without marking either fixed.
  it('with no fixed part the two still meet', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity() },
      { handle: 'pb', doc_id: 'doc-b', transform: at(30, 0, 0) },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }]

    const result = await solveAssembly(parts, revs, mates, relay, solveMate!)
    const a = result.transforms['pa']
    const b = result.transforms['pb']
    const gap = Math.hypot(a.tx - b.tx, a.ty - b.ty, a.tz - b.tz)
    expect(gap).toBeLessThan(0.01)
  })

  // The back-compat guarantee, end to end through the real WASM: a document
  // authored before `offset` became a vector must still solve to the identical
  // pose. Assembly documents are stored verbatim and never migrated, so a bare
  // number stays a legal authoring form forever.
  it('honours a legacy scalar offset along the mate axis', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: at(0, 0, 20) },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const, offset: 7,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }]

    const result = await solveAssembly(parts, revs, mates, relay, solveMate!)
    // pa's anchor axis is +Z, so pb sits 7 along it (sign per the residual).
    expect(Math.abs(result.transforms['pb'].tz)).toBeCloseTo(7, 2)
    // And nowhere else: a scalar offset moves along the axis only.
    expect(result.transforms['pb'].tx).toBeCloseTo(0, 2)
    expect(result.transforms['pb'].ty).toBeCloseTo(0, 2)
  })

  it('honours an off-axis offset vector', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: at(0, 0, 20) },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const, offset: { x: 3, y: 4, z: 2 },
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }]

    const result = await solveAssembly(parts, revs, mates, relay, solveMate!)
    // p_b = p_a - R_a * offset, and pa sits at identity, so pb is the negated
    // offset. The x and y components are what the scalar form could never say.
    expect(result.transforms['pb'].tx).toBeCloseTo(-3, 2)
    expect(result.transforms['pb'].ty).toBeCloseTo(-4, 2)
    expect(result.transforms['pb'].tz).toBeCloseTo(-2, 2)
  })

  // Pins the frame decision. The offset lives in body A's LOCAL frame, so
  // rotating A rotates the applied offset with it: a quarter turn about Z maps
  // the local (3, 4, 0) to the world (-4, 3, 0), putting pb at (4, -3, 0). A
  // world-frame offset would leave pb at (-3, -4, 0) regardless of A's pose,
  // so this test is what fails if the frame is ever switched.
  it('rotates the offset vector with body A (local frame, not world)', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: rollZ(90), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: at(0, 0, 20) },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const, offset: { x: 3, y: 4, z: 0 },
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }]

    const result = await solveAssembly(parts, revs, mates, relay, solveMate!)
    expect(result.transforms['pb'].tx).toBeCloseTo(4, 2)
    expect(result.transforms['pb'].ty).toBeCloseTo(-3, 2)
    expect(result.transforms['pb'].tz).toBeCloseTo(0, 2)
  })

  // The bug this file was written for: `solve_mate` called `std::time::Instant`,
  // which traps on wasm32. The trap was caught and the seed transforms echoed,
  // so a fixed mate silently did nothing and no test could see it. A trapping
  // solver must now name itself on the response and on every mate.
  it('reports a trapping solver rather than silently echoing the seed', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: at(30, 0, 0) },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }]
    const trapping = () => { throw new Error('unreachable') }

    const result = await solveAssembly(parts, revs, mates, relay, trapping)

    expect(result.status.verdict).toBe('failed')
    expect(result.status.error).toContain('unreachable')
    expect(result.status.mates['m1'].error).toContain('unreachable')
    // The scene still draws, at the placed seeds.
    expect(result.transforms['pb'].tx).toBe(30)
  })

  // Fixing a part must not shift the assembly in world space (the user reads
  // that as the camera jumping). With no part fixed the solver has translational
  // gauge freedom, so the meeting point floats. The UI fixes by first baking
  // every part's current solved pose into its seed, then flipping the flag: the
  // re-solve then starts from a zero-residual configuration and holds it. This
  // asserts the world poses are preserved across that toggle.
  it('fixing at the current solved pose leaves world positions put', async () => {
    // No part fixed: solve to the floating meeting point.
    const free = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity() },
      { handle: 'pb', doc_id: 'doc-b', transform: at(30, 0, 0) },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }]
    const first = await solveAssembly(free, revs, mates, relay, solveMate!)
    const a0 = first.transforms['pa']
    const b0 = first.transforms['pb']

    // Fix pa the way the UI does: bake the solved poses into the seeds, then
    // mark pa fixed. Re-solve and expect nothing to move.
    const pinned = [
      { handle: 'pa', doc_id: 'doc-a', transform: { ...a0 }, fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: { ...b0 } },
    ]
    const second = await solveAssembly(pinned, revs, mates, relay, solveMate!)
    const a1 = second.transforms['pa']
    const b1 = second.transforms['pb']

    expect(Math.hypot(a1.tx - a0.tx, a1.ty - a0.ty, a1.tz - a0.tz)).toBeLessThan(0.01)
    expect(Math.hypot(b1.tx - b0.tx, b1.ty - b0.ty, b1.tz - b0.tz)).toBeLessThan(0.01)
  })

  // The delete-mate bug: a part positioned only by a mate is drawn at its solved
  // pose while its doc seed still holds the far-away drop pose. Deleting the mate
  // re-solves with no constraint left, so the solver echoes that stale seed and
  // the part snaps back to the drop spot -- reading as the part vanishing. The UI
  // fix (bakeSolvedTransforms) writes the solved pose into the seed first; this
  // asserts both halves of that so a regression on either is caught.
  it('a deleted mate snaps a part back to its stale seed unless the pose is baked', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: at(300, 0, 0) },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }]
    // With the mate, pb solves onto pa at the origin, far from its drop seed.
    const mated = await solveAssembly(parts, revs, mates, relay, solveMate!)
    expect(dist(mated.transforms['pb'])).toBeLessThan(0.01)

    // Delete the mate, leaving the stale drop seed: pb springs back to (300,0,0).
    const stale = await solveAssembly(parts, revs, [], relay, solveMate!)
    expect(dist(stale.transforms['pb'])).toBeGreaterThan(100)

    // Bake the solved pose into pb's seed first (what the UI now does), then the
    // seed-echo holds the on-screen pose instead of teleporting the part.
    const baked = parts.map(p => p.handle === 'pb'
      ? { ...p, transform: { ...mated.transforms['pb'] } } : p)
    const settled = await solveAssembly(baked, revs, [], relay, solveMate!)
    expect(dist(settled.transforms['pb'])).toBeLessThan(0.01)
  })

  it('bakes the solved transform into the rendered vertices', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: at(30, 40, 50) },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }]

    const result = await solveAssembly(parts, revs, mates, relay, solveMate!)
    const v = result.bodies['pb'][0].vertices
    // Seeded 30,40,50 away; solved onto the origin, so vertex 0 is near it.
    expect(Math.hypot(v[0], v[1], v[2])).toBeLessThan(0.01)
  })

  it('locks the roll angle when a part is placed with a rotation', async () => {
    // Part A marked fixed at identity. Part B placed with a 45 deg roll about Z
    // and offset in position, and the mate authored with angle=45 -- what the
    // editor's capture writes when the refs are picked at this pose. The fixed
    // mate must pull B to A's position while holding the AUTHORED roll: the
    // 45 degrees survives because the document says so, not because the seed
    // happened to hold it (roll is absolute since the seed-state rework).
    const h = Math.sin(Math.PI / 8)
    const c = Math.cos(Math.PI / 8)
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: { tx: 5, ty: 10, tz: 15, qx: 0, qy: 0, qz: h, qw: c } },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const, angle: 45,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }]

    const result = await solveAssembly(parts, revs, mates, relay, solveMate!)
    const b = result.transforms['pb']

    // Position: B moved to A's origin
    expect(Math.abs(b.tx)).toBeLessThan(0.01)
    expect(Math.abs(b.ty)).toBeLessThan(0.01)
    expect(Math.abs(b.tz)).toBeLessThan(0.01)

    // Orientation: B's roll about Z holds at the authored ~45°
    const rollDeg = (2 * Math.atan2(b.qz, b.qw)) * 180 / Math.PI
    expect(Math.abs(rollDeg - 45)).toBeLessThan(1)
  })

  it('locks the roll after a large axis swing (the arbitrary-angle bug)', async () => {
    // Part A marked fixed with its anchor axis at world +Z (identity).
    // Part B rotated 90° about Y so its local Z axis points along world +X.
    // The fixed mate must swing B to align its axis with A's (+Z) AND lock the
    // resulting roll deterministically. A second solve from the same solved
    // seed must produce the identical transforms (no drift).
    const h90 = Math.sin(Math.PI / 4)
    const c90 = Math.cos(Math.PI / 4)
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: { tx: 3, ty: 7, tz: 11, qx: 0, qy: h90, qz: 0, qw: c90 } },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }]

    const r1 = await solveAssembly(parts, revs, mates, relay, solveMate!)
    const b1 = r1.transforms['pb']

    // Position: B moved toward A's origin (offset 0, axis +Z)
    expect(Math.abs(b1.tx)).toBeLessThan(0.01)
    expect(Math.abs(b1.ty)).toBeLessThan(0.01)
    expect(Math.abs(b1.tz)).toBeLessThan(0.01)

    // Orientation: B's local Z axis must now be world +Z
    // Rotate the local axis [0,0,1] by b1's quaternion: if the axis is +Z,
    // only qz and qw can be non-zero (pure Z-rotation).
    // Actually, after the swing, B's world Z = rotate_vec(q_b, [0,0,1]) ≈ [0,0,1]
    // This means q_b has no X or Y component when projecting onto Z.

    // Second solve: running from the solved seed must be a no-op (same transform)
    const parts2 = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: b1 },
    ]
    const r2 = await solveAssembly(parts2, revs, mates, relay, solveMate!)
    const b2 = r2.transforms['pb']

    // The transform must not drift between solves
    expect(Math.abs(b2.tx - b1.tx)).toBeLessThan(0.001)
    expect(Math.abs(b2.ty - b1.ty)).toBeLessThan(0.001)
    expect(Math.abs(b2.tz - b1.tz)).toBeLessThan(0.001)
    expect(Math.abs(b2.qx - b1.qx)).toBeLessThan(0.001)
    expect(Math.abs(b2.qy - b1.qy)).toBeLessThan(0.001)
    expect(Math.abs(b2.qz - b1.qz)).toBeLessThan(0.001)
    expect(Math.abs(b2.qw - b1.qw)).toBeLessThan(0.001)
  })

  it('applies the authored angle as the absolute roll', async () => {
    // Part A marked fixed at identity. Part B at identity, no pre-existing roll.
    // A 30° authored angle must produce a 30° roll about Z in B's solved pose.
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: identity() },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const, angle: 30,  // degrees
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }]

    const result = await solveAssembly(parts, revs, mates, relay, solveMate!)
    const b = result.transforms['pb']

    // Position at origin
    expect(Math.abs(b.tx)).toBeLessThan(0.01)
    expect(Math.abs(b.ty)).toBeLessThan(0.01)
    expect(Math.abs(b.tz)).toBeLessThan(0.01)

    // Roll about Z should be ~30°
    const rollDeg = (2 * Math.atan2(b.qz, b.qw)) * 180 / Math.PI
    expect(Math.abs(rollDeg - 30)).toBeLessThan(1.5)
  })

  // Regression: the JS layer must NOT bake the solved transforms into the
  // doc before a mate parameter edit.  If it did, the seed would
  // incorporate the previous solve's roll and the next solve would add the
  // new angle on top (30° + 60° = 90° instead of 60°).  This test
  // re-solves from the SAME seed with a fresh angle, the clean-seed
  // scenario that the JS no-bake discipline guarantees.
  it('a second solve from the same seed applies the angle absolutely, not incrementally', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: identity() },
    ]

    const r30 = await solveAssembly(parts, revs, [{
      id: 'm1', kind: 'fixed' as const, angle: 30,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }], relay, solveMate!)
    const b30 = r30.transforms['pb']
    const roll30 = (2 * Math.atan2(b30.qz, b30.qw)) * 180 / Math.PI
    expect(Math.abs(roll30 - 30)).toBeLessThan(1.5)

    // Second solve: same seed (identity), new angle 60.
    const r60 = await solveAssembly(parts, revs, [{
      id: 'm1', kind: 'fixed' as const, angle: 60,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }], relay, solveMate!)
    const b60 = r60.transforms['pb']
    const roll60 = (2 * Math.atan2(b60.qz, b60.qw)) * 180 / Math.PI
    expect(Math.abs(roll60 - 60)).toBeLessThan(1.5)
  })

  // The baking bug, now fixed solver-side: the roll reference is the anchors'
  // canonical frames (authored data), not the LM starting point, so a seed
  // contaminated with the previous solve's roll -- exactly what the drag
  // pointer-up bake writes -- no longer accumulates (30° baked + 60° authored
  // used to land at 90°). This test asserted the broken 90° until the rework.
  it('does not accumulate angle when the seed already holds the prior solve roll', async () => {
    const parts1 = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: identity() },
    ]
    const r30 = await solveAssembly(parts1, revs, [{
      id: 'm1', kind: 'fixed' as const, angle: 30,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }], relay, solveMate!)
    const b30 = r30.transforms['pb']

    // Seed is the 30° pose, exactly what the (now-removed) bake was doing.
    const parts2 = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', transform: b30 },
    ]
    const r60 = await solveAssembly(parts2, revs, [{
      id: 'm1', kind: 'fixed' as const, angle: 60,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }], relay, solveMate!)
    const b60 = r60.transforms['pb']
    const rollDeg = (2 * Math.atan2(b60.qz, b60.qw)) * 180 / Math.PI
    // Under the baking bug the roll landed at ~90° (30 baked + 60 applied).
    expect(Math.abs(rollDeg - 60)).toBeLessThan(5)
  })
})

// ─── every kind through the real WASM ───
//
// The rest of this file runs only `fixed`. Codes 2, 5, 6, 7 and 8 never reached
// the real solver in any test, so a reorder between MATE_KIND_TO_U8 and Rust's
// MateKind::from_u8 could solve one kind as a neighbouring one in total silence.
// Each row below asserts a kind-distinguishing property, and the rows are
// ordered to mirror a neighbour swap so an off-by-one fails two rows and names
// the kind in the assertion message.

const S0: Transform3D = at(0, 0, 10)
/** S0 rolled 30 degrees about Z, for the roll-reading rows. */
const S0r: Transform3D = { tx: 0, ty: 0, tz: 10, qx: 0, qy: 0, qz: Math.sin(Math.PI / 12), qw: Math.cos(Math.PI / 12) }
/** S0 pitched 40 degrees about X, so its local +Z sits off the world axis. */
const S0x: Transform3D = { tx: 0, ty: 0, tz: 10, qx: Math.sin(Math.PI / 9), qy: 0, qz: 0, qw: Math.cos(Math.PI / 9) }
/** Far away and rotated 90 about Y, so B's local +Z points at world +X. */
const S1: Transform3D = { tx: 3, ty: 4, tz: 5, qx: 0, qy: Math.sin(Math.PI / 4), qz: 0, qw: Math.cos(Math.PI / 4) }

/** Signed roll (degrees) about Z. Valid on the S0r rows, whose axis is +Z. */
function rollZDeg(t: Transform3D): number {
  return (2 * Math.atan2(t.qz, t.qw) * 180) / Math.PI
}

/** B's local +Z carried into world space by its solved transform. */
function worldZAround(t: Transform3D): [number, number, number] {
  return rotateVector([t.qx, t.qy, t.qz, t.qw], [0, 0, 1])
}

interface KindRow {
  kind: MateKind
  seed: Transform3D
  params?: Partial<Pick<MateSpec, 'offset' | 'ratio' | 'radius' | 'angle'>>
  anchorKindB?: 'plane' | 'cylinder'
  check: (t: Transform3D) => void
}

const kindRows: KindRow[] = [
  {
    kind: 'fixed', seed: S0r,
    check: (t) => {
      expect(dist(t)).toBeLessThan(0.01)
      expect(Math.abs(rollZDeg(t))).toBeLessThan(1)
    },
  },
  {
    kind: 'spherical', seed: S0x,
    check: (t) => {
      expect(dist(t)).toBeLessThan(0.01)
      const [sx, sy, sz] = worldZAround(S0x)
      const [ax, ay, az] = worldZAround(t)
      // Point-only: the off-axis frame is preserved. Any axis mate would pull
      // local +Z back to the world axis, which the +Z-aligned S0r seed could
      // not distinguish from "no orientation residual at all".
      expect(Math.hypot(ax - sx, ay - sy, az - sz)).toBeLessThan(0.01)
    },
  },
  {
    kind: 'parallel', seed: S1,
    check: (t) => {
      expect(Math.abs(t.tx - 3)).toBeLessThan(0.01)
      expect(Math.abs(t.ty - 4)).toBeLessThan(0.01)
      expect(Math.abs(t.tz - 5)).toBeLessThan(0.01)
      const [ax, ay, az] = worldZAround(t)
      // The dot residual is only quadratic near parallel, so LM stops a hair
      // short; far tighter than the ~1.4 an unswung +X axis would show.
      expect(Math.hypot(ax, ay, az - 1)).toBeLessThan(0.05)
    },
  },
  {
    kind: 'sliding', seed: S0r,
    check: (t) => {
      expect(Math.abs(t.tx)).toBeLessThan(0.01)
      expect(Math.abs(t.ty)).toBeLessThan(0.01)
      expect(Math.abs(t.tz - 10)).toBeLessThan(0.05)
      expect(Math.abs(rollZDeg(t))).toBeLessThan(1)
    },
  },
  {
    kind: 'rotating', seed: S0r,
    check: (t) => {
      expect(dist(t)).toBeLessThan(0.01)
      const [ax, ay, az] = worldZAround(t)
      expect(Math.hypot(ax, ay, az - 1)).toBeLessThan(0.01)
      expect(Math.abs(rollZDeg(t) - 30)).toBeLessThan(2)
    },
  },
  {
    kind: 'sliding_rotating', seed: S0r,
    check: (t) => {
      expect(Math.abs(t.tx)).toBeLessThan(0.01)
      expect(Math.abs(t.ty)).toBeLessThan(0.01)
      expect(Math.abs(t.tz - 10)).toBeLessThan(0.05)
      expect(Math.abs(rollZDeg(t) - 30)).toBeLessThan(2)
    },
  },
  {
    kind: 'tangential', seed: S0, anchorKindB: 'cylinder', params: { offset: 0 },
    check: (t) => {
      expect(Math.abs(t.tz)).toBeLessThan(0.02)
    },
  },
  {
    kind: 'copy_rotation', seed: S0, anchorKindB: 'cylinder', params: { ratio: 2 },
    check: (t) => {
      expect(Math.abs(t.tz - 10)).toBeLessThan(0.01)
    },
  },
  {
    kind: 'parallel_plane_distance', seed: S0, params: { offset: 5 },
    check: (t) => {
      expect(Math.abs(t.tz - 5)).toBeLessThan(0.05)
      const [ax, ay, az] = worldZAround(t)
      expect(Math.hypot(ax, ay, az - 1)).toBeLessThan(0.01)
    },
  },
]

describeReal('every mate kind solves as itself against the real mate solver', () => {
  for (const row of kindRows) {
    it(`solves ${row.kind} as ${row.kind}`, async () => {
      if (row.anchorKindB === 'cylinder') {
        await bundleCachePut(bundleWithAnchor('cylinder', 'doc-b', '1'))
      }
      const parts = [
        { handle: 'pa', doc_id: 'doc-a', transform: identity(), fixed: true },
        { handle: 'pb', doc_id: 'doc-b', transform: row.seed },
      ]
      const mates = [{
        id: 'm1', kind: row.kind,
        ref_a: { part: 'pa', anchor: 'face' },
        ref_b: { part: 'pb', anchor: 'face' },
        ...row.params,
      }]

      const result = await solveAssembly(parts, revs, mates, relay, solveMate!)
      expect(result.status.mates['m1'].error, `${row.kind} did not solve`).toBeUndefined()
      expect(result.status.mates['m1'].stale, `${row.kind} was marked stale`).toBe(false)
      row.check(result.transforms['pb'])
    })
  }

  it('a mate dropped for an absent body does not shift its neighbour residuals', async () => {
    // The first mate carries an inline anchor on a handle that names no loaded
    // part: the TS side encodes it (body index -1) rather than marking it stale,
    // and Rust drops it. The residual wire must keep one entry per input mate,
    // so the good mate's number cannot slide into the dropped slot.
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', transform: identity() },
      { handle: 'pb', doc_id: 'doc-b', transform: at(30, 0, 0) },
    ]
    const ghostInline = {
      kind: 'point' as const, point: [0, 0, 0] as [number, number, number],
      axis: [0, 0, 1] as [number, number, number], geom_hash: '', created_by: 'ghost',
    }
    const dropped = {
      id: 'dropped', kind: 'spherical' as const,
      ref_a: { part: 'ghost', anchor: 'ghost', inlineAnchor: ghostInline },
      ref_b: { part: 'pa', anchor: 'face' },
    }
    const good = {
      id: 'good', kind: 'spherical' as const,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }

    const withDropped = await solveAssembly(parts, revs, [dropped, good], relay, solveMate!)
    expect(withDropped.status.mates['dropped'].stale).toBe(false)
    expect(withDropped.status.mates['dropped'].residual).toBeUndefined()
    const goodResidual = withDropped.status.mates['good'].residual
    expect(goodResidual).toBeDefined()
    expect(goodResidual!).toBeLessThan(1e-4)

    const control = await solveAssembly(parts, revs, [good], relay, solveMate!)
    expect(control.status.mates['good'].residual!).toBeCloseTo(goodResidual!, 10)
  })

  // The wire-version handshake, not routed through solveAssembly: its zero-mate
  // fast path skips the WASM call. A one-mate buffer built by the TS encoder
  // must decode in Rust; a drifted MATE_MAGIC makes solve_mate_bytes throw.
  it('the TS input magic agrees with the real Rust decoder', () => {
    const params = new Float32Array(14)
    params[6] = 1
    params[13] = 1
    const fixedMask = new Uint8Array([0])
    const bytes = encodeMateInput(2, params, fixedMask, [{
      kindCode: 0,
      bodyA: 0, bodyB: 1,
      anchorKindA: 0, anchorKindB: 0,
      pointA: [0, 0, 0], axisA: [0, 0, 1],
      pointB: [0, 0, 0], axisB: [0, 0, 1],
      flip: false, offset: [0, 0, 0], ratio: 1, radius: 0, angle: 0,
      perpA: [0, 1, 0], perpB: [0, 1, 0], weight: 1,
    }])

    const output = solveMate!(bytes)
    expect(output.length).toBeGreaterThan(0)
  })
})
