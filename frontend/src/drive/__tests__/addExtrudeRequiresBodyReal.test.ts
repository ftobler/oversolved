// @vitest-environment node
//
// An additive extrude beside material it cannot join used to mint a separate
// body with an `add joined nothing` warning. An add extends an existing body,
// so that profile is a misplaced sketch: the feature now fails and names
// `operation: new` as the fix. This pins that the run reply carries the
// failure. Also pins the inert inline `up_to`: without `termination: up_to` it
// must not change the blind extrude.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
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

const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

// A 2 x 2 post at the origin, then a second profile at x 5..7 sharing no volume.
function twoPosts(): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
    m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [2, 2] }),
    m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 3, operation: 'new' }),
    m({ type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_front' }),
    m({ type: 'add_rect', featureId: 'sk2', p0: [5, 0], p1: [7, 2] }),
    m({ type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 3 }),
  ]
}

describe.skipIf(!ready)('an additive extrude that reaches no body (real OCC + Rust solver)', () => {
  it('reports the failed feature in the run reply and mints no body', async () => {
    const result = await runHeadless({ doc: emptyDriveDoc(), steps: twoPosts() })
    // `ok` is the call's verdict, not the solve's: a failed feature is listed
    // in `features` and the reply stays a successful run.
    expect(result.ok).toBe(true)
    const problem = result.features.find(feature => feature.id === 'ex2')
    expect(problem).toMatchObject({ id: 'ex2', kind: 'extrude', status: 'exception' })
    expect(problem!.message).toContain('add does not merge with any existing body')
    expect(problem!.message).toContain('use operation: new')
    expect(result.features.find(feature => feature.id === 'ex1')).toBeUndefined()
    expect(result.bodies).toEqual(['body_ex1'])
  }, 120_000)

  it('treats up_to without termination as a blind extrude', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
        m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [2, 2] }),
        // The Front plane passes through this profile: reading `up_to` without
        // `termination: up_to` would fail, so 2 x 2 x 3 proves it stayed blind.
        m({
          type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 3, operation: 'new',
          up_to: '@builtin_plane_front',
        }),
      ],
    })
    expect(result.ok).toBe(true)
    expect(nonSketchProblems(result.features)).toEqual([])
    const measured = await measureHeadless(result.doc as PartDoc)
    expect(measured!.measures.volume).toBeCloseTo(12, 6)
  }, 120_000)
})
