// @vitest-environment node
//
// The drive reply for an additive extrude that bridges two posts: it fuses the
// first post it reaches, the feature stays ok, and the untouched second post is
// named in the feature's warning so the caller can add the union. A profile
// beside the part is not the warning case any more: an add that reaches no body
// fails the feature instead. Both halves read through the same run reply a
// client gets.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
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

// A 2 x 2 post at x 0..2, 3 mm deep. `operation` lets a test make the second
// profile an add that reaches nothing.
function post(featureId: string, x0: number, operation: 'new' | 'add' = 'new'): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: `sk${featureId}`, plane: '@builtin_plane_front' }),
    m({ type: 'add_rect', featureId: `sk${featureId}`, p0: [x0, 0], p1: [x0 + 2, 2] }),
    m({ type: 'add_extrude', featureId, sketchQuery: `$sk${featureId}`, distance: 3, operation }),
  ]
}

// A bar over x 1..6: it overlaps post 1 and post 2, and the default add fuses
// only the first one it reaches.
function bridge(): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: 'skBridge', plane: '@builtin_plane_front' }),
    m({ type: 'add_rect', featureId: 'skBridge', p0: [1, 0], p1: [6, 2] }),
    m({ type: 'add_extrude', featureId: 'exBridge', sketchQuery: '$skBridge', distance: 3 }),
  ]
}

describe.skipIf(!ready)('extrude add touch warning in the run reply (real OCC + Rust solver)', () => {
  it('names the second post while the add stays ok', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [...post('ex1', 0), ...post('ex2', 5), ...bridge()],
    })
    expect(result.ok).toBe(true)
    expect(result.part.solveOutcomes().exBridge?.status).toBe('ok')
    expect(result.part.solveOutcomes().exBridge?.warning).toContain('also touches body_ex2')
    const problem = result.features.find(feature => feature.id === 'exBridge')
    expect(problem?.message).toContain('also touches body_ex2')
    // The warning describes the state; it does not fuse the second post.
    expect(result.bodies).toEqual(['body_ex1', 'body_ex2'])
  }, 120_000)

  it('reports a disjoint add as a failed feature, not a touch warning', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [...post('ex1', 0), ...post('ex2', 5, 'add')],
    })
    const problem = result.features.find(feature => feature.id === 'ex2')
    expect(problem).toMatchObject({ id: 'ex2', kind: 'extrude', status: 'exception' })
    expect(problem!.message).toContain('add does not merge with any existing body')
    expect(problem!.message).not.toContain('also touches')
    expect(result.bodies).toEqual(['body_ex1'])
  }, 120_000)
})
