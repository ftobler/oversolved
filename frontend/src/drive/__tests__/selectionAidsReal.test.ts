// @vitest-environment node
//
// The real-kernel half of selector picks in `add_sketch.plane` /
// `set_feature_plane.plane`, `add_shell.faces`, `add_fillet.edges` /
// `add_chamfer.edges` and `add_projected_entity.source`: the headless drive
// resolves the `select` selector against the settled solve and stores the query
// strings, so an agent does not paste a long `?...` string per sketch or pick
// (batch B friction). This half proves the one-step path, the chained run's
// first-step solve, and the refusals; the synthetic-input half is
// selectionAids.test.ts.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, selectHeadless, seedBuiltins } from '../headlessOps'
import { createHeadlessPart } from '../headlessPart'
import { MUTATION_EXAMPLES } from '../mutationExamples'
import { createDriveJournal } from '../journal'
import { replayJournal } from '../replay'
import { docHashOf } from '../docHash'
import { featureById } from '@/testing/featureAccess'
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
function emptyDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}
const ready = oc && solveBytes
const step = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)
describe.skipIf(!ready)('selector picks through the headless drive (real OCC)', () => {
  it('places a sketch on the selector face in one step and stores the query', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const base = built.doc!
    const faces = (await selectHeadless(base, {
      kind: 'face',
      where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] },
    }))!.queries
    expect(faces).toHaveLength(1)

    // The selector is resolved against a solve of the starting document, which
    // this run has not done yet: the drive solves once before the first step.
    const oneStep = await runHeadless({
      doc: structuredClone(base),
      steps: [step({
        type: 'add_sketch', featureId: 'sk2', label: 'On face',
        plane: { selector: { kind: 'face', where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] } } },
      })],
    })
    expect(oneStep.ok).toBe(true)
    const sketch = oneStep.doc?.features?.find(feature => feature.id === 'sk2')
    expect(sketch?.kind === 'sketch' ? sketch.plane : undefined).toBe(faces[0])
    expect(oneStep.frames?.sk2).toBeDefined()
  }, 240_000)

  it('moves an existing sketch onto a selector face in one step', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const base = built.doc!
    const faces = (await selectHeadless(base, {
      kind: 'face',
      where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] },
    }))!.queries
    expect(faces).toHaveLength(1)

    const moved = await runHeadless({
      doc: structuredClone(base),
      steps: [step({
        type: 'set_feature_plane', featureId: 'sk1',
        plane: { selector: { kind: 'face', where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] } } },
      })],
    })
    expect(moved.ok).toBe(true)
    const sketch = moved.doc?.features?.find(feature => feature.id === 'sk1')
    expect(sketch?.kind === 'sketch' ? sketch.plane : undefined).toBe(faces[0])
  }, 240_000)

  it('refuses a plane selector matching both the top and bottom face, naming the count', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)

    const refused = await runHeadless({
      doc: structuredClone(built.doc!),
      steps: [step({
        type: 'add_sketch', featureId: 'sk2',
        plane: { selector: { kind: 'face', where: { parallel: [0, 1, 0] } } },
      })],
    })
    expect(refused.ok).toBe(false)
    expect(refused.outcome.steps[0].error?.message).toContain('exactly one face')
  }, 240_000)

  it('opens a shell with a face selector, matching the explicit query string', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const base = built.doc!
    const faces = (await selectHeadless(base, {
      kind: 'face',
      where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] },
    }))!.queries
    expect(faces).toHaveLength(1)

    const bySelector = await runHeadless({
      doc: structuredClone(base),
      steps: [step({
        type: 'add_shell', featureId: 'sh1', label: 'Shell',
        faces: [{ selector: { kind: 'face', where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] } } }],
        thickness: 1, direction: 'inward',
      })],
    })
    const byQuery = await runHeadless({
      doc: structuredClone(base),
      steps: [step({ type: 'add_shell', featureId: 'sh1', label: 'Shell', faces, thickness: 1, direction: 'inward' })],
    })
    expect(bySelector.ok).toBe(true)
    expect(byQuery.ok).toBe(true)
    expect(bySelector.doc?.features?.find(feature => feature.id === 'sh1'))
      .toEqual(byQuery.doc?.features?.find(feature => feature.id === 'sh1'))
    const one = await measureHeadless(bySelector.doc!)
    const two = await measureHeadless(byQuery.doc!)
    expect(one!.measures.volume).toBeCloseTo(two!.measures.volume, 9)
  }, 240_000)

  it('journals the resolved edge queries, so a selector step replays identically', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const edges = (await selectHeadless(built.doc!, {
      kind: 'edge',
      where: { parallel: [0, 1, 0] },
    }))!.queries
    expect(edges).toHaveLength(4)

    const journal = createDriveJournal(built.doc!)
    const run = await runHeadless({
      doc: structuredClone(built.doc!),
      docId: 'edge-selector-journal',
      steps: [step({
        type: 'add_fillet', featureId: 'fi1',
        edges: [{ selector: { kind: 'edge', where: { parallel: [0, 1, 0] } } }],
        radius: 1,
      })],
      journal,
    })
    expect(run.ok).toBe(true)
    const recorded = journal.entries()
      .map(entry => entry.payload)
      .find(payload => !Array.isArray(payload) && payload.type === 'add_fillet')
    expect(recorded).toBeDefined()
    expect((recorded as { edges: unknown[] }).edges).toEqual(edges)
    expect((recorded as { edges: unknown[] }).edges.every(edge => typeof edge === 'string')).toBe(true)

    const repro = journal.repro()!
    const fresh = createHeadlessPart({ doc: structuredClone(repro.doc) as PartDoc, docId: 'edge-selector-replay' })
    const replay = await replayJournal(repro, fresh.session, () => fresh.idle())
    expect(replay.ok).toBe(true)
    expect(replay.finalHash).toBe(docHashOf(run.doc as PartDoc))
  }, 240_000)

  it('fillets every edge a selector matches in one step and stores the queries', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const edges = (await selectHeadless(built.doc!, {
      kind: 'edge',
      where: { parallel: [0, 1, 0] },
    }))!.queries
    expect(edges).toHaveLength(4)

    const filleted = await runHeadless({
      doc: structuredClone(built.doc!),
      steps: [step({
        type: 'add_fillet', featureId: 'fi1',
        edges: [{ selector: { kind: 'edge', where: { parallel: [0, 1, 0] } } }],
        radius: 1,
      })],
    })
    expect(filleted.ok).toBe(true)
    expect(filleted.features.find(problem => problem.id === 'fi1')).toBeUndefined()
    const feature = filleted.doc?.features?.find(candidate => candidate.id === 'fi1')
    expect(feature?.kind).toBe('fillet')
    if (feature?.kind !== 'fillet') return
    expect(feature.fillet.edges).toEqual(edges)
    expect(feature.fillet.edges.length).toBeGreaterThan(1)
  }, 240_000)

  it('chamfers every edge a selector matches in one step and stores the queries', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const edges = (await selectHeadless(built.doc!, {
      kind: 'edge',
      where: { parallel: [0, 1, 0] },
    }))!.queries
    expect(edges).toHaveLength(4)

    const chamfered = await runHeadless({
      doc: structuredClone(built.doc!),
      steps: [step({
        type: 'add_chamfer', featureId: 'ch1',
        edges: [{ selector: { kind: 'edge', where: { parallel: [0, 1, 0] } } }],
        distance: 1,
      })],
    })
    expect(chamfered.ok).toBe(true)
    expect(chamfered.features.find(problem => problem.id === 'ch1')).toBeUndefined()
    const feature = chamfered.doc?.features?.find(candidate => candidate.id === 'ch1')
    expect(feature?.kind).toBe('chamfer')
    if (feature?.kind !== 'chamfer') return
    expect(feature.chamfer.edges).toEqual(edges)
    expect(feature.chamfer.edges.length).toBeGreaterThan(1)
  }, 240_000)

  it('projects a body edge named by a selector in one step, matching the pasted query', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const base = built.doc!
    const faceSelector = {
      kind: 'face',
      where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] },
    }
    // A single edge of the box's top face: four of its edges run along x, the Y
    // extreme keeps the two on the face, and the Z extreme keeps the one whose
    // midpoint is highest in z. The Top plane's y axis is -Z, so the rect spans
    // z -30..0 and that edge runs (0,10,0)-(40,10,0); the test asserts its 2D
    // position below, so a changed frame fails here rather than passing quietly.
    const edgeSelector = {
      kind: 'edge',
      where: {
        and: [
          { type: 'line' },
          { parallel: [1, 0, 0] },
          { extreme: { axis: [0, 1, 0], side: 'max' } },
          { extreme: { axis: [0, 0, 1], side: 'max' } },
        ],
      },
    }
    const faces = (await selectHeadless(base, faceSelector))!.queries
    const edges = (await selectHeadless(base, edgeSelector))!.queries
    expect(faces).toHaveLength(1)
    expect(edges).toHaveLength(1)

    const start = [
      step({ type: 'add_sketch', featureId: 'sk2', label: 'On face', plane: { selector: faceSelector } }),
      step({ type: 'add_projected_entity', featureId: 'sk2', source: { selector: edgeSelector }, entityId: 'pe1' }),
    ]
    const pasted = [
      step({ type: 'add_sketch', featureId: 'sk2', label: 'On face', plane: faces[0] }),
      step({ type: 'add_projected_entity', featureId: 'sk2', kind: 'line', source: edges[0], entityId: 'pe1' }),
    ]
    const bySelector = await runHeadless({ doc: structuredClone(base), steps: start })
    const byQuery = await runHeadless({ doc: structuredClone(base), steps: pasted })
    expect(bySelector.ok).toBe(true)
    expect(byQuery.ok).toBe(true)
    expect(bySelector.part.solveOutcomes().sk2.status).toBe('fully_constrained')
    expect(byQuery.part.solveOutcomes().sk2.status).toBe('fully_constrained')

    // The document stores the query `select` returned, never the selector, and
    // the omitted kind was inferred from the matched line edge.
    const sketch = featureById(bySelector.doc!, 'sk2', 'sketch')
    const projection = sketch.constraints!.find(constraint => constraint.kind === 'projection')!
    expect(projection.source).toBe(edges[0])
    expect(sketch.entities!.find(entity => entity.id === 'pe1')!.kind).toBe('line')
    // The projection holds the edge's own 2D position in the face frame, whose
    // origin is the face centroid: the 40-long edge spans x -20..20 and sits 15
    // off the centroid across it, not at the origin an unanchored sketch uses.
    const params = sketch.initial!.pe1
    expect(Math.min(params[0], params[2])).toBeCloseTo(-20, 6)
    expect(Math.max(params[0], params[2])).toBeCloseTo(20, 6)
    expect(params[1]).toBeCloseTo(params[3], 9)
    expect(Math.abs(params[1])).toBeCloseTo(15, 6)

    expect(docHashOf(bySelector.doc!)).toBe(docHashOf(byQuery.doc!))
  }, 240_000)
})
