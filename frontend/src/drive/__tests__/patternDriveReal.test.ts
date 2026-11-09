// @vitest-environment node
//
// The pattern through the drive surface with a real kernel: one `add_pattern`
// call over an authored plate and slot must land the same body the kernel test
// measures, and the reply must report the feature clean. This is the MCP round
// trip: the mutation goes in as JSON, the document comes back and the measured
// volume is the kernel's own answer.
//
// Skips when OCC.js or the sketch solver is absent.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, PartFeature } from '@/types/cad'
import { runHeadless, measureHeadless, seedBuiltins } from '../headlessOps'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
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
const step = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

function rectSketch(id: string, w: number, h: number, x0 = 0, y0 = 0): PartFeature {
  const points: [number, number][] = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]
  const entities = points.map((_, i) => ({ id: `l${i}`, kind: 'line' }))
  const initial: Record<string, number[]> = {}
  const constraints: Record<string, unknown>[] = []
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length]
    initial[`l${i}`] = [a[0], a[1], b[0], b[1]]
    constraints.push({
      id: `c${i}`, kind: 'coincident',
      a: { entity: `l${i}`, point: 'end' },
      b: { entity: `l${(i + 1) % points.length}`, point: 'start' },
    })
    constraints.push({ id: `h${i}`, kind: a[1] === b[1] ? 'horizontal' : 'vertical', target: { entity: `l${i}` } })
  })
  return { id, kind: 'sketch', plane: '@builtin_plane_front', entities, initial, constraints } as unknown as PartFeature
}

/** A 40 x 20 x 5 plate with one 4 x 4 slot cut through it at (6, 6). */
function slottedPlate(cut: {
  distance?: number
  termination?: 'blind' | 'through_all'
  direction?: 'normal' | 'reverse' | 'symmetric'
} = {}): PartDoc {
  return seedBuiltins({
    version: 1,
    kind: 'part',
    features: [
      rectSketch('sk_plate', 40, 20),
      { id: 'ex_plate', kind: 'extrude', extrude: { sketch: '@sk_plate', distance: 5, direction: 'normal', operation: 'new' } },
      rectSketch('sk_slot', 4, 4, 6, 6),
      {
        id: 'ex_slot', kind: 'extrude',
        extrude: {
          sketch: '@sk_slot', distance: cut.distance ?? 10, direction: cut.direction ?? 'normal', operation: 'cut',
          ...(cut.termination === undefined ? {} : { termination: cut.termination }),
        },
      },
    ],
  } as PartDoc)
}

describe.skipIf(!ready)('add_pattern through the drive (real OCC + Rust solver)', () => {
  it('patterns the slot cut and measures four slots in one body', async () => {
    const run = await runHeadless({
      doc: slottedPlate(),
      steps: [step({
        type: 'add_pattern', featureId: 'pt1', label: 'Pattern', subject: 'feature',
        source_feature: '@ex_slot', mode: 'linear', count: 4, pitch: 8, direction: [1, 0, 0],
      })],
    })
    expect(run.ok).toBe(true)
    const feature = run.doc?.features?.find((entry) => entry.id === 'pt1')
    expect(feature).toMatchObject({
      kind: 'pattern',
      pattern: {
        subject: 'feature', source_feature: '@ex_slot', mode: 'linear', count: 4, pitch: 8, direction: [1, 0, 0],
      },
    })
    // The reply's own feature list: the pattern reported clean, and it changed
    // the body the slot cut had already shaped.
    expect(run.features.find((problem) => problem.id === 'pt1')).toBeUndefined()

    const measured = await measureHeadless(run.doc!)
    expect(measured?.ok).toBe(true)
    expect(measured!.features.find((problem) => problem.id === 'pt1')).toBeUndefined()
    // 40 x 20 x 5 minus four 4 x 4 x 5 slots.
    expect(measured!.measures.volume).toBeCloseTo(4000 - 320, 4)
    expect(measured!.measures.bodies).toBe(1)
  }, 240_000)

  it('patterns a through_all cut source the way its blind equivalent builds', async () => {
    // The source cut's tool is measured from the plate the copies will cut, not
    // from the empty scratch store the pattern re-solves into. A cut never
    // grows the plate, so every copy measures the same 5 mm thickness and the
    // pattern matches the blind source with a distance past the plate.
    const run = async (doc: PartDoc) => runHeadless({
      doc,
      steps: [step({
        type: 'add_pattern', featureId: 'pt1', label: 'Pattern', subject: 'feature',
        source_feature: '@ex_slot', mode: 'linear', count: 4, pitch: 8, direction: [1, 0, 0],
      })],
    })
    const through = await run(slottedPlate({ distance: 1, termination: 'through_all' }))
    const blind = await run(slottedPlate({ distance: 10 }))
    expect(through.ok).toBe(true)
    expect(through.features.find(problem => problem.id === 'pt1')).toBeUndefined()

    const throughMeasured = await measureHeadless(through.doc!)
    const blindMeasured = await measureHeadless(blind.doc!)
    expect(throughMeasured?.ok).toBe(true)
    expect(blindMeasured?.ok).toBe(true)
    // 40 x 20 x 5 minus four 4 x 4 x 5 slots, each copy cutting the whole
    // thickness even though the through_all source stores distance 1.
    expect(throughMeasured!.measures.volume).toBeCloseTo(4000 - 4 * 4 * 5 * 4, 4)
    expect(throughMeasured!.measures.volume).toBeCloseTo(blindMeasured!.measures.volume, 4)
  }, 240_000)

  it('patterns a symmetric through_all cut from the bottom face through every copy', async () => {
    // The source sketch sits on Front at z=0, the plate's bottom face. A
    // symmetric tool sized from the union span alone covers only half the 5 mm
    // plate, so both copies would leave a blind pocket.
    const run = await runHeadless({
      doc: slottedPlate({ distance: 1, termination: 'through_all', direction: 'symmetric' }),
      steps: [step({
        type: 'add_pattern', featureId: 'pt1', label: 'Pattern', subject: 'feature',
        source_feature: '@ex_slot', mode: 'linear', count: 2, pitch: 8, direction: [1, 0, 0],
      })],
    })
    expect(run.ok).toBe(true)
    expect(run.features.find(problem => problem.id === 'pt1')).toBeUndefined()

    const measured = await measureHeadless(run.doc!)
    expect(measured?.ok).toBe(true)
    // 40 x 20 x 5 minus two 4 x 4 x 5 slots, each cut through the thickness.
    expect(measured!.measures.volume).toBeCloseTo(4000 - 2 * 4 * 4 * 5, 4)
    expect(measured!.measures.bodies).toBe(1)
  }, 240_000)

  it('reports a copy that misses the plate in the feature list', async () => {
    const doc = slottedPlate()
    // Widen the source slot so the last copy at x=38 hangs off the plate.
    doc.features![2] = rectSketch('sk_slot', 2, 2, 2, 2)
    const run = await runHeadless({
      doc,
      steps: [step({
        type: 'add_pattern', featureId: 'pt1', subject: 'feature', source_feature: '@ex_slot',
        count: 4, pitch: 13, direction: [1, 0, 0],
      })],
    })
    expect(run.ok).toBe(true)
    const problem = run.features.find((entry) => entry.id === 'pt1')
    expect(problem?.status).toBe('partial')
    expect(problem?.message).toContain('2/3 copies applied')
    expect(problem?.message).toContain('copy 3')
  }, 240_000)
})
