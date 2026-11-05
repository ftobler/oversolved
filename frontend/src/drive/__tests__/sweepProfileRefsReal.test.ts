// @vitest-environment node
//
// The profile ref grammar the drive boundary now admits, exercised through the
// real kernel: an entity pick answers with the one curve the user clicked, a
// multisection section refuses a ring by sketch and loop, the two-sweep
// workaround builds the ring while leaving an unrelated body alone, and a slot
// section authored as four entity refs assembles into one loop.
//
// Real kernel, gated like the other drive suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { runHeadless, measureHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import type { PartDoc } from '@/types/cad'
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
const field = (type: string, featureId: string, name: string, value: unknown) =>
  m({ type, featureId, field: name, value })

const L = 20
const R = 5
const r = 3

function row(result: { featureDeltas: FeatureDelta[] | null }, id: string): FeatureDelta {
  const found = result.featureDeltas?.find(candidate => candidate.id === id)
  expect(found, `no featureDeltas row for ${id}`).toBeDefined()
  return found!
}

/** A straight path along +Y from the Top plane to an offset plane L above it. */
function scene(): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: 'path', plane: '@builtin_plane_front' }),
    m({ type: 'add_entity', featureId: 'path', kind: 'line', params: [0, 0, 0, L], entityId: 'spine' }),
    m({ type: 'add_plane', featureId: 'plB', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: L } }),
  ]
}

function ringPair(): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: 'ringA', plane: '@builtin_plane_top' }),
    m({ type: 'add_entity', featureId: 'ringA', kind: 'circle', params: [0, 0, R], entityId: 'outerA' }),
    m({ type: 'add_entity', featureId: 'ringA', kind: 'circle', params: [0, 0, r], entityId: 'innerA' }),
    m({ type: 'add_sketch', featureId: 'ringB', plane: '@plB' }),
    m({ type: 'add_entity', featureId: 'ringB', kind: 'circle', params: [0, 0, R], entityId: 'outerB' }),
    m({ type: 'add_entity', featureId: 'ringB', kind: 'circle', params: [0, 0, r], entityId: 'innerB' }),
  ]
}

