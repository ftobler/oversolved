// @vitest-environment node
//
// Selector picks in `add_sketch.plane` / `set_feature_plane.plane` and
// `add_shell.faces`: the headless drive resolves the `select` selector against
// the settled solve and stores the query string, so an agent does not paste a
// long `?...` string per sketch (batch B friction). The unit half runs on
// synthetic solve results; the real half proves the one-step path, the chained
// run's first-step solve, and the refusals.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { BodyResult, FaceData, EdgeData, PartDoc } from '@/types/cad'
import { makeAncestryQuery } from '@/kernel/query'
import { resolveSelectionAids, usesSelectionAid } from '../selectionAids'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { runHeadless, measureHeadless, selectHeadless, seedBuiltins } from '../headlessOps'
import { MUTATION_EXAMPLES } from '../mutationExamples'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import type { ScriptStep } from '../scriptRunner'

type V3 = [number, number, number]

function q(bodyId: string, tokens: string[], type: string): string {
  return makeAncestryQuery([`@${bodyId}`, ...tokens], type)
}

function face(centroid: V3, normal: V3): FaceData {
  return { centroid, normal, surface_type: 'flatface' }
}

/** Two bodies, each with one flat face: body_a's faces +Z and -Z, body_b's +Z. */
function twoBodies(): Record<string, BodyResult> {
  const body = (id: string, faces: FaceData[]): BodyResult => ({
    id,
    created_by: 'ex1',
    modified_by: [],
    edges: [] as EdgeData[],
    edge_queries: [],
    mesh: {
      vertices: [], faces: [], face_data: faces,
      face_queries: faces.map((f, i) => q(id, [`@u|f_${i}`], f.surface_type!)),
      face_edge_queries: faces.map(() => []),
    },
  })
  return {
    body_a: body('body_a', [face([5, 5, 10], [0, 0, 1]), face([5, 5, 0], [0, 0, -1])]),
    body_b: body('body_b', [face([15, 5, 10], [0, 0, 1])]),
  }
}

const planeSelector = { selector: { kind: 'face', where: { parallel: [0, 0, 1] } } }

describe('resolveSelectionAids', () => {
  it('leaves a step without a selector untouched', () => {
    const step = { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' }
    const resolved = resolveSelectionAids(step, twoBodies())
    expect(resolved.ok).toBe(true)
    expect(resolved.ok && resolved.mutation).toBe(step)
  })

  it('rewrites a sketch plane selector into the one face query it matched', () => {
    const bodies = { body_b: twoBodies().body_b }
    const resolved = resolveSelectionAids({ type: 'add_sketch', featureId: 'sk1', plane: planeSelector }, bodies)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.mutation).toEqual({
      type: 'add_sketch', featureId: 'sk1', plane: q('body_b', ['@u|f_0'], 'flatface'),
    })
  })

  it('refuses a plane selector that matches several faces', () => {
    const resolved = resolveSelectionAids({ type: 'add_sketch', featureId: 'sk1', plane: planeSelector }, twoBodies())
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('unresolved-ref')
    expect(resolved.message).toContain('exactly one face')
  })

  it('refuses a selector that matched an edge where faces are required', () => {
    const bodies = twoBodies()
    bodies.body_a.edges = [{ kind: 'line', start: [0, 0, 0], end: [0, 0, 10] }]
    bodies.body_a.edge_queries = [q('body_a', ['@u|e_0'], 'straightedge')]
    const resolved = resolveSelectionAids(
      { type: 'add_shell', featureId: 'sh1', faces: [{ selector: { kind: 'edge' } }] },
      bodies,
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('unresolved-ref')
    expect(resolved.message).toContain('non-face')
  })

  it('refuses a selector that matches nothing as unresolved, not invalid', () => {
    const resolved = resolveSelectionAids(
      { type: 'add_sketch', featureId: 'sk1', plane: { selector: { kind: 'face', where: { parallel: [1, 1, 1] } } } },
      twoBodies(),
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('unresolved-ref')
    expect(resolved.message).toMatch(/no face|matches nothing/i)
  })

  it('refuses a selector naming a body that is not in the solve', () => {
    const resolved = resolveSelectionAids(
      { type: 'add_sketch', featureId: 'sk1', plane: { selector: { kind: 'face', from: 'body_gone' } } },
      twoBodies(),
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('unresolved-ref')
    expect(resolved.message).toContain('body_gone')
  })

  it('refuses a selector with no solved bodies, naming the alternative', () => {
    const resolved = resolveSelectionAids({ type: 'add_sketch', featureId: 'sk1', plane: planeSelector }, null)
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('unresolved-ref')
    expect(resolved.message).toContain('no solved bodies')
    expect(resolved.message).toContain('query string')
  })

  it('refuses a malformed selector as invalid-ref, not a failed match', () => {
    const resolved = resolveSelectionAids(
      { type: 'add_sketch', featureId: 'sk1', plane: { selector: { kind: 'edge', where: { bogus: 1 } } } },
      twoBodies(),
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('invalid-ref')
  })

  it('expands every shell face selector and keeps the string entries', () => {
    const bodies = twoBodies()
    const existing = q('body_a', ['@u|f_1'], 'flatface')
    const resolved = resolveSelectionAids(
      {
        type: 'add_shell', featureId: 'sh1',
        faces: [existing, { selector: { kind: 'face', where: { parallel: [0, 0, 1] } } }],
      },
      bodies,
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect((resolved.mutation as { faces: string[] }).faces).toEqual([
      existing,
      q('body_a', ['@u|f_0'], 'flatface'),
      q('body_b', ['@u|f_0'], 'flatface'),
    ])
  })

  it('reports whether a step needs a solve for its selector', () => {
    expect(usesSelectionAid({ type: 'add_sketch', plane: planeSelector })).toBe(true)
    expect(usesSelectionAid({ type: 'add_sketch', plane: '@builtin_plane_top' })).toBe(false)
    expect(usesSelectionAid({ type: 'add_shell', faces: [planeSelector] })).toBe(true)
    expect(usesSelectionAid({ type: 'add_shell', faces: ['?q'] })).toBe(false)
    expect(usesSelectionAid({ type: 'add_mirror', plane: planeSelector })).toBe(false)
  })

  it('refuses an unresolved selector at the applier instead of dropping it', () => {
    // DocSession.execute and journal replay bypass the value rules; a selector
    // that got that far must be loud, not silently unbind the sketch.
    const doc = seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
    expect(() => mutationHandlers.add_sketch(doc, {
      type: 'add_sketch', featureId: 'sk1', plane: { selector: { kind: 'face' } },
    })).toThrow(/selector/)
    expect(doc.features?.some(feature => feature.id === 'sk1')).toBe(false)
  })
})

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
})
