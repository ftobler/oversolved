// @vitest-environment node
//
// End to end through the real kernel: a plate authored as four lines, rounded
// by one fillet_corners step, extruded. The measured volume is the analytic
// rounded-plate number, so the whole chain is pinned: trim -> tangent arc ->
// weld -> loop fill -> extrude. The din_rail case also proves the material probe
// picks the reflex side of an L strip without an explicit side override.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { runHeadless, measureHeadless, emptyDriveDoc, type HeadlessRunResult } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { featureById } from '@/testing/featureAccess'

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

const line = (id: string, params: number[]): ScriptStep =>
  ({ mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params, entityId: id } })

const sketchOf = (doc: PartDoc): SketchFeature =>
  featureById(doc, 'sk1', 'sketch')

function rectSteps(width: number, height: number): ScriptStep[] {
  return [
    { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
    line('b', [0, 0, width, 0]),
    line('r', [width, 0, width, height]),
    line('t', [width, height, 0, height]),
    line('l', [0, height, 0, 0]),
  ]
}

const RECT_CORNERS = [
  { a: 'b', aVertex: 'start' as const, b: 'l', bVertex: 'end' as const },
  { a: 'b', aVertex: 'end' as const, b: 'r', bVertex: 'start' as const },
  { a: 'r', aVertex: 'end' as const, b: 't', bVertex: 'start' as const },
  { a: 't', aVertex: 'end' as const, b: 'l', bVertex: 'start' as const },
]

function filletStep(radius: number, corners = RECT_CORNERS): ScriptStep {
  return { mutation: { type: 'fillet_corners', featureId: 'sk1', radius, corners } }
}

const extrude = (distance: number): ScriptStep =>
  ({ mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance, operation: 'new' } })

async function run(steps: ScriptStep[]): Promise<HeadlessRunResult> {
  return runHeadless({ doc: emptyDriveDoc(), steps })
}

function centres(doc: PartDoc): number[][] {
  const sketch = sketchOf(doc)
  return (sketch.entities ?? [])
    .filter(entity => entity.kind === 'arc')
    .map(entity => (sketch.initial ?? {})[entity.id]?.slice(0, 2) ?? [])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
}

describe.skipIf(!ready)('fillet_corners extrudes to the analytic volume (real kernel)', () => {
  it('the pillow plate is (80*60 - (4-pi)*25)*10 and matches the hand-authored plate', async () => {
    const rounded = await run([...rectSteps(80, 60), filletStep(5), extrude(10)])
    expect(rounded.ok).toBe(true)
    expect(rounded.features).toEqual([])
    const measuredRounded = await measureHeadless(rounded.doc!)
    expect(measuredRounded?.ok).toBe(true)
    expect(measuredRounded!.features).toEqual([])
    expect(measuredRounded!.measures.volume).toBeCloseTo((80 * 60 - (4 - Math.PI) * 25) * 10, 6)
    expect(measuredRounded!.measures.volume).toBeCloseTo(47785.39816339745, 6)

    // The same plate hand-authored: four trimmed lines plus four tangent arcs
    // with explicit tangent points. It is static because adding the equivalent
    // redundant tangent constraints one step at a time lets the underconstrained
    // solve drift before the next step lands; the authored geometry is the
    // baseline here, and the generated step's own constraint set is asserted in
    // the document-write test.
    const handDoc: PartDoc = {
      ...emptyDriveDoc(),
      features: [{
        id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [
          { id: 'b', kind: 'line' },
          { id: 'r', kind: 'line' },
          { id: 't', kind: 'line' },
          { id: 'l', kind: 'line' },
          { id: 'a1', kind: 'arc' },
          { id: 'a2', kind: 'arc' },
          { id: 'a3', kind: 'arc' },
          { id: 'a4', kind: 'arc' },
        ],
        initial: {
          b: [5, 0, 75, 0],
          r: [80, 5, 80, 55],
          t: [75, 60, 5, 60],
          l: [0, 55, 0, 5],
          a1: [5, 5, 5, 180, 270],
          a2: [75, 5, 5, 270, 360],
          a3: [75, 55, 5, 0, 90],
          a4: [5, 55, 5, 90, 180],
        },
        constraints: [],
      }],
    }
    const byHand = await runHeadless({ doc: handDoc, steps: [extrude(10)] })
    expect(byHand.ok).toBe(true)
    const measuredHand = await measureHeadless(byHand.doc!)
    expect(measuredHand?.ok).toBe(true)
    expect(measuredHand!.measures.volume).toBeCloseTo(measuredRounded!.measures.volume, 6)

    const roundedSketch = sketchOf(rounded.doc!)
    const handSketch = sketchOf(byHand.doc!)
    expect((roundedSketch.entities ?? []).length).toBe((handSketch.entities ?? []).length)
    expect(centres(rounded.doc!)).toEqual(centres(byHand.doc!))
    expect((roundedSketch.constraints ?? []).filter(c => c.kind === 'tangent')).toHaveLength(8)
    expect((roundedSketch.constraints ?? []).filter(c => c.kind === 'coincident')).toHaveLength(8)
  }, 180_000)

  it('the playing_cards plan is (71.5*96.9 - (4-pi)*4.233^2)*2', async () => {
    const built = await run([...rectSteps(71.5, 96.9), filletStep(4.233), extrude(2)])
    expect(built.ok).toBe(true)
    expect(built.features).toEqual([])
    const measured = await measureHeadless(built.doc!)
    expect(measured?.ok).toBe(true)
    expect(measured!.measures.volume).toBeCloseTo(
      (71.5 * 96.9 - (4 - Math.PI) * 4.233 ** 2) * 2,
      6,
    )
    expect(measured!.measures.volume).toBeCloseTo(13825.937618174597, 6)
    expect(centres(built.doc!)).toHaveLength(4)
  }, 180_000)

  it('the din_rail L strip probes the reflex side and makes concentric arcs', async () => {
    const steps: ScriptStep[] = [
      { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
      line('out1', [10, 0, 0, 0]),
      line('out2', [0, 0, 0, 10]),
      line('in1', [0, 10, 1, 10]),
      line('in2', [1, 10, 1, 1]),
      line('in3', [1, 1, 10, 1]),
      line('in4', [10, 1, 10, 0]),
      { mutation: { type: 'fillet_corners', featureId: 'sk1', radius: 1.8, corners: [
        { a: 'out1', aVertex: 'end', b: 'out2', bVertex: 'start' },
      ] } },
      { mutation: { type: 'fillet_corners', featureId: 'sk1', radius: 0.8, corners: [
        { a: 'in3', aVertex: 'start', b: 'in2', bVertex: 'end' },
      ] } },
      extrude(10),
    ]
    // The plan asks for both corners in one step; one step cannot carry two
    // radii, so the two corners are two mutations here. The concentric arcs and
    // the probe behavior are identical.
    const built = await run(steps)
    expect(built.ok).toBe(true)
    expect(built.features).toEqual([])
    const sketch = sketchOf(built.doc!)
    const arcs = (sketch.entities ?? []).filter(entity => entity.kind === 'arc')
    expect(arcs).toHaveLength(2)
    const params = arcs.map(entity => (sketch.initial ?? {})[entity.id])
    expect(params.map(p => [p[0], p[1]])).toEqual([[1.8, 1.8], [1.8, 1.8]])
    expect(params.map(p => p[2]).sort((a, b) => a - b)).toEqual([0.8, 1.8])
    const measured = await measureHeadless(built.doc!)
    expect(measured?.ok).toBe(true)
    expect(measured!.measures.volume).toBeCloseTo(184.42035224833364, 6)
  }, 180_000)
})
