// @vitest-environment node
//
// Zero axis dimensions must still remove their degree of freedom. An unsigned
// `point_distance_x`/`_y` of 0 is authored with no `sign`, and the solver's
// finite difference of |d| read zero exactly at the kink: the row was empty,
// the sketch stayed one DOF free per zero dimension and the dimension read
// redundant. The analytic row fixes the derivative only; the stored constraint
// stays unsigned as authored.
//
// The euclidean `point_distance` has the same kink with no valid one-row form
// (a zero distance is a coincident, two equations), so the mutation boundary
// refuses that value with a message naming `coincident`, headless and UI alike.
// Real kernel, gated like the other drive real suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { runHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'

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

const sketchOf = (doc: PartDoc | null): SketchFeature | undefined =>
  doc?.features?.find((feature): feature is SketchFeature => feature.kind === 'sketch')

// The minimal repro: point p at (0, 1.5), an unsigned zero x distance from the
// origin and a signed y distance of 1.5.
function reproSteps(): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: 'sk1', label: 'Repro', plane: '@builtin_plane_front' }),
    m({ type: 'add_entity', featureId: 'sk1', kind: 'point', params: [0, 1.5], entityId: 'p' }),
    m({
      type: 'add_constraint', featureId: 'sk1', kind: 'point_distance_x',
      targets: ['@builtin_origin', 'entity:sk1:p'], value: 0,
    }),
    m({
      type: 'add_constraint', featureId: 'sk1', kind: 'point_distance_y',
      targets: ['@builtin_origin', 'entity:sk1:p'], value: 1.5, sign: 1,
    }),
  ]
}

// Two points at the same seed, ready for a euclidean point_distance.
function twoPointSteps(): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: 'sk1', label: 'Points', plane: '@builtin_plane_front' }),
    m({ type: 'add_entity', featureId: 'sk1', kind: 'point', params: [0, 0], entityId: 'p' }),
    m({ type: 'add_entity', featureId: 'sk1', kind: 'point', params: [5, 0], entityId: 'q' }),
  ]
}

describe.skipIf(!ready)('zero axis dimensions (real OCC + Rust solver)', () => {
  it('an unsigned zero point_distance_x leaves the sketch fully constrained', async () => {
    const result = await runHeadless({ doc: emptyDriveDoc(), steps: reproSteps(), docId: 'zero-axis-repro' })
    expect(result.outcome.ok).toBe(true)
    // The bug surfaced as the underconstrained warning row, not a failure.
    expect(result.features).toEqual([])
    const outcome = result.part.solveOutcomes().sk1
    expect(outcome?.status).toBe('fully_constrained')
    expect(outcome?.dof).toBe(0)
    // The zero dimension is stored as authored, with no sign.
    const constraint = sketchOf(result.doc as PartDoc)?.constraints
      ?.find(c => c.kind === 'point_distance_x')
    expect(constraint?.value).toBe(0)
    expect(constraint?.sign).toBeUndefined()
  }, 120_000)

  it('refuses to author a zero euclidean point_distance, naming coincident', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [...twoPointSteps(), m({
        type: 'add_constraint', featureId: 'sk1', kind: 'point_distance',
        targets: ['entity:sk1:p', 'entity:sk1:q'], value: 0,
      })],
      docId: 'zero-axis-euclidean-add',
    })
    expect(result.outcome.ok).toBe(false)
    const step = result.outcome.steps.at(-1)
    expect(step).toMatchObject({ ok: false })
    expect(step?.error?.message).toContain('coincident')
    expect(sketchOf(result.doc as PartDoc)?.constraints ?? []).toEqual([])
  }, 120_000)

  it('refuses to set a euclidean point_distance to zero, naming coincident', async () => {
    const authored = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [...twoPointSteps(), m({
        type: 'add_constraint', featureId: 'sk1', kind: 'point_distance',
        targets: ['entity:sk1:p', 'entity:sk1:q'], value: 5,
      })],
      docId: 'zero-axis-euclidean-authored',
    })
    expect(authored.outcome.ok).toBe(true)
    const constraint = (sketchOf(authored.doc as PartDoc)?.constraints ?? [])[0]
    expect(constraint?.value).toBe(5)

    const edited = await runHeadless({
      doc: authored.doc as PartDoc,
      steps: [m({
        type: 'set_constraint_value', featureId: 'sk1',
        constraintId: constraint!.id, value: 0,
      })],
      docId: 'zero-axis-euclidean-set',
    })
    expect(edited.outcome.ok).toBe(false)
    const step = edited.outcome.steps.at(-1)
    expect(step).toMatchObject({ ok: false })
    expect(step?.error?.message).toContain('coincident')
    expect((sketchOf(edited.doc as PartDoc)?.constraints ?? [])[0]?.value).toBe(5)
  }, 120_000)
})
