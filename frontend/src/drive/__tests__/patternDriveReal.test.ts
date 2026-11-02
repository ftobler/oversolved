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
function slottedPlate(): PartDoc {
  return seedBuiltins({
    version: 1,
    kind: 'part',
    features: [
      rectSketch('sk_plate', 40, 20),
      { id: 'ex_plate', kind: 'extrude', extrude: { sketch: '@sk_plate', distance: 5, direction: 'normal', operation: 'new' } },
      rectSketch('sk_slot', 4, 4, 6, 6),
      { id: 'ex_slot', kind: 'extrude', extrude: { sketch: '@sk_slot', distance: 10, direction: 'normal', operation: 'cut' } },
    ],
  } as PartDoc)
}

describe.skipIf(!ready)('add_pattern through the drive (real OCC + Rust solver)', () => {
  it('patterns the slot cut and measures four slots in one body', async () => {
    const run = await runHeadless({
      doc: slottedPlate(),
      steps: [step({
        type: 'add_pattern', featureId: 'pt1', label: 'Pattern',
        source_feature: '@ex_slot', mode: 'linear', count: 4, pitch: 8, direction: [1, 0, 0],
      })],
    })
    expect(run.ok).toBe(true)
    const feature = run.doc?.features?.find((entry) => entry.id === 'pt1')
    expect(feature).toMatchObject({
      kind: 'pattern',
      pattern: { source_feature: '@ex_slot', mode: 'linear', count: 4, pitch: 8, direction: [1, 0, 0] },
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

  it('reports a copy that misses the plate in the feature list', async () => {
    const doc = slottedPlate()
    // Widen the source slot so the last copy at x=38 hangs off the plate.
    doc.features![2] = rectSketch('sk_slot', 2, 2, 2, 2)
    const run = await runHeadless({
      doc,
      steps: [step({
        type: 'add_pattern', featureId: 'pt1', source_feature: '@ex_slot',
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
