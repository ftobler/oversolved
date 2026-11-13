// @vitest-environment node
//
// `add_constraint` refusals through the drive, against the real solver. The
// practice runs found `midpoint` refusing the stored and builtin spellings the
// catalog promises while the step still reported ok with no ids, and a refused
// step's reply reading as a clean build. These pin the fixed contract end to
// end: the promise spellings author and solve, a refused creator is a named
// step failure, and a refused-only script still reports the input document's
// verdict.
//
// Reproduced from
// bugreports/mcp-practice/03_build123d__build123d-official-examples__examples__multiple_workplanes.py/
// (report F1) and .../01_openscad__...__Old__example004.scad/ (report F1).

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

// The practice repro: a free line, its midpoint pinned to the part origin, then
// horizontal and a length. The two spelled-as-promised targets close all four
// degrees of freedom, so the line is centred on the origin.
function midpointSteps(): ScriptStep[] {
  return [
    { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [-2, 0, 2, 0], entityId: 'ax' } },
    {
      mutation: {
        type: 'add_constraint', featureId: 'sk1', kind: 'midpoint',
        targets: ['@builtin_origin', '$ax'],
      },
    },
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'horizontal', targets: ['entity:sk1:ax'] } },
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'length', targets: ['entity:sk1:ax'], value: 4 } },
  ]
}

// An underconstrained input document: one free line with no dimensions.
function freeLineDoc(): PartDoc {
  const doc = emptyDriveDoc()
  doc.features!.push({
    id: 'sk1',
    kind: 'sketch',
    plane: '@builtin_plane_front',
    entities: [{ id: 'ax', kind: 'line' }],
    initial: { ax: [-2, 0, 2, 0] },
    constraints: [],
  })
  return doc
}

describe.skipIf(!ready)('add_constraint refusals (real OCC + Rust solver)', () => {
  it('authors the stored line with the builtin origin and solves to 0 DOF', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: midpointSteps(),
      featureDeltas: 'all',
    })
    expect(result.ok).toBe(true)
    expect(nonSketchProblems(result.features)).toEqual([])
    expect(result.outcome.steps.every(step => step.ok)).toBe(true)

    const sketchRow = result.featureDeltas?.find(row => row.id === 'sk1')
    expect(sketchRow!.status).toBe('fully_constrained')
    expect(sketchRow!.dof).toBe(0)

    const sketch = featureById(result.doc!, 'sk1', 'sketch')
    const midpoint = sketch.constraints?.find(c => c.kind === 'midpoint')
    expect(midpoint!.line).toBe('$ax')
    expect(midpoint!.point).toBe('@builtin_origin')

    // The write-back baked the solve: the line's midpoint is the origin.
    const line = sketch.initial!.ax
    expect((line[0] + line[2]) / 2).toBeCloseTo(0, 6)
    expect((line[1] + line[3]) / 2).toBeCloseTo(0, 6)
  }, 120_000)

  it('reports a refused-only script with the input document verdict', async () => {
    const result = await runHeadless({
      doc: freeLineDoc(),
      steps: [{
        mutation: {
          type: 'add_constraint', featureId: 'sk1', kind: 'midpoint',
          targets: ['vertex:sk1:ax:start', 'vertex:sk1:ax:end'],
        },
      }],
    })
    expect(result.ok).toBe(false)
    const refused = result.outcome.steps.find(step => !step.ok)
    expect(refused?.error?.code).toBe('invalid-mutation')
    expect(refused?.error?.message).toContain('midpoint needs a line and a point, or three points')
    // Nothing landed, so the input document was settled for the verdict: the
    // free line is an underconstrained warning row, not an empty clean build.
    expect(result.solved).toBe(true)
    expect(result.features).toContainEqual(expect.objectContaining({ id: 'sk1', status: 'underconstrained' }))
  }, 120_000)

  it('reports a projection the applier refuses as no-change', async () => {
    // A projection constraint whose entity is gone (a hand-edited document):
    // the applier's duplicate-projection guard refuses a fresh entity with the
    // same id, so the apply changes nothing. This is the safety-net path: the
    // value rule cannot see the orphan constraint's target.
    const doc = freeLineDoc()
    const sketch = doc.features!.find(feature => feature.id === 'sk1')
    if (sketch?.kind === 'sketch') {
      sketch.constraints = [
        { id: 'proj_o', kind: 'projection', target: '$o', source: '@builtin_origin' },
      ]
    }
    const result = await runHeadless({
      doc,
      steps: [{
        mutation: {
          type: 'add_projected_entity', featureId: 'sk1', kind: 'point',
          source: '@builtin_origin', entityId: 'o',
        },
      }],
    })
    expect(result.ok).toBe(false)
    expect(result.outcome.steps[0].ok).toBe(false)
    expect(result.outcome.steps[0].error).toEqual({
      code: 'no-change',
      message: 'add_projected_entity changed nothing: the applier refused it',
    })
  }, 120_000)
})
