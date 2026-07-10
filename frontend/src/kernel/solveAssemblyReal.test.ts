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
})
