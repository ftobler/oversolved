// @vitest-environment node
//
// The mutation boundary is strict about projection sources: a row that can never
// resolve is refused with a named cause, the document is untouched, and the same
// script can still apply a valid later step. A body source is refused against the
// settled solve, so a stale query or a deleted body fails the step instead of
// storing a projection that would report the generic did-not-resolve warning
// forever.
import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { runHeadless, selectHeadless, seedBuiltins } from '../headlessOps'
import { MUTATION_EXAMPLES } from '../mutationExamples'
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

function emptyDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}

const ready = oc && solveBytes

function boxSteps() {
  return MUTATION_EXAMPLES.find(entry => entry.name === 'box')!.steps
}

async function builtBox(): Promise<PartDoc> {
  const built = await runHeadless({ doc: emptyDoc(), steps: boxSteps() })
  expect(built.ok).toBe(true)
  return built.doc!
}

function sketch(id: string, entities: SketchFeature['entities'], initial: Record<string, number[]>): SketchFeature {
  return {
    id, kind: 'sketch', plane: '@builtin_plane_front',
    entities, initial, constraints: [],
  }
}

function push(doc: PartDoc, ...features: SketchFeature[]): PartDoc {
  doc.features!.push(...features)
  return doc
}

const projectionRows = (doc: PartDoc, featureId: string) => {
  const feature = doc.features?.find(candidate => candidate.id === featureId)
  return feature?.kind === 'sketch' ? (feature.constraints ?? []).filter(c => c.kind === 'projection') : []
}

