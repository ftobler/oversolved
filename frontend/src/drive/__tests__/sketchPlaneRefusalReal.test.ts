// @vitest-environment node
//
// A sketch plane that does not resolve fails the sketch instead of silently
// moving the author's geometry to Front: a plane feature defined later in the
// log (reorder heals it) and a face query an upstream delete stopped resolving.
// Real kernel, gated like the other drive real suites.

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

/** The built box's first sketch, re-authored under another id and plane. The
 *  rectangle is already solved, so the clone lowers like the original. */
function cloneSketch(doc: PartDoc, featureId: string, plane: string): SketchFeature {
  const source = doc.features?.find(feature => feature.kind === 'sketch')
  if (source?.kind !== 'sketch') throw new Error('the box document has no sketch')
  return { ...structuredClone(source), id: featureId, plane }
}

const ready = oc && solveBytes

describe.skipIf(!ready)('sketch plane refusal (real OCC + Rust solver)', () => {
  it('refuses a plane feature defined after the sketch and builds it once reordered', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const doc = built.doc!

    // Authored by hand, as an old document or a hand-edited file can be: the
    // sketch names a plane that only appears further down the log.
    doc.features!.push(cloneSketch(doc, 'sk2', '@pl1'))
    doc.features!.push({
      id: 'pl1',
      kind: 'plane',
      definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 5 },
    } as never)

    const forward = await runHeadless({ doc, docId: 'plane-forward', steps: [] })
    const problem = forward.features.find(feature => feature.id === 'sk2')
    expect(problem).toBeDefined()
    expect(problem!.status).toBe('exception')
    expect(problem!.message).toContain(
      "plane 'pl1' is defined after this sketch; move it up with reorder_features {featureId: 'pl1', before: 'sk2'}",
    )
    expect(forward.part.solveOutcomes().sk2.status).toBe('exception')
    // The refused sketch built nothing: only the box body is live.
    expect(forward.bodies).toEqual(['body_ex1'])

    // The fix the refusal names, with no rows counted: pl1 lands directly
    // above sk2 (Extruder_Support F4 counted seventeen rows for a toIndex).
    const reordered = await runHeadless({
      doc: forward.doc!,
      docId: 'plane-reordered',
      steps: [{ mutation: { type: 'reorder_features', featureId: 'pl1', before: 'sk2' } }],
    })
    expect(reordered.ok).toBe(true)
    expect(reordered.features).toEqual([])
    const ids = reordered.doc!.features!.map(feature => feature.id)
    expect(ids.indexOf('pl1')).toBe(ids.indexOf('sk2') - 1)
    expect(reordered.part.solveOutcomes().sk2.status).toBe('underconstrained')
    // It built on pl1 (Top offset 5), not on the Front default.
    expect(reordered.frames!.sk2.origin).toEqual([0, 5, 0])
  }, 120_000)

  it('refuses a reorder naming both toIndex and before, or an unknown anchor', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    for (const [mutation, text] of [
      [{ type: 'reorder_features', featureId: 'ex1', toIndex: 4, before: 'sk1' }, 'exactly one of toIndex, before or after'],
      [{ type: 'reorder_features', featureId: 'ex1', before: 'nope' }, '"nope" is not in the document'],
      [{ type: 'add_plane', featureId: 'pl9', before: 'nope' }, '"nope" is not in the document'],
    ] as const) {
      const result = await runHeadless({ doc: emptyDoc(), steps: [...box.steps, { mutation } as never] })
      const refused = result.outcome.steps[box.steps.length]
      expect(refused.ok, mutation.type).toBe(false)
      expect(refused.error?.message, mutation.type).toContain(text)
    }
  }, 120_000)

  it('add_plane before inserts the plane directly above the named feature', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const result = await runHeadless({
      doc: emptyDoc(),
      steps: [
        ...box.steps,
        { mutation: { type: 'add_plane', featureId: 'pl1', before: 'ex1', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 5 } } },
      ],
    })
    expect(result.features).toEqual([])
    const ids = result.doc!.features!.map(feature => feature.id)
    expect(ids.indexOf('pl1')).toBe(ids.indexOf('ex1') - 1)
  }, 120_000)

  it('refuses a face query an upstream delete stopped resolving', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const doc = built.doc!

    const faces = (await selectHeadless(doc, {
      kind: 'face',
      where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] },
    }))!.queries
    expect(faces).toHaveLength(1)
    const topFace = faces[0]
    doc.features!.push(cloneSketch(doc, 'sk2', topFace))

    const onFace = await runHeadless({ doc, docId: 'face-sketch', steps: [] })
    expect(onFace.features).toEqual([])
    expect(onFace.part.solveOutcomes().sk2.status).toBe('underconstrained')

    // The sketch stays in the log after its face's body is deleted; it must red
    // rather than quietly draw on Front.
    const orphaned = await runHeadless({
      doc: onFace.doc!,
      docId: 'face-sketch-deleted',
      steps: [{ mutation: { type: 'delete_feature', featureId: 'ex1' } }],
    })
    const problem = orphaned.features.find(feature => feature.id === 'sk2')
    expect(problem).toBeDefined()
    expect(problem!.status).toBe('exception')
    expect(problem!.message).toContain(`face '${topFace}' did not resolve`)
    expect(orphaned.bodies).toEqual([])
  }, 120_000)
})
