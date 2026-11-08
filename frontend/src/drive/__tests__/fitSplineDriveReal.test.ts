// @vitest-environment node
//
// MCP drive round trip for the fit_spline entity: the Ex010 script builds,
// measures the analytic extrusion volume, selects the two B-spline edges, and its doc
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
  { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 0.5, operation: 'new' } },
]

describe.skipIf(!ready)('fit_spline drive round trip (real kernel)', () => {
  it('builds Ex010, selects both spline edges and reloads to the same volume', async () => {
    const built = await runHeadless({ doc: emptyDriveDoc(), steps: ex010Steps })
    expect(built.features).toEqual([])
    const measure = await measureHeadless(built.doc!)
    // The analytic extrusion (profile area 3.785059288899729 times the 0.5
    // height). CadQuery's 1.8925830470835936 is the default rule's 2.8e-5-high
    // reading; the shared measure read is accurate here.
    expect(measure!.measures.volume).toBeCloseTo(1.8925296444, 6)

    const selected = await selectHeadless(built.doc!, { kind: 'edge', where: { type: 'spline' } })
    expect(selected!.queries).toHaveLength(2)

    const reloaded = loadPartDoc(built.doc as unknown as PartDoc)
    expect(reloaded.ok).toBe(true)
    if (!reloaded.ok) return
    const rerun = await runHeadless({ doc: reloaded.doc, steps: [] })
    const again = await measureHeadless(rerun.doc ?? reloaded.doc)
    expect(again!.measures.volume).toBeCloseTo(1.8925296444, 6)
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
      { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 1, operation: 'new' } },
    ]
    const built = await runHeadless({ doc: emptyDriveDoc(), steps })
    expect(built.features).toEqual([])
    const measure = await measureHeadless(built.doc!)
    // CadQuery 2.8.0 with scale=True.
    expect(measure!.measures.volume).toBeCloseTo(5.074999999999999, 5)
  }, 120_000)

  // Regression pin for the recipe docs/drive.md teaches (tea_cup practice, F2):
  // a per-end scalar is the unit direction times the scalar with
  // tangentScale: false, and it lands on the same stored handles as writing
  // the documented formula through set_fit_spline_handle.
  it('authors per-end tangent scalars the documented way, equal to the handle formula', async () => {
    const p0 = [4, 0]
    const p1 = [0, 3]
    const h = 5  // one piece, so the first and last chord are the same 3-4-5 chord
    const t0: [number, number] = [0 * 1.75, 1 * 1.75]  // unit (0, 1) times scalar 1.75
    const t1: [number, number] = [-1 * 1, 0 * 1]  // unit (-1, 0) times scalar 1
    const frame = (spline: ScriptStep[]): ScriptStep[] => [
      { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
      { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 4, 0], entityId: 'bottom' } },
      ...spline,
      { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 3, 0, 0], entityId: 'left' } },
      { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 1, operation: 'new' } },
    ]
    const byTangents = frame([{
      mutation: {
        type: 'add_entity', featureId: 'sk1', kind: 'fit_spline',
        params: [...p0, ...p1], entityId: 'sp', tangents: [t0, t1], tangentScale: false,
      },
    }])
    const byHandles = frame([
      { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'fit_spline', params: [...p0, ...p1], entityId: 'sp' } },
      {
        mutation: {
          type: 'set_fit_spline_handle', featureId: 'sk1', entityId: 'sp', end: 'start',
          handle: [p0[0] + h * t0[0] / 3, p0[1] + h * t0[1] / 3],
        },
      },
      {
        mutation: {
          type: 'set_fit_spline_handle', featureId: 'sk1', entityId: 'sp', end: 'end',
          handle: [p1[0] - h * t1[0] / 3, p1[1] - h * t1[1] / 3],
        },
      },
    ])
    const a = await runHeadless({ doc: emptyDriveDoc(), steps: byTangents })
    const b = await runHeadless({ doc: emptyDriveDoc(), steps: byHandles })
    expect(a.features).toEqual([])
    expect(b.features).toEqual([])
    const stored = (doc: unknown): number[] => {
      const sketch = (doc as PartDoc).features!.find(f => f.id === 'sk1') as { initial?: Record<string, number[]> }
      return sketch.initial!.sp
    }
    const storedA = stored(a.doc)
    expect(storedA).toHaveLength(8)
    expect(storedA[5]).toBeCloseTo(35 / 12, 6)  // the 1.75 scalar survived into the start handle
    stored(b.doc).forEach((value, i) => expect(value, `param ${i}`).toBeCloseTo(storedA[i], 6))
    const volumeA = (await measureHeadless(a.doc!))!.measures.volume
    const volumeB = (await measureHeadless(b.doc!))!.measures.volume
    expect(Math.abs(volumeA - volumeB) / volumeB).toBeLessThan(1e-3)
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

  // A path chain is walked from a degree-1 end. With the fit spline and a tail
  // line in the sketch, authoring the line first makes the walk start at the
  // tail's free end, so the fit spline is traversed backward and its spine edge
  // goes through the reversal branch (poles reversed, knots u_max - u). The
  // same two entities authored the other way round walk forward. Same geometry,
  // so the two volumes must agree.
  const chainPath = (lineFirst: boolean): ScriptStep[] => {
    const fit: ScriptStep = {
      mutation: {
        type: 'add_entity', featureId: 'sk_path', kind: 'fit_spline',
        params: [0, 0, 1, 4, 3, 6], entityId: 'sp',
        tangents: [[0, 1], [1, 0]],
      },
    }
    const tail: ScriptStep = {
      mutation: { type: 'add_entity', featureId: 'sk_path', kind: 'line', params: [3, 6, 5, 6], entityId: 'tail' },
    }
    return [
      { mutation: { type: 'add_sketch', featureId: 'sk_path', plane: '@builtin_plane_front' } },
      ...(lineFirst ? [tail, fit] : [fit, tail]),
      { mutation: { type: 'add_sketch', featureId: 'sk_prof', plane: '@builtin_plane_top' } },
      { mutation: { type: 'add_entity', featureId: 'sk_prof', kind: 'circle', params: [0, 0, 0.25], entityId: 'c' } },
      { mutation: { type: 'add_sweep', featureId: 'sw1', sketchQuery: '$sk_prof', pathQuery: '$sk_path' } },
    ]
  }

  it('gives the same volume when the fit-spline path is walked backward', async () => {
    const forward = await runHeadless({ doc: emptyDriveDoc(), steps: chainPath(false) })
    const backward = await runHeadless({ doc: emptyDriveDoc(), steps: chainPath(true) })
    expect(forward.features).toEqual([])
    expect(backward.features).toEqual([])
    const forwardVolume = (await measureHeadless(forward.doc!))!.measures.volume
    const backwardVolume = (await measureHeadless(backward.doc!))!.measures.volume
    expect(backwardVolume).toBeCloseTo(forwardVolume, 6)
  }, 120_000)
})
