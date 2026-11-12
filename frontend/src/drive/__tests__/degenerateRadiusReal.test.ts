// @vitest-environment node
//
// The wasm-boundary guard for the enclosure practice finding: a sketch solve
// that reaches degenerate geometry must read as a red sketch, never as a kernel
// fault. The fixture is the re-created rounded rectangle with one arc driven
// through zero (the state the stale-length fillet produced). The Rust crate
// answers it with an overconstrained verdict, the area builder finishes, and
// `solve.lastError` stays null: no trap, no module reload.

import { createRequire } from 'node:module'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { setSketchSolver, setSketchTopology, solveSketch } from '@/kernel/features/sketch'
import { initGlobalRepo } from '@/kernel/query'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { runHeadless } from '../headlessOps'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { setOccLoader } from '@/kernel/solveLocally'

const solveBytes = loadSolver()
const topologyBytes = loadTopology()

function occInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('opencascade.js/dist/opencascade.wasm.js')
    return true
  } catch {
    return false
  }
}
const oc = occInstalled()

/** The re-created practice sketch: a 101 x 151 rounded rectangle (r9) whose
 *  stale side lengths are still 119 and 169, four dimensioned circles, and the
 *  two re-anchor distances. `pl`/`pb` stand in for the projected lines as
 *  whole-entity fixes, which pin the same eight params the projection mask
 *  does. The solve lands on the negative-radius arc the practice run trapped
 *  on. */
