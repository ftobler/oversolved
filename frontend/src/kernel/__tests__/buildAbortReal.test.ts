// @vitest-environment node
//
// A solve stopped between two features through the production entry
// (`solveLocally`'s `shouldAbort`) must leave a partial cache the next solve
// resumes from: the same geometry as a cold solve, and no handle owned by
// anything the partial state does not name.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import {
  solveLocally,
  setSolveLocalsForTest,
  persistentTableForTest,
  lastBuildStateForTest,
  measureSolveFeatures,
} from '../solveLocally'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { RESTORE_OWNER } from '../builder'
import { SolveSuperseded } from '../errors'

const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(sketchId: string, w: number, h: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: { bottom: [0, 0, w, 0], right: [w, 0, w, h], top: [w, h, 0, h], left: [0, h, 0, 0] },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: h },
    ],
  }
}

function extrude(sketchId: string, id: string, distance: number): Record<string, unknown> {
  return { id, kind: 'extrude', sketch: '$' + sketchId, distance, direction: 'normal', operation: 'new' }
}

/** Six features: three rectangles, each extruded into its own body. */
function sixFeatureDoc(d1: number, d3: number): Record<string, unknown> {
  return {
    id: 'docAbort',
    features: [
      rectSketch('sk1', 10, 10), extrude('sk1', 'ex1', d1),
      rectSketch('sk2', 6, 6), extrude('sk2', 'ex2', 4),
      rectSketch('sk3', 3, 3), extrude('sk3', 'ex3', d3),
    ],
  }
}

/** Abort at the boundary after feature `index`. */
function abortAfter(index: number): () => boolean {
  let boundaries = 0
  return () => boundaries++ === index
}

async function totals(r: Awaited<ReturnType<typeof solveLocally>>): Promise<{ volume: number; faces: number }> {
  const measures = await measureSolveFeatures(r!)
  const last = measures![measures!.length - 1]
  const faces = Object.values(last.parts ?? {}).reduce((sum, p) => sum + p.faces, 0)
  return { volume: last.volume, faces }
}

/** Every owner a live handle carries, as a set. */
function liveOwners(): Set<string> {
  const owners = new Set<string>()
  for (const h of persistentTableForTest()!.liveHandles()) for (const o of h.owners) owners.add(o)
  return owners
}

describe.skipIf(!oc || !solveBytes)('a solve stopped between features (real OCC + Rust solver)', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSolveLocalsForTest(async () => oc)
  })

  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('resumes from the partial state to the cold result, stranding no owner', async () => {
    setSolveLocalsForTest(async () => oc)
    await solveLocally(sixFeatureDoc(5, 2))

    // Edit feature 1 and stop after feature 3: ex1..ex2 are rebuilt, sk3/ex3 are not.
    await expect(solveLocally(sixFeatureDoc(6, 2), { shouldAbort: abortAfter(2) }))
      .rejects.toBeInstanceOf(SolveSuperseded)
    const partial = lastBuildStateForTest()!
    expect(partial.feature_order).toEqual(['sk1', 'ex1', 'sk2', 'ex2', 'sk3', 'ex3'])
    expect(Object.keys(partial.checkpoints)).toEqual(['sk1', 'ex1', 'sk2', 'ex2'])

    // Only the kept checkpoints own anything: the outgoing tail was released at
    // build start, the restore copies at the stop.
    const kept = Object.keys(partial.checkpoints)
    const allowed = new Set(kept.flatMap((fid) => [fid, 'cp:' + fid]))
    expect([...liveOwners()].filter((o) => !allowed.has(o))).toEqual([])
    expect(persistentTableForTest()!.liveHandles().filter((h) => h.owners.length === 0)).toEqual([])

    // The next solve edits feature 5 and resumes at the first missing checkpoint.
    const resumed = await solveLocally(sixFeatureDoc(6, 7))
    expect(resumed!._build_state.checkpoints.ex2).toBe(partial.checkpoints.ex2)
    const order = new Set([...resumed!._build_state.feature_order, RESTORE_OWNER])
    expect([...liveOwners()].filter((o) => !order.has(o.replace(/^cp:/, '')))).toEqual([])
    const warm = await totals(resumed)

    setSolveLocalsForTest(async () => oc)
    const cold = await solveLocally(sixFeatureDoc(6, 7))
    const coldTotals = await totals(cold)
    expect(warm.volume).toBeCloseTo(coldTotals.volume, 6)
    expect(warm.volume).toBeCloseTo(10 * 10 * 6 + 6 * 6 * 4 + 3 * 3 * 7, 3)
    expect(warm.faces).toBe(coldTotals.faces)
  })

  it('a stop after the last feature leaves every checkpoint, and the next solve rebuilds nothing', async () => {
    setSolveLocalsForTest(async () => oc)
    await expect(solveLocally(sixFeatureDoc(5, 2), { shouldAbort: abortAfter(5) }))
      .rejects.toBeInstanceOf(SolveSuperseded)
    const partial = lastBuildStateForTest()!
    expect(Object.keys(partial.checkpoints)).toHaveLength(6)
    const r = await solveLocally(sixFeatureDoc(5, 2))
    // Every checkpoint is carried; the final one gains this build's mesh on a copy.
    for (const fid of partial.feature_order.slice(0, -1)) expect(r!._build_state.checkpoints[fid]).toBe(partial.checkpoints[fid])
    expect(r!._build_state.checkpoints.ex3.body_store_snapshot).toBe(partial.checkpoints.ex3.body_store_snapshot)
    expect(Object.keys(r!.bodies)).toHaveLength(3)
    expect((await totals(r)).volume).toBeCloseTo(10 * 10 * 5 + 6 * 6 * 4 + 3 * 3 * 2, 3)
  })

  // Step 4 of the plan: the cost of one macrotask per feature. Opt-in, since it
  // only prints a measurement: BUILD_ABORT_BENCH=1 npx vitest run buildAbortReal.
  it.skipIf(!process.env.BUILD_ABORT_BENCH)('measures the yield overhead on a 40-feature full rebuild', async () => {
    const doc = {
      id: 'docAbortBench',
      features: Array.from({ length: 20 }, (_, i) => [rectSketch(`s${i}`, 2 + i, 2 + i), extrude(`s${i}`, `e${i}`, 1 + i)]).flat(),
    }
    const time = async (abortable: boolean): Promise<number> => {
      const t0 = performance.now()
      await solveLocally(doc, { bypassCache: true, ...(abortable ? { shouldAbort: () => false } : {}) })
      return performance.now() - t0
    }
    setSolveLocalsForTest(async () => oc)
    await time(false)  // warm the kernel
    const plain: number[] = []
    const yielding: number[] = []
    for (let i = 0; i < 5; i++) {
      plain.push(await time(false))
      yielding.push(await time(true))
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    console.log(`[buildAbort bench] 40 features full rebuild: plain ${median(plain).toFixed(1)} ms, yielding ${median(yielding).toFixed(1)} ms`)
  })
})
