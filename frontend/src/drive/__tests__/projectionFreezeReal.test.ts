// @vitest-environment node
//
// The freeze feature end to end: a projected boss is frozen, the source body is
// moved, and neither the frozen sketch nor its extrude follows. A failing
// projection (its source deleted) still freezes in fixed mode, and a refused
// freeze fails the step by name instead of reporting an ok that changed nothing.
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { runHeadless, measureHeadless, seedBuiltins } from '../headlessOps'
import { MUTATION_EXAMPLES } from '../mutationExamples'
import { loadOcc, occInstalled } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}

const ready = oc && solveBytes

function emptyDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}

function example(name: string) {
  const found = MUTATION_EXAMPLES.find(entry => entry.name === name)
  if (!found) throw new Error(`no mutation example '${name}'`)
  return found
}

function sketchOf(doc: PartDoc, id: string): SketchFeature {
  const feature = (doc.features ?? []).find(candidate => candidate.id === id)
  if (feature?.kind !== 'sketch') throw new Error(`no sketch ${id}`)
  return feature
}

const projectionRows = (doc: PartDoc, featureId: string) =>
  (sketchOf(doc, featureId).constraints ?? []).filter(c => c.kind === 'projection')

describe.skipIf(!ready)('frozen projections (real OCC + Rust solver)', () => {
  it('keeps the frozen boss still when the source body moves', async () => {
    const steps = example('projection-freeze').steps
    // Stop before the source move: the first run establishes the frozen state.
    const built = await runHeadless({ doc: emptyDoc(), steps: steps.slice(0, -1), featureDeltas: 'all' })
    expect(built.ok).toBe(true)
    expect(projectionRows(built.doc!, 'sk2')).toEqual([])
    const baked = [...(sketchOf(built.doc!, 'sk2').initial?.pe1 ?? [])]
    expect(baked).toHaveLength(4)
    expect(built.features.find(f => f.id === 'sk2')).toBeUndefined()

    const before = await measureHeadless(built.doc!)
    expect(before!.measures.volume).toBeCloseTo(13000, 3)

    // The last example step translates the source body; the projected edge it
    // used to follow moves with it.
    const moved = await runHeadless({ doc: built.doc!, steps: steps.slice(-1), featureDeltas: 'all' })
    expect(moved.ok).toBe(true)
    const after = await measureHeadless(moved.doc!)
    expect(after!.measures.volume).toBeCloseTo(13000, 3)
    const still = sketchOf(moved.doc!, 'sk2').initial?.pe1 ?? []
    expect(still).toEqual(baked)
    expect(projectionRows(moved.doc!, 'sk2')).toEqual([])

    // With the link gone, the former consumer may move above its source: the
    // reorder guard only protects live projections, and the frozen geometry
    // keeps its position across the new build order.
    const reordered = await runHeadless({
      doc: moved.doc!,
      steps: [{ mutation: { type: 'reorder_features', featureId: 'ex1', after: 'sk2' } }],
    })
    expect(reordered.outcome.steps[0].ok).toBe(true)
    expect(sketchOf(reordered.doc!, 'sk2').initial?.pe1).toEqual(baked)
  }, 180_000)

  it('freezes a face projection into its derived member rows', async () => {
    const topFace = '?15,4,9,15,15,15,15,7;@u|u_42825f874782e937@ex1@body_ex1@sk1/FTWh9huZRvo1rGJ6@sk1/Xkck0RRPy6V4_iVJ@sk1/eKPSVl164lTIlYEW@sk1/usUy8mnQpMYZgmKh@cls_yp:flatface'
    const setup = await runHeadless({
      doc: emptyDoc(),
      steps: [
        ...example('box').steps,
        { mutation: { type: 'add_sketch', featureId: 'sk2', label: 'Face', plane: topFace } },
        { mutation: { type: 'add_projected_entity', featureId: 'sk2', source: topFace } },
      ],
    })
    expect(setup.ok).toBe(true)
    const projection = (sketchOf(setup.doc!, 'sk2').constraints ?? [])
      .find(c => c.kind === 'projection')
    expect(projection).toBeDefined()
    const members = Object.values(projection!.members ?? {})
    expect(members.length).toBeGreaterThan(0)

    const frozen = await runHeadless({
      doc: setup.doc!,
      steps: [{ mutation: { type: 'freeze_projection', featureId: 'sk2', target: projection!.id } }],
    })
    expect(frozen.outcome.steps[0].ok).toBe(true)
    const feature = sketchOf(frozen.doc!, 'sk2')
    expect(feature.constraints?.some(c => c.kind === 'projection')).toBe(false)
    // Members kept their derived ids as document rows, and each is pinned.
    expect((feature.entities ?? []).map(e => e.id).sort()).toEqual([...members].sort())
    expect(feature.constraints?.filter(c => c.kind === 'fixed')).toHaveLength(members.length)
    expect(feature.constraints?.every(c => members.includes(String(c.target).slice(1)))).toBe(true)
    expect(frozen.features.some(problem => problem.id === 'sk2')).toBe(false)
    const baked = Object.fromEntries(members.map(id => [id, feature.initial?.[id]]))

    const moved = await runHeadless({
      doc: frozen.doc!,
      steps: [{
        mutation: {
          type: 'add_transform', featureId: 'tr1', label: 'Move source',
          bodies: ['@body_ex1'], operation: 'replace', translation: [20, 0, 0],
        },
      }],
    })
    expect(moved.ok).toBe(true)
    const after = sketchOf(moved.doc!, 'sk2')
    for (const id of members) expect(after.initial?.[id]).toEqual(baked[id])
  }, 180_000)

  it('hashes the same whether or not the document was solved first', async () => {
    const steps = example('projection-freeze').steps
    const cold = await runHeadless({ doc: emptyDoc(), steps })
    const start = emptyDoc()
    await measureHeadless(start)  // settle the starting document without editing it
    const warm = await runHeadless({ doc: start, steps })
    expect(warm.docHash).toBe(cold.docHash)
    expect(warm.doc).toEqual(cold.doc)
  }, 180_000)

  it('freezes a failing projection that still keeps its last position', async () => {
    // Only the box and the sketch that projects one of its edges: deleting the
    // extrude makes the source unresolvable while the held line keeps its baked
    // position. Freezing in fixed mode must leave no sketch warning at all.
    const setup = await runHeadless({
      doc: emptyDoc(),
      steps: [
        ...example('box').steps,
        { mutation: { type: 'add_sketch', featureId: 'sk2', label: 'Held', plane: '@builtin_plane_top' } },
        {
          mutation: {
            type: 'add_projected_entity', featureId: 'sk2', kind: 'line',
            source: '?15,4,9,15,7,7;@u|e_37a33df87b666c99@ex1@body_ex1@sk1/Xkck0RRPy6V4_iVJ@cls_yp@cls_zp:straightedge',
            entityId: 'pe1',
          },
        },
      ],
    })
    expect(setup.ok).toBe(true)
    const baked = [...(sketchOf(setup.doc!, 'sk2').initial?.pe1 ?? [])]

    const failed = await runHeadless({
      doc: setup.doc!,
      steps: [{ mutation: { type: 'delete_feature', featureId: 'ex1' } }],
    })
    expect(failed.features.some(feature => feature.id === 'sk2')).toBe(true)

    const frozen = await runHeadless({
      doc: failed.doc!,
      steps: [{ mutation: { type: 'freeze_projection', featureId: 'sk2', target: 'pe1' } }],
    })
    expect(frozen.ok).toBe(true)
    expect(frozen.outcome.steps[0].ok).toBe(true)
    expect(projectionRows(frozen.doc!, 'sk2')).toEqual([])
    expect(sketchOf(frozen.doc!, 'sk2').constraints?.filter(c => c.kind === 'fixed')).toHaveLength(1)
    expect(sketchOf(frozen.doc!, 'sk2').initial?.pe1).toEqual(baked)
    expect(frozen.features.some(feature => feature.id === 'sk2')).toBe(false)
  }, 180_000)

  it('fails a freeze that names no projection', async () => {
    const setup = await runHeadless({ doc: emptyDoc(), steps: example('box').steps })
    expect(setup.ok).toBe(true)
    const refused = await runHeadless({
      doc: setup.doc!,
      steps: [{ mutation: { type: 'freeze_projection', featureId: 'sk1', target: 'l1' } }],
    })
    expect(refused.outcome.steps[0].ok).toBe(false)
    expect(refused.outcome.steps[0].error?.message).toContain('names no projection')
  }, 180_000)

  it('fails a freeze of a projection that never had a position', async () => {
    const doc = seedBuiltins({
      version: 1, kind: 'part',
      features: [{
        id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'e1', kind: 'line' }],
        constraints: [{ id: 'proj_e1', kind: 'projection', target: '$e1', source: '@missing/e1' }],
      }],
    } as PartDoc)
    const refused = await runHeadless({
      doc,
      steps: [{ mutation: { type: 'freeze_projection', featureId: 'sk1', target: 'e1' } }],
    })
    expect(refused.outcome.steps[0].ok).toBe(false)
    expect(refused.outcome.steps[0].error?.message).toContain('no position')
    expect(refused.outcome.steps[0].error?.message).toContain('delete the projection')
  }, 180_000)
})
