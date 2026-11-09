// @vitest-environment node
//
// A sketch whose constraints conflict must not bake its least-squares
// compromise into the document. The reply names the sketch overconstrained,
// its authored `initial` stays untouched, and inspecting the reply's docHash
// with `steps: []` returns that same hash instead of a fresh compromise.
// Real kernel, gated like the other drive real suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { emptyDriveDoc, runHeadless } from '../headlessOps'
import { docHashOf } from '../docHash'
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

// A two-unit line pinned by `fixed` and dimensioned to one unit: no solve can
// satisfy both rows.
function conflictingSteps(): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
    m({ type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 2, 0], entityId: 'l1' }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'fixed', targets: ['entity:sk1:l1'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'length', targets: ['entity:sk1:l1'], value: 1 }),
  ]
}

describe.skipIf(!ready)('a failed sketch keeps the document geometry (real OCC + Rust solver)', () => {
  it('settles in one pass and leaves the authored initial alone', async () => {
    const first = await runHeadless({
      doc: emptyDriveDoc(),
      steps: conflictingSteps(),
      docId: 'overconstrained-writeback',
    })
    expect(first.outcome.ok).toBe(true)
    expect(first.features.map(f => [f.id, f.status])).toEqual([['sk1', 'overconstrained']])
    expect(first.notes.some(note => note.text.includes('did not settle'))).toBe(false)

    const sketch = first.doc!.features!.find(f => f.id === 'sk1') as SketchFeature
    expect(sketch.initial).toEqual({ l1: [0, 0, 2, 0] })

    const inspected = await runHeadless({
      doc: first.doc as PartDoc,
      steps: [],
      docId: 'overconstrained-inspect',
    })
    expect(inspected.ok).toBe(true)
    expect(docHashOf(inspected.doc as PartDoc)).toBe(docHashOf(first.doc as PartDoc))
    expect(inspected.notes.some(note => note.text.includes('did not settle'))).toBe(false)
    expect(inspected.features.map(f => [f.id, f.status])).toEqual([['sk1', 'overconstrained']])
    const kept = inspected.doc!.features!.find(f => f.id === 'sk1') as SketchFeature
    expect(kept.initial).toEqual({ l1: [0, 0, 2, 0] })
  }, 240_000)
})
