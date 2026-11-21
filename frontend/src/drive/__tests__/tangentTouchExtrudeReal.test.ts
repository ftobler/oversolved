// @vitest-environment node
//
// The MCP script of the tangent-touch report, end to end through the drive:
// two externally tangent circles extruded with `new` build as two bodies, and
// selecting their edges reports exactly one seam per body and no tangent line
// edge. Before the profile-cluster split the prisms were fused, and both
// cylinder walls were cut in two at the contact line, so each body carried a
// seam AND a tangent contact edge.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, selectHeadless, seedBuiltins } from '../headlessOps'
import { loadOcc, occInstalled } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import type { ScriptStep } from '../scriptRunner'
import { nonSketchProblems } from './buildProblems'

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}
const ready = oc && solveBytes
const step = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

function emptyDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}

// Externally tangent: r10 at the origin, r5 at (0, 15). Every entity fixed so
// the solve keeps the authored tangency exactly.
function tangentPairSteps(): ScriptStep[] {
  return [
    step({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
    step({ type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [0, 0, 10], entityId: 'c0' }),
    step({ type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [0, 15, 5], entityId: 'c1' }),
    step({ type: 'add_constraint', featureId: 'sk1', kind: 'fixed', targets: ['entity:sk1:c0'] }),
    step({ type: 'add_constraint', featureId: 'sk1', kind: 'fixed', targets: ['entity:sk1:c1'] }),
    step({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10, operation: 'new' }),
  ]
}

describe.skipIf(!ready)('two tangent circles extrude without a contact edge (real OCC)', () => {
  it('reports one seam per body and no tangent line edge', async () => {
    const built = await runHeadless({ doc: emptyDoc(), steps: tangentPairSteps() })
    expect(built.ok).toBe(true)
    expect(nonSketchProblems(built.features)).toEqual([])

    const seams = (await selectHeadless(built.doc as PartDoc, {
      kind: 'edge',
      where: { seam: true },
    }))!
    expect(seams.queries).toHaveLength(2)
    // One per body: the two tangent circles stay two bodies, so neither part
    // borrows the other's seam.
    expect(new Set(seams.items.map((item) => item.part)).size).toBe(2)
    for (const item of seams.items) {
      expect(item.geometry).toMatchObject({ kind: 'line', seam: true })
    }

    const tangent = (await selectHeadless(built.doc as PartDoc, { kind: 'edge' }))!
    // A real tangent join is a smooth dihedral; the contact line used to read
    // as one. There is none left on a line edge (selecting by `convexity`
    // throws when nothing matches, so the full pool is filtered here).
    const tangentLines = tangent.items.filter(
      (item) => item.geometry.kind === 'line' && (item.geometry as { convexity?: string }).convexity === 'tangent',
    )
    expect(tangentLines).toEqual([])
  }, 240_000)
})