function degenerateSketch(): SketchFeature {
  return {
    id: 'sk1', kind: 'sketch', label: 'Degenerate lip', plane: '@builtin_plane_front',
    entities: [
      { id: 'pl', kind: 'line' }, { id: 'pb', kind: 'line' },
      { id: 'rb', kind: 'line' }, { id: 'rr', kind: 'line' },
      { id: 'rt', kind: 'line' }, { id: 'rl', kind: 'line' },
      { id: 'b1', kind: 'circle' }, { id: 'b2', kind: 'circle' },
      { id: 'b3', kind: 'circle' }, { id: 'b4', kind: 'circle' },
      { id: 'a1', kind: 'arc' }, { id: 'a2', kind: 'arc' },
      { id: 'a3', kind: 'arc' }, { id: 'a4', kind: 'arc' },
    ],
    initial: {
      pl: [-62.5, 75.5, -62.5, -75.5],
      pb: [-50.5, -87.5, 50.5, -87.5],
      rb: [-50.5, -84.5, 50.5, -84.5],
      rr: [59.5, -75.5, 59.5, 75.5],
      rt: [50.5, 84.5, -50.5, 84.5],
      rl: [-59.5, 75.5, -59.5, -75.5],
      b1: [-49.5, -74.5, 7], b2: [49.5, -74.5, 7],
      b3: [-49.5, 74.5, 7], b4: [49.5, 74.5, 7],
      a1: [-50.5, -75.5, 9, 180, 270], a2: [50.5, -75.5, 9, 270, 360],
      a3: [50.5, 75.5, 9, 0, 90], a4: [-50.5, 75.5, 9, 90, 180],
    },
    constraints: [
      { id: 'c1', kind: 'equal_length', a: '$rb', b: '$rt' },
      { id: 'c2', kind: 'equal_length', a: '$rr', b: '$rl' },
      { id: 'c3', kind: 'horizontal', target: '$rb' },
      { id: 'c4', kind: 'vertical', target: '$rr' },
      { id: 'c5', kind: 'length', target: '$rb', value: 119 },
      { id: 'c6', kind: 'length', target: '$rr', value: 169 },
      { id: 'c7', kind: 'radius', target: '$b1', value: 7 },
      { id: 'c8', kind: 'radius', target: '$b2', value: 7 },
      { id: 'c9', kind: 'radius', target: '$b3', value: 7 },
      { id: 'c10', kind: 'radius', target: '$b4', value: 7 },
      { id: 'c11', kind: 'line_distance', a: '$pl', b: '$b1center', value: 13 },
      { id: 'c12', kind: 'line_distance', a: '$pb', b: '$b1center', value: 13 },
      { id: 'c13', kind: 'line_distance', a: '$pl', b: '$b2center', value: 112 },
      { id: 'c14', kind: 'line_distance', a: '$pb', b: '$b2center', value: 13 },
      { id: 'c15', kind: 'line_distance', a: '$pl', b: '$b3center', value: 13 },
      { id: 'c16', kind: 'line_distance', a: '$pb', b: '$b3center', value: 162 },
      { id: 'c17', kind: 'line_distance', a: '$pl', b: '$b4center', value: 112 },
      { id: 'c18', kind: 'line_distance', a: '$pb', b: '$b4center', value: 162 },
      { id: 'c19', kind: 'coincident', a: '$rbstart', b: '$a1end' },
      { id: 'c20', kind: 'coincident', a: '$a1start', b: '$rlend' },
      { id: 'c21', kind: 'tangent', a: '$rb', b: '$a1' },
      { id: 'c22', kind: 'tangent', a: '$a1', b: '$rl' },
      { id: 'c23', kind: 'coincident', a: '$rbend', b: '$a2start' },
      { id: 'c24', kind: 'coincident', a: '$a2end', b: '$rrstart' },
      { id: 'c25', kind: 'tangent', a: '$rb', b: '$a2' },
      { id: 'c26', kind: 'tangent', a: '$a2', b: '$rr' },
      { id: 'c27', kind: 'coincident', a: '$rrend', b: '$a3start' },
      { id: 'c28', kind: 'coincident', a: '$a3end', b: '$rtstart' },
      { id: 'c29', kind: 'tangent', a: '$rr', b: '$a3' },
      { id: 'c30', kind: 'tangent', a: '$a3', b: '$rt' },
      { id: 'c31', kind: 'coincident', a: '$rtend', b: '$a4start' },
      { id: 'c32', kind: 'coincident', a: '$a4end', b: '$rlstart' },
      { id: 'c33', kind: 'tangent', a: '$rt', b: '$a4' },
      { id: 'c34', kind: 'tangent', a: '$a4', b: '$rl' },
      { id: 'c35', kind: 'line_distance', a: '$pl', b: '$rlstart', value: 3 },
      { id: 'c36', kind: 'line_distance', a: '$pb', b: '$rbstart', value: 3 },
      { id: 'c37', kind: 'fixed', target: '$pl' },
      { id: 'c38', kind: 'fixed', target: '$pb' },
    ],
  } as unknown as SketchFeature
}

describe.skipIf(!solveBytes)('a degenerate radius is a red sketch, not a kernel fault', () => {
  beforeAll(() => {
    setSketchSolver(solveBytes!)
    setSketchTopology(topologyBytes)
    if (oc) setOccLoader(loadOcc)
  })
  afterAll(() => {
    setSketchSolver(null)
    setSketchTopology(null)
  })

  it('solveSketch answers overconstrained and still returns topology', () => {
    const out = solveSketch(
      degenerateSketch() as unknown as Record<string, unknown>,
      initGlobalRepo(),
      {},
    )
    expect(out.status).toBe('overconstrained')
    // The area builder ran (and terminated) on the same signed radius.
    expect(out.topology).toBeDefined()
    const culprits = Object.entries(out.constraints ?? {})
      .filter(([, c]) => c.culprit)
      .map(([id]) => id)
    expect(culprits.length).toBeGreaterThan(0)
  })

  it.skipIf(!oc)('the headless solve reports the sketch, not a kernel fault', async () => {
    const doc: PartDoc = { features: [degenerateSketch()] }
    const run = await runHeadless({ doc, steps: [] })
    expect(run.solve.lastError).toBeNull()
    expect(run.features.some(problem => problem.id === 'sk1')).toBe(true)
  }, 180_000)
})