describe.skipIf(!ready)('sweep profile refs (real OCC + Rust solver)', () => {
  it('sweeps only the picked circle of a two-circle sketch', async () => {
    const run = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        m({ type: 'add_sketch', featureId: 'sk', plane: '@builtin_plane_top' }),
        m({ type: 'add_entity', featureId: 'sk', kind: 'circle', params: [0, 0, 2], entityId: 'ciA' }),
        m({ type: 'add_entity', featureId: 'sk', kind: 'circle', params: [10, 0, 4], entityId: 'ciB' }),
        m({ type: 'add_sketch', featureId: 'path', plane: '@builtin_plane_front' }),
        m({ type: 'add_entity', featureId: 'path', kind: 'line', params: [0, 0, 0, 10], entityId: 'spine' }),
        m({
          type: 'add_sweep', featureId: 'sw', sketchQuery: 'entity:sk:ciA', pathQuery: '$path',
          operation: 'new',
        }),
      ],
    })
    expect(run.features).toEqual([])
    // A whole-sketch pick would add the r4 disc too; the pick owns pi*2^2*10.
    const measured = await measureHeadless(run.doc as PartDoc)
    expect(Math.abs((measured?.measures.volume ?? 0) - Math.PI * 4 * 10)).toBeLessThan(0.5)
  }, 120_000)

  it('passes a lone line at the boundary and lets the sweep leaf refuse it', async () => {
    const run = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        m({ type: 'add_sketch', featureId: 'lp', plane: '@builtin_plane_top' }),
        m({ type: 'add_entity', featureId: 'lp', kind: 'line', params: [-2, 0, 2, 0], entityId: 'lone' }),
        m({ type: 'add_sketch', featureId: 'path', plane: '@builtin_plane_front' }),
        m({ type: 'add_entity', featureId: 'path', kind: 'line', params: [0, 0, 0, 10], entityId: 'spine' }),
        m({
          type: 'add_sweep', featureId: 'sw', sketchQuery: 'entity:lp:lone', pathQuery: '$path',
          operation: 'new',
        }),
      ],
    })
    const failed = run.features.find(feature => feature.id === 'sw')
    expect(failed?.message).toMatch(/picked profile edges do not form a closed loop \(sketch lp\)/)
  }, 120_000)

  it('refuses a ring section by sketch and loop and names the two-sweep workaround', async () => {
    const run = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        ...scene(),
        ...ringPair(),
        m({ type: 'add_sweep', featureId: 'sw', sketchQuery: '$ringA', pathQuery: '$path' }),
        m({ type: 'add_sweep_profile', featureId: 'sw', sketchQuery: '$ringB' }),
        field('set_sweep_field', 'sw', 'multisection', true),
      ],
    })
    const failed = run.features.find(feature => feature.id === 'sw')
    expect(failed?.message).toContain('sweep: sketch ringA, loop 1 has a hole')
    expect(failed?.message).toContain('a multisection section must be one outer loop')
    expect(failed?.message).toContain('second cut feature, naming its merge_target')
  }, 120_000)

  it('builds the two-sweep workaround and leaves an unrelated body alone', async () => {
    const run = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        ...scene(),
        ...ringPair(),
        // An unrelated rod inside the hole: the inner cut tool would swallow it
        // if the cut did not name its merge_target.
        m({ type: 'add_sketch', featureId: 'rodSk', plane: '@builtin_plane_top' }),
        m({ type: 'add_entity', featureId: 'rodSk', kind: 'circle', params: [0, 0, 2], entityId: 'rodC' }),
        m({ type: 'add_extrude', featureId: 'rod', sketchQuery: '$rodSk', distance: L, operation: 'new' }),
        m({
          type: 'add_sweep', featureId: 'swOuter', sketchQuery: 'entity:ringA:outerA',
          pathQuery: '$path', operation: 'new',
        }),
        m({ type: 'add_sweep_profile', featureId: 'swOuter', sketchQuery: 'entity:ringB:outerB' }),
        field('set_sweep_field', 'swOuter', 'multisection', true),
        m({
          type: 'add_sweep', featureId: 'swInner', sketchQuery: 'entity:ringA:innerA',
          pathQuery: '$path', operation: 'cut', merge_target: 'body_swOuter',
        }),
        m({ type: 'add_sweep_profile', featureId: 'swInner', sketchQuery: 'entity:ringB:innerB' }),
        field('set_sweep_field', 'swInner', 'multisection', true),
      ],
    })
    expect(run.features).toEqual([])
    const tube = Math.PI * (R * R - r * r) * L
    const rod = Math.PI * 4 * L
    const cut = row(run, 'swInner')
    expect(cut.body).toBe('body_swOuter')
    expect(Math.abs((cut.bodyVolume ?? 0) - tube)).toBeLessThan(0.5)
    // The rod is not the cut target, so the total keeps both solids.
    const measured = await measureHeadless(run.doc as PartDoc)
    expect(Math.abs((measured?.measures.volume ?? 0) - (tube + rod))).toBeLessThan(0.5)
  }, 180_000)

  it('names the reorder fix for a profile sketch added after the sweep', async () => {
    // The profile pick was accepted (the boundary checks grammar, not document
    // order), but the sketch sits after the sweep in the list. The solve names
    // the one-step fix instead of the bare "sketch not found".
    const run = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        ...scene(),
        m({ type: 'add_sketch', featureId: 'prof', plane: '@builtin_plane_top' }),
        m({ type: 'add_entity', featureId: 'prof', kind: 'circle', params: [0, 0, 2], entityId: 'pc' }),
        m({ type: 'add_sweep', featureId: 'sw', sketchQuery: '$prof', pathQuery: '$path', operation: 'new' }),
        m({ type: 'add_sketch', featureId: 'late', plane: '@builtin_plane_top' }),
        m({ type: 'add_entity', featureId: 'late', kind: 'circle', params: [0, 0, 1], entityId: 'lc' }),
        m({ type: 'add_sweep_profile', featureId: 'sw', sketchQuery: '$late' }),
      ],
    })
    const problem = run.features.find(feature => feature.id === 'sw')
    expect(problem?.message).toBe(
      "sketch 'late' is defined after this sweep; move it up with reorder_features {featureId: 'late', before: 'sw'}",
    )
    expect(problem?.message).not.toContain('sketch not found')
  }, 120_000)

  it('names the reorder fix for a path sketch added after the sweep', async () => {
    // The same authoring mistake on the path side: a second path sketch was
    // added after the sweep and then picked with add_sweep_path.
    const run = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        ...scene(),
        m({ type: 'add_sketch', featureId: 'prof', plane: '@builtin_plane_top' }),
        m({ type: 'add_entity', featureId: 'prof', kind: 'circle', params: [0, 0, 2], entityId: 'pc' }),
        m({ type: 'add_sweep', featureId: 'sw', sketchQuery: '$prof', pathQuery: '$path', operation: 'new' }),
        m({ type: 'add_sketch', featureId: 'latePath', plane: '@builtin_plane_front' }),
        m({
          type: 'add_entity', featureId: 'latePath', kind: 'line',
          params: [0, 0, 0, 10], entityId: 'spine2',
        }),
        m({ type: 'add_sweep_path', featureId: 'sw', pathQuery: '$latePath' }),
      ],
    })
    const problem = run.features.find(feature => feature.id === 'sw')
    expect(problem?.message).toBe(
      "sketch 'latePath' is defined after this sweep; move it up with reorder_features {featureId: 'latePath', before: 'sw'}",
    )
  }, 120_000)
})
