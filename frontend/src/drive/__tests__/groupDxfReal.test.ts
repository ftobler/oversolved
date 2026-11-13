// @vitest-environment node
//
// A DXF import is held by one Group constraint, so the profile arrives at 2 DOF
// and keeps its shape through the solve and the write-back. Pinning one vertex
// to the origin closes the last 2, an extrude then measures the authored square
// with its circular hole (the volume is the test: any deformation changes it).
//
// Gated like the other real drive suites: skips when OCC.js or the Rust node
// build is absent.
import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, emptyDriveDoc } from '../headlessOps'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { nonSketchProblems } from './buildProblems'
import { featureById } from '@/testing/featureAccess'
import type { ScriptStep } from '../scriptRunner'

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

/** A 20 x 10 rectangle with a centred r = 2 hole, in file order. */
function squareWithHole(): string {
  const groups = ['0', 'SECTION', '2', 'ENTITIES']
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    groups.push('0', 'LINE', '10', String(x1), '20', String(y1), '11', String(x2), '21', String(y2))
  }
  line(0, 0, 20, 0)
  line(20, 0, 20, 10)
  line(20, 10, 0, 10)
  line(0, 10, 0, 0)
  groups.push('0', 'CIRCLE', '10', '10', '20', '5', '40', '2')
  groups.push('0', 'ENDSEC', '0', 'EOF')
  return groups.join('\n') + '\n'
}

describe.skipIf(!ready)('grouped DXF import, pin and extrude (real OCC + Rust solver)', () => {
  it('keeps the imported profile through the solve and extrudes its authored volume', async () => {
    const imported = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        m({ type: 'add_sketch', featureId: 'sk', label: 'Profile', plane: '@builtin_plane_front' }),
        m({ type: 'import_dxf', featureId: 'sk', content: squareWithHole() }),
      ],
      docId: 'group-dxf-import',
    })
    expect(imported.ok).toBe(true)
    expect(nonSketchProblems(imported.features)).toEqual([])
    expect(imported.outcome.steps[1].createdCount).toBe(5)
    expect(imported.outcome.steps[1].groupId).toBeTruthy()

    const firstDoc = imported.doc as PartDoc
    const feature = featureById(firstDoc, 'sk', 'sketch')
    const ids = (feature.entities ?? []).map(e => e.id)
    expect(ids).toHaveLength(5)

    // Pin the first imported line's start (the group's anchor) to the origin,
    // then extrude the profile by 2.
    const built = await runHeadless({
      doc: firstDoc,
      steps: [
        m({
          type: 'add_constraint', featureId: 'sk', kind: 'coincident',
          targets: [`vertex:sk:${ids[0]}:start`, '@builtin_origin'],
        }),
        m({ type: 'add_extrude', featureId: 'ex', label: 'Plate', sketchQuery: '$sk', distance: 2, operation: 'new' }),
      ],
      docId: 'group-dxf-build',
    })
    expect(built.ok).toBe(true)
    expect(nonSketchProblems(built.features)).toEqual([])
    // The pinned sketch is fully constrained: no underconstrained warning row.
    expect(built.features.find(f => f.id === 'sk')).toBeUndefined()

    // The write-back baked the authored rows, not a deformed compromise.
    const baked = featureById(built.doc as PartDoc, 'sk', 'sketch')
    expect(baked.initial?.[ids[0]]).toEqual([0, 0, 20, 0])
    expect(baked.initial?.[ids[1]]).toEqual([20, 0, 20, 10])
    const circle = (baked.entities ?? []).find(e => e.kind === 'circle')!
    expect(baked.initial?.[circle.id]).toEqual([10, 5, 2])

    const measured = await measureHeadless(built.doc as PartDoc, { docId: 'group-dxf-measure' })
    // 20 x 10 x 2 minus the r = 2 hole through it.
    const expected = (20 * 10 - Math.PI * 2 * 2) * 2
    expect(measured!.measures.volume).toBeCloseTo(expected, 2)
  }, 180_000)
})
