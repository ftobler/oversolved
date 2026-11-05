// @vitest-environment node
//
// Which body a featureDeltas row names, against the real kernel. The drive
// decides it from the measured change, not from the kernel's `body_id`: a
// disjoint add array keeps its source id but adds only copies, so naming the
// source claims volume the source never gained (build123d topology_selection
// F5). A fused add, a split and a boolean union still name the body they
// changed. `body_id` itself is untouched, so the kernel half is pinned in
// bodySplit/patternBody tests.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { runHeadless, emptyDriveDoc } from '../headlessOps'
import type { PartDoc } from '@/types/cad'
import type { ScriptStep } from '../scriptRunner'
import type { FeatureDelta } from '../featureDeltas'
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
const field = (type: string, featureId: string, f: string, value: unknown) => m({ type, featureId, field: f, value })

function row(result: { featureDeltas: FeatureDelta[] | null }, id: string): FeatureDelta {
  const found = result.featureDeltas?.find(candidate => candidate.id === id)
  expect(found, `no featureDeltas row for ${id}`).toBeDefined()
  return found!
}

// A 100 x 100 x 10 plate (body_ex1) and a 10 x 10 x 30 fin floating 20 above
// it on its own plane (body_ex2), so the array copies touch neither the plate
// nor each other.
const FIN = 10 * 10 * 30
function plateAndFloatingFin(): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' }),
    m({ type: 'add_rect', featureId: 'sk1', p0: [-50, -50], p1: [50, 50] }),
    m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10, operation: 'new' }),
    m({ type: 'add_plane', featureId: 'pl1', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 20 } }),
    m({ type: 'add_sketch', featureId: 'sk2', plane: '@pl1' }),
    m({ type: 'add_rect', featureId: 'sk2', p0: [0, 0], p1: [10, 10] }),
    m({ type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 30, operation: 'new' }),
  ]
}

describe.skipIf(!ready)('featureDeltas body selection (real OCC + Rust solver)', () => {
  it('reports a disjoint add array as changedBodyCount, never the untouched source', async () => {
    const base = await runHeadless({ doc: emptyDriveDoc(), steps: plateAndFloatingFin() })
    expect(base.features).toEqual([])
    expect(base.bodies).toEqual(['body_ex1', 'body_ex2'])

    // The 2 x 2 grid skips the seed cell, so the source keeps its body and
    // three copies are minted as body_ex2_1.._3.
    const arrayed = await runHeadless({
      doc: base.doc as PartDoc,
      steps: [m({
        type: 'add_pattern', featureId: 'ar1', subject: 'body', source_body: 'body_ex2',
        operation: 'add', include_source: true, mode: 'rectangular',
        count_x: 2, count_y: 2, pitch_x: 40, pitch_y: 40,
        direction_x: [1, 0, 0], direction_y: [0, 1, 0],
      })],
    })
    expect(arrayed.features).toEqual([])
    expect(arrayed.bodies).toEqual(['body_ex1', 'body_ex2', 'body_ex2_1', 'body_ex2_2', 'body_ex2_3'])

    const arrayRow = row(arrayed, 'ar1')
    expect(arrayRow.body).toBeUndefined()
    expect(arrayRow.bodyVolume).toBeUndefined()
    expect(arrayRow.changedBodyCount).toBe(3)
    expect(arrayRow.volumeDelta).toBeCloseTo(3 * FIN, 3)
  }, 240_000)

  it('names the receiving body of a boolean union and its own volume', async () => {
    const box = (n: number, x0: number): ScriptStep[] => [
      m({ type: 'add_sketch', featureId: `skb${n}`, plane: '@builtin_plane_front' }),
      m({ type: 'add_rect', featureId: `skb${n}`, p0: [x0, 0], p1: [x0 + 40, 30] }),
      m({ type: 'add_extrude', featureId: `ex${n}`, sketchQuery: `$skb${n}`, distance: 20 }),
      field('set_extrude_field', `ex${n}`, 'direction', 'symmetric'),
      field('set_extrude_field', `ex${n}`, 'operation', 'new'),
    ]
    const built = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        ...box(1, 0),
        ...box(2, 20),
        m({ type: 'add_boolean', featureId: 'bo1', operation: 'union', target: 'body_ex1', tools: ['body_ex2'] }),
      ],
    })
    expect(built.features).toEqual([])
    expect(built.bodies).toEqual(['body_ex1'])
    // Two 24000 boxes overlapping over 20 x 30 x 20.
    const unionRow = row(built, 'bo1')
    expect(unionRow.body).toBe('body_ex1')
    expect(unionRow.bodyVolume).toBeCloseTo(36000, 3)
    expect(unionRow).not.toHaveProperty('changedBodyCount')
  }, 120_000)

  it('names the preferred first half of a split and counts both changed bodies', async () => {
    const built = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' }),
        m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [100, 20] }),
        m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10, operation: 'new' }),
        m({ type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_top' }),
        m({ type: 'add_rect', featureId: 'sk2', p0: [49, 0], p1: [51, 20] }),
        m({ type: 'add_extrude', featureId: 'cut1', sketchQuery: '$sk2', distance: 30 }),
        field('set_extrude_field', 'cut1', 'direction', 'symmetric'),
        field('set_extrude_field', 'cut1', 'operation', 'cut'),
      ],
    })
    expect(built.features).toEqual([])
    expect(built.bodies).toEqual(['body_ex1', 'body_ex1_1'])

    const splitRow = row(built, 'cut1')
    expect(splitRow.body).toBe('body_ex1')
    expect(splitRow.bodyVolume).toBeCloseTo(49 * 20 * 10, 3)
    expect(splitRow.changedBodyCount).toBe(2)
    expect(splitRow.volumeDelta).toBeCloseTo(2 * 49 * 20 * 10 - 20000, 3)
  }, 120_000)
})
