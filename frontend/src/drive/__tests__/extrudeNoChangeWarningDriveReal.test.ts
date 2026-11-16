// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { runHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import { loadOcc, occInstalled } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}
const ready = oc && solveBytes

const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

describe.skipIf(!ready)('extrude no-change warning in the run reply (real OCC + Rust solver)', () => {
  it('reports no geometry change for a bump pointing into the body', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
        m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [3, 3] }),
        m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 3, operation: 'new' }),
        m({ type: 'add_plane', featureId: 'plTop', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 3 } }),
        m({ type: 'add_sketch', featureId: 'sk2', plane: '@plTop' }),
        m({ type: 'add_rect', featureId: 'sk2', p0: [0, 0], p1: [1, 2] }),
        m({ type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 0.1, direction: 'reverse', operation: 'add' }),
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.part.solveOutcomes().ex2?.status).toBe('ok')
    expect(result.part.solveOutcomes().ex2?.warning).toContain('no geometry change')
  }, 120_000)

  it('stays clean for a bump pointing outward', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
        m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [3, 3] }),
        m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 3, operation: 'new' }),
        m({ type: 'add_plane', featureId: 'plTop', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 3 } }),
        m({ type: 'add_sketch', featureId: 'sk2', plane: '@plTop' }),
        m({ type: 'add_rect', featureId: 'sk2', p0: [0, 0], p1: [1, 2] }),
        m({ type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 0.1, direction: 'normal', operation: 'add' }),
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.part.solveOutcomes().ex2?.warning).toBeUndefined()
  }, 120_000)
})
