// @vitest-environment node
//
// `add_constraint colinear` through the drive, against the real solver. The
// kind is lowered to the solver's coincident rows (wasm-kernel/partDocToSketches)
// while the document keeps `kind: colinear`, so the tile, the undo label and the
// author's intent survive. Before the lowering the kind was inert: the sketch
// reported two free DOF and the line never reached the reference line
// (mcp-practice run drawing__base_fillets_rounds_r10.png, report F1).
//
// A free line colinear with a pinned bottom edge is the run's repro with the
// projected edge spelled as an ordinary constrained one, so no projection needs
// a B-rep to resolve. Gated like the other real-kernel drive suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import { featureById } from '@/testing/featureAccess'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { nonSketchProblems } from './buildProblems'

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

// A fixed-as-possible bottom edge: start pinned, horizontal, 9 long. Four rows
// for its four params, so the colinear pair is what constrains the free line.
function reproSteps(colinearTargets: string[]): ScriptStep[] {
  return [
    { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 9, 0], entityId: 'pb' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [2, 0.3, 5, 0.1], entityId: 'l1' } },
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'fixed', targets: ['vertex:sk1:pb:start'] } },
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'horizontal', targets: ['entity:sk1:pb'] } },
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'length', targets: ['entity:sk1:pb'], value: 9 } },
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'colinear', targets: colinearTargets } },
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'length', targets: ['entity:sk1:l1'], value: 4 } },
    {
      mutation: {
        type: 'add_constraint', featureId: 'sk1', kind: 'point_distance_x',
        targets: ['vertex:sk1:pb:start', 'vertex:sk1:l1:start'], value: 2.5, sign: 1,
      },
    },
  ]
}

function solvedLine(doc: PartDoc, id: string): number[] {
  const initial = featureById(doc, 'sk1', 'sketch').initial ?? {}
  return initial[id]
}

describe.skipIf(!ready)('add_constraint colinear (real OCC + Rust solver)', () => {
  it('constrains the free line onto the reference line and keeps the document kind', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: reproSteps(['entity:sk1:l1', 'entity:sk1:pb']),
      featureDeltas: 'all',
    })
    expect(result.ok).toBe(true)
    expect(nonSketchProblems(result.features)).toEqual([])

    const sketchRow = result.featureDeltas?.find(row => row.id === 'sk1')
    expect(sketchRow).toBeDefined()
    expect(sketchRow!.status).toBe('fully_constrained')
    expect(sketchRow!.dof).toBe(0)

    // The write-back bakes the solve into `initial`: the line lies on y = 0.
    const l1 = solvedLine(result.doc!, 'l1')
    expect(Math.abs(l1[1])).toBeLessThan(1e-6)
    expect(Math.abs(l1[3])).toBeLessThan(1e-6)
    expect(l1[0]).toBeCloseTo(2.5, 6)

    // The author's kind is stored, not the lowered one.
    const sketch = featureById(result.doc!, 'sk1', 'sketch')
    expect(sketch.constraints?.find(c => c.kind === 'colinear')).toBeDefined()
  }, 120_000)

  it('refuses a colinear of a circle and a line, naming the accepted shapes', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [0, 0, 2], entityId: 'c1' } },
        { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 9, 0], entityId: 'l1' } },
        { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'colinear', targets: ['entity:sk1:c1', 'entity:sk1:l1'] } },
      ],
    })
    expect(result.ok).toBe(false)
    const refused = result.outcome.steps.find(step => !step.ok)
    expect(refused?.error?.code).toBe('invalid-mutation')
    expect(refused?.error?.message).toContain('two lines or a point and a line')
    // Nothing was authored.
    expect(result.doc).not.toBeNull()
    const sketch = featureById(result.doc!, 'sk1', 'sketch')
    expect(sketch.constraints ?? []).toEqual([])
  }, 120_000)
})
