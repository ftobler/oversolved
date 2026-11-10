// @vitest-environment node
//
// The drive-level featureDeltas row over the spline-trimmed hole body. Every
// checkpoint measure is a GProp read, so the row's volumeDelta is where the
// default rule's error looked largest: on the plan's larger resin-mold part
// the hole's removal came out 0.11 short (this smaller fixture measures 0.045
// short). The row is now built from volumeForMeasure (occ/volume.ts), which is
// eps for this all-analytic body and GK where a BSPLINE surface is present;
// this pins the row against the analytic removal.
//
// Skips when OCC.js or the sketch solver is absent, like the other real gates.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { runHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import type { FeatureDelta } from '../featureDeltas'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { nonSketchProblems } from './buildProblems'
import { analyticHoleRemoval } from '@/kernel/occ/__tests__/splineTrimBody'

function occInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('opencascade.js/dist/opencascade.wasm.js')
    return true
  } catch {
    return false
  }
}

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}
const ready = oc && solveBytes

const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

// The same body as the kernel-level fixture (occ/__tests__/splineTrimBody.ts),
// authored through the drive mutations so the featureDeltas pipeline sees
// ordinary document features.
function splineTrimSteps(): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
    m({ type: 'add_rect', featureId: 'sk1', p0: [-60, -20], p1: [60, 20] }),
    m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 13, operation: 'new' }),
    m({ type: 'add_plane', featureId: 'plp', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 13 } }),
    m({ type: 'add_sketch', featureId: 'skax', plane: '@plp' }),
    m({ type: 'add_entity', featureId: 'skax', kind: 'line', params: [-50, 0, 50, 0], entityId: 'ax' }),
    m({ type: 'add_sketch', featureId: 'skprof', plane: '@plp' }),
    m({ type: 'add_rect', featureId: 'skprof', p0: [-30, 0], p1: [30, 10] }),
    m({ type: 'add_revolve', featureId: 'rev1', sketchQuery: '$skprof', angle: 360, axis: '@skax/ax', operation: 'cut' }),
    m({ type: 'add_plane', featureId: 'plh', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: -20 } }),
    m({ type: 'add_sketch', featureId: 'skh', plane: '@plh' }),
    m({ type: 'add_entity', featureId: 'skh', kind: 'point', params: [0, -6.5], entityId: 'site' }),
    m({
      type: 'add_hole', featureId: 'ho1', sketch: '@skh', diameter: 6, depth_mode: 'blind',
      depth: 20, direction: 'normal', target: '@body_ex1',
    }),
  ]
}

function row(result: { featureDeltas: FeatureDelta[] | null }, id: string): FeatureDelta {
  const found = result.featureDeltas?.find(candidate => candidate.id === id)
  expect(found, `no featureDeltas row for ${id}`).toBeDefined()
  return found!
}

describe.skipIf(!ready)('the spline-trimmed hole\'s featureDeltas row (real OCC)', () => {
  it('reports the analytic removal, not the integrator\'s error', async () => {
    const built = await runHeadless({ doc: emptyDriveDoc(), steps: splineTrimSteps(), featureDeltas: 'all' })
    expect(built.ok).toBe(true)
    expect(nonSketchProblems(built.features)).toEqual([])
    const hole = row(built, 'ho1')
    expect(hole.status).toBe('ok')
    const removed = -hole.volumeDelta
    const analytic = analyticHoleRemoval(1)
    expect(Math.abs(removed - analytic)).toBeLessThanOrEqual(1e-6 * analytic)
  }, 240_000)
})