describe.skipIf(!ready)('projection source refusal (real OCC + Rust solver)', () => {
  it('refuses layer-1 sources by name and leaves the document untouched', async () => {
    const base = await builtBox()
    const doc = push(
      structuredClone(base),
      sketch('sk2', [{ id: 'p1', kind: 'point' }, { id: 'q2', kind: 'point' }], { p1: [1, 1], q2: [2, 2] }),
      sketch('sk3', [{ id: 'q3', kind: 'point' }], { q3: [3, 3] }),
    )
    for (const [source, text] of [
      ['@sk2/p1', 'cannot project its own entity'],
      ['@sk9/zz', "names no sketch 'sk9'"],
      ['@sk1/nope', "names no entity 'nope' in sketch 'sk1'"],
      ['@sk3/q3', "forward reference: 'sk3' comes later than 'sk2'"],
    ] as const) {
      const result = await runHeadless({
        doc: structuredClone(doc),
        docId: `refuse-${source}`,
        steps: [{
          mutation: { type: 'add_projected_entity', featureId: 'sk2', kind: 'point', source, entityId: 'held' },
          continueOnError: true,
        }, {
          mutation: { type: 'add_projected_entity', featureId: 'sk2', kind: 'point', source: '@builtin_origin', entityId: 'valid' },
        }],
      })
      const refused = result.outcome.steps[0]
      expect(refused.ok, source).toBe(false)
      expect(refused.error?.message, source).toContain(text)
      // The refused step wrote no projection and no held entity.
      expect(projectionRows(result.doc!, 'sk2').map(c => c.source), source).not.toContain(source)
      const sk2 = result.doc!.features!.find(feature => feature.id === 'sk2')
      if (sk2?.kind === 'sketch') {
        expect(sk2.entities!.some(entity => entity.id === 'held'), source).toBe(false)
      }
      // A valid later step in the same run still applies.
      expect(result.outcome.steps[1].ok, source).toBe(true)
      expect(projectionRows(result.doc!, 'sk2').some(c => c.source === '@builtin_origin'), source).toBe(true)
    }
  }, 180_000)

  it('refuses a $ chain that closes on the target', async () => {
    const base = await builtBox()
    const sk2 = sketch('sk2', [
      { id: 'qa', kind: 'point' }, { id: 'qb', kind: 'point' },
    ], { qa: [1, 1], qb: [2, 2] })
    sk2.constraints = [
      { id: 'p_qa', kind: 'projection', target: '$qa', source: '$qb' },
      { id: 'p_qb', kind: 'projection', target: '$qb', source: '$qa' },
    ]
    const doc = push(structuredClone(base), sk2)
    const result = await runHeadless({
      doc,
      docId: 'refuse-cycle',
      steps: [{
        mutation: { type: 'add_projected_entity', featureId: 'sk2', kind: 'point', source: '$qa', entityId: 'qd' },
      }],
    })
    expect(result.outcome.steps[0].ok).toBe(false)
    expect(result.outcome.steps[0].error?.message).toContain('cycle: $qa follows')
    expect(projectionRows(result.doc!, 'sk2')).toHaveLength(2)
  }, 180_000)

  it('refuses an unknown vertex suffix', async () => {
    const base = await builtBox()
    const doc = push(
      structuredClone(base),
      sketch('sk2', [{ id: 'l1', kind: 'line' }], { l1: [0, 0, 10, 0] }),
      sketch('sk3', [], {}),
    )
    const result = await runHeadless({
      doc,
      docId: 'refuse-vertex',
      steps: [{
        mutation: { type: 'add_projected_entity', featureId: 'sk3', kind: 'point', source: '@sk2/l1/nope' },
      }],
    })
    expect(result.outcome.steps[0].ok).toBe(false)
    expect(result.outcome.steps[0].error?.message).toContain("names no vertex 'nope'")
    expect(projectionRows(result.doc!, 'sk3')).toHaveLength(0)
  }, 180_000)

  it('refuses a body query a missing body never resolved', async () => {
    const base = await builtBox()
    const doc = push(structuredClone(base), sketch('sk2', [], {}))
    const result = await runHeadless({
      doc,
      docId: 'refuse-missing-body',
      steps: [{
        mutation: {
          type: 'add_projected_entity', featureId: 'sk2', kind: 'line',
          source: '?d,4;@u|e_deadbeef@ex1:straightedge',
        },
      }],
    })
    expect(result.outcome.steps[0].ok).toBe(false)
    expect(result.outcome.steps[0].error?.message).toContain('did not resolve against the last solve')
    expect(projectionRows(result.doc!, 'sk2')).toHaveLength(0)
  }, 180_000)

  it('refuses a query whose body was deleted earlier in the same run', async () => {
    const base = await builtBox()
    const edges = (await selectHeadless(base, {
      kind: 'edge',
      where: { parallel: [0, 1, 0] },
    }))!.queries
    expect(edges.length).toBeGreaterThan(0)
    const doc = push(structuredClone(base), sketch('sk2', [], {}))
    const result = await runHeadless({
      doc,
      docId: 'refuse-stale-body',
      steps: [
        { mutation: { type: 'delete_feature', featureId: 'ex1' } },
        {
          mutation: { type: 'add_projected_entity', featureId: 'sk2', kind: 'line', source: edges[0] },
        },
      ],
    })
    expect(result.outcome.steps[0].ok).toBe(true)
    expect(result.outcome.steps[1].ok).toBe(false)
    expect(result.outcome.steps[1].error?.message).toContain('did not resolve against the last solve')
    expect(projectionRows(result.doc!, 'sk2')).toHaveLength(0)
  }, 180_000)

  it('refuses a source entity deleted earlier in the same run', async () => {
    const base = await builtBox()
    const doc = push(
      structuredClone(base),
      sketch('sk2', [{ id: 'l1', kind: 'line' }], { l1: [0, 0, 10, 0] }),
      sketch('sk3', [], {}),
    )
    const result = await runHeadless({
      doc,
      docId: 'refuse-deleted-source',
      steps: [
        { mutation: { type: 'delete', targets: ['entity:sk2:l1'] } },
        {
          mutation: { type: 'add_projected_entity', featureId: 'sk3', kind: 'line', source: '@sk2/l1' },
        },
      ],
    })
    expect(result.outcome.steps[1].ok).toBe(false)
    expect(result.outcome.steps[1].error?.message).toContain("names no entity 'l1' in sketch 'sk2'")
    expect(projectionRows(result.doc!, 'sk3')).toHaveLength(0)
  }, 180_000)

  it('reports a hand-built dangling projection as unpositioned', async () => {
    const base = await builtBox()
    const dangling = sketch('sk2', [{ id: 'held', kind: 'point' }], {})
    dangling.constraints = [{
      id: 'proj_held', kind: 'projection', target: '$held', source: '@sk9/nope',
    }]
    const result = await runHeadless({
      doc: push(structuredClone(base), dangling),
      docId: 'hand-built-dangling',
      steps: [],
    })
    expect(result.ok).toBe(true)
    const row = result.features.find(feature => feature.id === 'sk2')
    expect(row).toBeDefined()
    expect(row!.projectionErrors).toEqual({ keeps_last_position: [], unpositioned: ['proj_held'] })
  }, 180_000)

  it('notes the projections a source delete freezes, and stays ok', async () => {
    const base = await builtBox()
    const doc = push(
      structuredClone(base),
      sketch('skA', [{ id: 'l1', kind: 'line' }], { l1: [0, 0, 10, 0] }),
      sketch('skB', [{ id: 'p1', kind: 'point' }], { p1: [2, 2] }),
    )
    const skB = doc.features!.find(feature => feature.id === 'skB')
    if (skB?.kind !== 'sketch') throw new Error('not a sketch')
    skB.constraints = [{ id: 'proj_p1', kind: 'projection', target: '$p1', source: '@skA/l1' }]
    const result = await runHeadless({
      doc,
      docId: 'delete-note',
      steps: [{ mutation: { type: 'delete', targets: ['entity:skA:l1'] } }],
      featureDeltas: 'all',
    })
    expect(result.ok).toBe(true)
    expect(result.outcome.steps[0].ok).toBe(true)
    expect(result.notes?.some(note => note.text === 'skB/p1 projected skA/l1 and keep their last position; convert them to fixed to unlink them')).toBe(true)
    const row = result.features.find(feature => feature.id === 'skB')
    expect(row?.projectionErrors).toEqual({ keeps_last_position: ['proj_p1'], unpositioned: [] })
    const delta = result.featureDeltas?.find(entry => entry.id === 'skB')
    expect(delta?.projectionErrors).toEqual({ keeps_last_position: ['proj_p1'], unpositioned: [] })
  }, 180_000)

  it('refuses a reorder that would put a consumer above its source', async () => {
    const base = await builtBox()
    const doc = push(
      structuredClone(base),
      sketch('skA', [{ id: 'l1', kind: 'line' }], { l1: [0, 0, 10, 0] }),
      sketch('skB', [{ id: 'p1', kind: 'point' }], { p1: [2, 2] }),
      sketch('skC', [], {}),
    )
    const skB = doc.features!.find(feature => feature.id === 'skB')
    if (skB?.kind !== 'sketch') throw new Error('not a sketch')
    skB.constraints = [{ id: 'proj_p1', kind: 'projection', target: '$p1', source: '@skA/l1' }]
    const refused = await runHeadless({
      doc,
      docId: 'reorder-refused',
      steps: [{ mutation: { type: 'reorder_features', featureId: 'skA', after: 'skB' } }],
    })
    expect(refused.outcome.steps[0].ok).toBe(false)
    expect(refused.outcome.steps[0].error?.message).toContain(
      'cannot move skA below skB: skB projects @skA/l1 (a sketch can only project earlier sketches)',
    )
    // The refused move left the order as it was.
    const order = refused.doc!.features!.map(feature => feature.id)
    expect(order.indexOf('skA')).toBeLessThan(order.indexOf('skB'))

    // A move no projection cares about still applies.
    const free = await runHeadless({
      doc,
      docId: 'reorder-free',
      steps: [{ mutation: { type: 'reorder_features', featureId: 'skC', before: 'skA' } }],
    })
    expect(free.outcome.steps[0].ok).toBe(true)
    const freeOrder = free.doc!.features!.map(feature => feature.id)
    expect(freeOrder.indexOf('skC')).toBeLessThan(freeOrder.indexOf('skA'))
  }, 180_000)
})
