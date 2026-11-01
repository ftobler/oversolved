// @vitest-environment node
//
// An additive extrude beside material it cannot join mints a separate body.
// That is the right geometry but used to be silent; the kernel now reports the
// `add joined nothing` warning and this pins that the run reply carries it
// through featureProblems while the call stays ok. Also pins the inert inline
// `up_to`: without `termination: up_to` it must not change the blind extrude.

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
    m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 3 }),
    m({ type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_front' }),
    m({ type: 'add_rect', featureId: 'sk2', p0: [5, 0], p1: [7, 2] }),
    m({ type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 3 }),
  ]
}

describe.skipIf(!ready)('an additive extrude that joins nothing (real OCC + Rust solver)', () => {
  it('reports add joined nothing in the run reply while ok stays true', async () => {
    const result = await runHeadless({ doc: emptyDriveDoc(), steps: twoPosts() })
    expect(result.ok).toBe(true)
    const problem = result.features.find(feature => feature.id === 'ex2')
    expect(problem).toMatchObject({ id: 'ex2', kind: 'extrude', status: 'ok' })
    expect(problem!.message).toContain('add joined nothing')
    expect(result.features.find(feature => feature.id === 'ex1')).toBeUndefined()
    expect(result.bodies).toHaveLength(2)
    expect(result.bodies).toEqual(expect.arrayContaining(['body_ex1', 'body_ex2']))
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
          type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 3,
          up_to: '@builtin_plane_front',
        }),
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.features).toEqual([])
    const measured = await measureHeadless(result.doc as PartDoc)
    expect(measured!.measures.volume).toBeCloseTo(12, 6)
  }, 120_000)
})
