// @vitest-environment node
//
// Regression guard for the Worker freeze-check finding: solveLocally must AWAIT
// the Rust sketch solver before build() runs. build() solves sketches
// synchronously, so a fire-and-forget (`void initSketchSolver()`) load races the
// first solve and every sketch throws "Rust solver not initialised" -- the live
// browser path produced empty bodies until this was fixed. The mock hands the
// solver its bytes only AFTER the solve has started; if solveLocally awaited the
// load the sketch solves, if it did not the sketch raises and bodies are empty.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'

// Deferred controller so the test decides when the "async wasm load" resolves.
const ctl = vi.hoisted(() => {
  let resolve: (b: unknown) => void = () => {}
  const promise = new Promise<unknown>((r) => { resolve = r })
  return { resolve: (b: unknown) => resolve(b), promise }
})
vi.mock('@/wasm-kernel/solverWasm', () => ({
  loadSolverWasm: vi.fn(() => ctl.promise),
  // The area builder shares the wasm module; this test drives only the solver,
  // so topology resolves to null (solveSketch falls back to TS detectTopology).
  loadTopologyWasm: vi.fn(() => Promise.resolve(null)),
  resetSolverWasm: vi.fn(),
}))

const { solveLocally, setSolveLocalsForTest } = await import('../solveLocally')
const { resetSketchSolver } = await import('../features/sketch')

const oc = await loadOcc()
const nodeBytes = loadSolver()

function rectSketch(sketchId: string, w: number, h: number, plane = '@builtin_plane_front') {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane,
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

function extrude(sketchId: string, id: string, distance: number, operation = 'add'): Record<string, unknown> {
  return { id, kind: 'extrude', sketch: '$' + sketchId, distance, direction: 'normal', operation }
}

describe.skipIf(!oc || !nodeBytes)('solveLocally awaits the sketch solver', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSolveLocalsForTest(async () => oc)  // inject OCC; leaves the mocked Rust load pending
  })
  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('does not race build() ahead of the async Rust solver load', async () => {
    const doc = { id: 'race', features: [rectSketch('sk1', 10, 10), extrude('sk1', 'ex1', 5)] }
    const pending = solveLocally(doc)
    // The solve has started and suspended on the solver load; hand it the bytes
    // only now, mimicking the browser's async wasm arriving mid-solve.
    ctl.resolve(nodeBytes)
    const r = await pending

    expect(r).not.toBeNull()
    const result = r!.result as Record<string, { status?: string; exception?: string }>
    // The sketch solved -- it was NOT skipped with "Rust solver not initialised".
    expect(result.sk1.exception).toBeUndefined()
    expect(result.ex1.exception).toBeUndefined()
    // And the extrude produced a body (a box: 24 verts / 12 tris).
    expect(Object.keys(r!.bodies)).toHaveLength(1)
  })
})
