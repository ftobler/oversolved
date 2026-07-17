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
import { solveAssembly } from './solveAssembly'
import { bundleCachePut, resetBundleDbConnection } from './bundleCache'
import { loadPkgNodeExport } from '../wasm-kernel/loadPkgNode'
import { BUNDLE_SCHEMA, type PartBundle } from './partBundle'
import type { Transform3D } from '../types/cad'
import type { RelayService } from './worker/anchorSolverWorker'

const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes')
const describeReal = solveMate ? describe : describe.skip

function identity(): Transform3D {
  return { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
}

function at(tx: number, ty: number, tz: number): Transform3D {
  return { tx, ty, tz, qx: 0, qy: 0, qz: 0, qw: 1 }
}

/** A part whose single anchor is a plane at the local origin facing +Z. */
function planeBundle(doc_id: string, doc_rev: number): PartBundle {
  return {
    doc_id,
    doc_rev,
    schema: BUNDLE_SCHEMA,
    bodies: [{
      mesh: {
        vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
        faceIdsPerTriangle: new Uint32Array([0]),
      },
      edges: [],
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

const revs = { 'doc-a': 1, 'doc-b': 1 }

async function seedBundles(): Promise<void> {
  await bundleCachePut(planeBundle('doc-a', 1))
  await bundleCachePut(planeBundle('doc-b', 1))
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
  it('a fixed mate pulls a free part onto a grounded one', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', doc_rev: 1, transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', doc_rev: 1, transform: at(30, 40, 50) },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }]

    const result = await solveAssembly(parts, revs, mates, relay, solveMate!)

    expect(result.mateResults['m1'].stale).toBe(false)
    expect(result.mateResults['m1'].error).toBeUndefined()
    // The grounded pin is a soft residual, not a hard clamp, so `pa` drifts by
    // ~1e-6 rather than staying bit-exact at its seed.
    expect(dist(result.transforms['pa'])).toBeLessThan(0.001)
    // pb's anchor must land on pa's anchor, i.e. at the world origin.
    expect(dist(result.transforms['pb'])).toBeLessThan(0.01)
  })

  it('leaves the grounded part exactly where it was placed', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', doc_rev: 1, transform: at(5, 5, 5), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', doc_rev: 1, transform: at(30, 0, 0) },
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

  // Nothing grounded is the default an assembly starts in: the user inserts two
  // parts and mates them without marking either fixed.
  it('with no grounded part the two still meet', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', doc_rev: 1, transform: identity() },
      { handle: 'pb', doc_id: 'doc-b', doc_rev: 1, transform: at(30, 0, 0) },
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

  it('honours a linear offset along the mate axis', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', doc_rev: 1, transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', doc_rev: 1, transform: at(0, 0, 20) },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const, offset: 7,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }]

    const result = await solveAssembly(parts, revs, mates, relay, solveMate!)
    // pa's anchor axis is +Z, so pb sits 7 along it (sign per the residual).
    expect(Math.abs(result.transforms['pb'].tz)).toBeCloseTo(7, 2)
  })

  // The bug this file was written for: `solve_mate` called `std::time::Instant`,
  // which traps on wasm32. The trap was caught and the seed transforms echoed,
  // so a fixed mate silently did nothing and no test could see it. A trapping
  // solver must now name itself on the response and on every mate.
  it('reports a trapping solver rather than silently echoing the seed', async () => {
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', doc_rev: 1, transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', doc_rev: 1, transform: at(30, 0, 0) },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }]
    const trapping = () => { throw new Error('unreachable') }

    const result = await solveAssembly(parts, revs, mates, relay, trapping)

    expect(result.solveError).toContain('unreachable')
    expect(result.mateResults['m1'].error).toContain('unreachable')
    // The scene still draws, at the placed seeds.
    expect(result.transforms['pb'].tx).toBe(30)
  })

  // Grounding a part must not shift the assembly in world space (the user reads
  // that as the camera jumping). With no part fixed the solver has translational
  // gauge freedom, so the meeting point floats. The UI grounds by first baking
  // every part's current solved pose into its seed, then flipping the flag: the
  // re-solve then starts from a zero-residual configuration and holds it. This
  // asserts the world poses are preserved across that toggle.
  it('grounding at the current solved pose leaves world positions put', async () => {
    // No part fixed: solve to the floating meeting point.
    const free = [
      { handle: 'pa', doc_id: 'doc-a', doc_rev: 1, transform: identity() },
      { handle: 'pb', doc_id: 'doc-b', doc_rev: 1, transform: at(30, 0, 0) },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }]
    const first = await solveAssembly(free, revs, mates, relay, solveMate!)
    const a0 = first.transforms['pa']
    const b0 = first.transforms['pb']

    // Ground pa the way the UI does: bake the solved poses into the seeds, then
    // mark pa fixed. Re-solve and expect nothing to move.
    const grounded = [
      { handle: 'pa', doc_id: 'doc-a', doc_rev: 1, transform: { ...a0 }, fixed: true },
      { handle: 'pb', doc_id: 'doc-b', doc_rev: 1, transform: { ...b0 } },
    ]
    const second = await solveAssembly(grounded, revs, mates, relay, solveMate!)
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
      { handle: 'pa', doc_id: 'doc-a', doc_rev: 1, transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', doc_rev: 1, transform: at(300, 0, 0) },
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
      { handle: 'pa', doc_id: 'doc-a', doc_rev: 1, transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', doc_rev: 1, transform: at(30, 40, 50) },
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
    // Part A grounded at identity. Part B placed with a 45 deg roll about Z
    // and offset in position. Both anchors are Z-up planes already aligned
    // (Z-rotation preserves the Z axis). The fixed mate with angle=0 must pull
    // B to A's position while preserving the seed-relative roll (B stays at 45°).
    const h = Math.sin(Math.PI / 8)
    const c = Math.cos(Math.PI / 8)
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', doc_rev: 1, transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', doc_rev: 1, transform: { tx: 5, ty: 10, tz: 15, qx: 0, qy: 0, qz: h, qw: c } },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed' as const,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'pb', anchor: 'face' },
    }]

    const result = await solveAssembly(parts, revs, mates, relay, solveMate!)
    const b = result.transforms['pb']

    // Position: B moved to A's origin
    expect(Math.abs(b.tx)).toBeLessThan(0.01)
    expect(Math.abs(b.ty)).toBeLessThan(0.01)
    expect(Math.abs(b.tz)).toBeLessThan(0.01)

    // Orientation: seed-relative roll is locked at 0 (angle=0), so the
    // absolute quaternion stays at the seed value.
    // B's roll about Z should remain ~45°
    const rollDeg = (2 * Math.atan2(b.qz, b.qw)) * 180 / Math.PI
    expect(Math.abs(rollDeg - 45)).toBeLessThan(1)
  })

  it('locks the roll after a large axis swing (the arbitrary-angle bug)', async () => {
    // Part A grounded with its anchor axis at world +Z (identity).
    // Part B rotated 90° about Y so its local Z axis points along world +X.
    // The fixed mate must swing B to align its axis with A's (+Z) AND lock the
    // resulting roll deterministically. A second solve from the same solved
    // seed must produce the identical transforms (no drift).
    const h90 = Math.sin(Math.PI / 4)
    const c90 = Math.cos(Math.PI / 4)
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', doc_rev: 1, transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', doc_rev: 1, transform: { tx: 3, ty: 7, tz: 11, qx: 0, qy: h90, qz: 0, qw: c90 } },
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
      { handle: 'pa', doc_id: 'doc-a', doc_rev: 1, transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', doc_rev: 1, transform: b1 },
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

  it('applies the authored angle offset to the seed-relative roll', async () => {
    // Part A grounded at identity. Part B at identity, no pre-existing roll.
    // A 30° authored angle must produce a 30° roll about Z in B's solved pose.
    const parts = [
      { handle: 'pa', doc_id: 'doc-a', doc_rev: 1, transform: identity(), fixed: true },
      { handle: 'pb', doc_id: 'doc-b', doc_rev: 1, transform: identity() },
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
})
