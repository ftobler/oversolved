// @vitest-environment node
//
// MCP drive round trip for the fit_spline entity: the Ex010 script builds,
// measures CadQuery's volume, selects the two B-spline edges, and its doc
// reloads and re-runs to the same volume. The tangent case pins the authoring
// sugar's handle conversion end to end. Skips when OCC or the solver is absent.
import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { runHeadless, measureHeadless, selectHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { loadPartDoc } from '@/persistence/docSchema'
import type { PartDoc } from '@/types/cad'

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

const EX010 = [3, 1, 2.75, 1.5, 2.5, 1.75, 2, 1.5, 1.5, 1, 1, 1.25, 0.5, 1, 0, 1]

const ex010Steps: ScriptStep[] = [
  { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
  { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 3, 0], entityId: 'bottom' } },
  { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [3, 0, 3, 1], entityId: 'right' } },
  { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'fit_spline', params: EX010, entityId: 'sp' } },
  { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 1, 0, 0], entityId: 'left' } },
  { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 0.5 } },
]

describe.skipIf(!ready)('fit_spline drive round trip (real kernel)', () => {
  it('builds Ex010, selects both spline edges and reloads to the same volume', async () => {
    const built = await runHeadless({ doc: emptyDriveDoc(), steps: ex010Steps })
    expect(built.features).toEqual([])
    const measure = await measureHeadless(built.doc!)
    expect(measure!.measures.volume).toBeCloseTo(1.8925830470835936, 6)

    const selected = await selectHeadless(built.doc!, { kind: 'edge', where: { type: 'spline' } })
    expect(selected!.queries).toHaveLength(2)

    const reloaded = loadPartDoc(built.doc as unknown as PartDoc)
    expect(reloaded.ok).toBe(true)
    if (!reloaded.ok) return
    const rerun = await runHeadless({ doc: reloaded.doc, steps: [] })
    const again = await measureHeadless(rerun.doc ?? reloaded.doc)
    expect(again!.measures.volume).toBeCloseTo(1.8925830470835936, 6)
  }, 120_000)

  it('authors tan2pt through the mutation sugar and matches CadQuery', async () => {
    const steps: ScriptStep[] = [
      { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
      { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 2, 0], entityId: 'bottom' } },
      {
        mutation: {
          type: 'add_entity', featureId: 'sk1', kind: 'fit_spline',
          params: [2, 0, 3, 2], entityId: 'sp',
          tangents: [[0, 1], [-1, 1]],
        },
      },
      { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [3, 2, 0, 2], entityId: 'top' } },
      { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 2, 0, 0], entityId: 'left' } },
      { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 1 } },
    ]
    const built = await runHeadless({ doc: emptyDriveDoc(), steps })
    expect(built.features).toEqual([])
    const measure = await measureHeadless(built.doc!)
    // CadQuery 2.8.0 with scale=True.
    expect(measure!.measures.volume).toBeCloseTo(5.074999999999999, 5)
  }, 120_000)
})

describe.skipIf(!ready)('fit_spline sweep path (real kernel)', () => {
  it('sweeps a circle along a tangent fit-spline path', async () => {
    const steps: ScriptStep[] = [
      { mutation: { type: 'add_sketch', featureId: 'sk_path', plane: '@builtin_plane_front' } },
      {
        mutation: {
          type: 'add_entity', featureId: 'sk_path', kind: 'fit_spline',
          params: [0, 0, 1, 4, 3, 6], entityId: 'sp',
          tangents: [[0, 1], [1, 0]],
        },
      },
      { mutation: { type: 'add_sketch', featureId: 'sk_prof', plane: '@builtin_plane_top' } },
      { mutation: { type: 'add_entity', featureId: 'sk_prof', kind: 'circle', params: [0, 0, 0.25], entityId: 'c' } },
      { mutation: { type: 'add_sweep', featureId: 'sw1', sketchQuery: '$sk_prof', pathQuery: '$sk_path' } },
    ]
    const built = await runHeadless({ doc: emptyDriveDoc(), steps })
    expect(built.features).toEqual([])
    const measure = await measureHeadless(built.doc!)
    // CadQuery 2.8.0: 1.4226384594837815; the sweep mode may differ slightly.
    expect(measure!.measures.volume).toBeCloseTo(1.4226384594837815, 3)
  }, 120_000)
})
