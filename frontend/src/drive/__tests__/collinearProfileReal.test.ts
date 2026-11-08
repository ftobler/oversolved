// @vitest-environment node
//
// The sketch keeps a line split by a construction crossing (pickable pieces,
// area division); the SOLID must not keep it. A profile line split by a
// construction line, and two authored collinear lines meeting end to end, fuse
// into one LoopEdge before the OCC wire is built, so the prism emits one
// lateral face per geometric run. Real kernel, gated like the other drive
// suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, selectHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import { featureById } from '@/testing/featureAccess'
import {
  constructionUuidToken,
  isClassifierId,
  makeAncestryQuery,
  parseAncestry,
} from '@/kernel/query'
import { mintFaceUuid, sideFacePath, splitFacePath } from '@/kernel/constructionName'
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

const KCL_QUADRANT = { a: [0, 2, 1.3315, 2], b: [1.3315, 2, 1.3315, 1.707], c: [1.3315, 1.707, 0.1465, 1.707], d: [0.1465, 1.707, 0.1465, 0] }
// Volume = 4 * quadrant area (0.640205) * 24, the number the bug report measured
// before the fix (61.4597 in3).
const I_BEAM_VOLUME = 61.45968

/** The kcl-samples i-beam quadrant plus its two construction axes. */
function quadrantSteps(): ScriptStep[] {
  const steps: ScriptStep[] = [
    { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
  ]
  for (const [id, params] of Object.entries(KCL_QUADRANT)) {
    steps.push({ mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params, entityId: id } })
  }
  steps.push(
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, -3, 0, 3], entityId: 'ay' } },
    { mutation: { type: 'toggle_construction', targets: ['entity:sk1:ay'] } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [-3, 0, 3, 0], entityId: 'axx' } },
    { mutation: { type: 'toggle_construction', targets: ['entity:sk1:axx'] } },
    { mutation: { type: 'mirror_entities', featureId: 'sk1', sourceIds: ['a', 'b', 'c', 'd'], line: 'ay' } },
  )
  return steps
}

function sketchIds(doc: PartDoc): string[] {
  return Object.keys(featureById(doc, 'sk1', 'sketch').initial ?? {})
}

/** The authored i-beam: quadrant, mirror about Y, all about X, extrude 24. */
async function iBeamProfile(): Promise<PartDoc> {
  const quadrant = await runHeadless({ doc: emptyDriveDoc(), steps: quadrantSteps() })
  expect(quadrant.ok).toBe(true)
  const authored = ['a', 'b', 'c', 'd', 'ay', 'axx']
  const yMirrorIds = sketchIds(quadrant.doc!).filter((id) => !authored.includes(id))
  expect(yMirrorIds).toHaveLength(4)
  const built = await runHeadless({
    doc: quadrant.doc!,
    steps: [
      { mutation: { type: 'mirror_entities', featureId: 'sk1', sourceIds: [...authored.filter((id) => id !== 'ay' && id !== 'axx'), ...yMirrorIds], line: 'axx' } },
      { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 24, operation: 'new' } },
    ],
  })
  expect(built.ok).toBe(true)
  expect(built.features).toEqual([])
  return built.doc!
}

// A 2 x 2 rectangle crossed by a construction diagonal and a construction
// centreline: the centreline splits the top and bottom sides at x=0.
function crossedRectangleSteps(): ScriptStep[] {
  return [
    { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [-1, -1, 1, -1], entityId: 'bottom' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [1, -1, 1, 1], entityId: 'right' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [1, 1, -1, 1], entityId: 'top' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [-1, 1, -1, -1], entityId: 'left' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [-1, -1, 1, 1], entityId: 'diag' } },
    { mutation: { type: 'toggle_construction', targets: ['entity:sk1:diag'] } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, -2, 0, 2], entityId: 'ctr' } },
    { mutation: { type: 'toggle_construction', targets: ['entity:sk1:ctr'] } },
    { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 1, operation: 'new' } },
  ]
}

describe.skipIf(!ready)('collinear profile runs (real kernel)', () => {
  it('the i-beam extrudes to 14 faces / 36 edges with its volume unchanged', async () => {
    const doc = await iBeamProfile()
    const measured = await measureHeadless(doc)
    expect(measured).not.toBeNull()
    expect(measured!.ok).toBe(true)
    expect(measured!.features).toEqual([])
    expect(measured!.measures.volume).toBeCloseTo(I_BEAM_VOLUME, 3)
    expect(measured!.measures.faces).toBe(14)
    expect(measured!.measures.edges).toBe(36)

    // The bug: this used to return two coplanar flange faces split at x=0.
    const flange = await selectHeadless(doc, {
      kind: 'face',
      where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] },
    })
    expect(flange).not.toBeNull()
    expect(flange!.queries).toHaveLength(1)
  }, 120_000)

  it('a rectangle split by a construction line extrudes to a 6-face box, and the unsplit top edge takes one fillet pick', async () => {
    const built = await runHeadless({ doc: emptyDriveDoc(), steps: crossedRectangleSteps() })
    expect(built.ok).toBe(true)
    expect(built.features).toEqual([])
    const measured = await measureHeadless(built.doc!)
    expect(measured!.measures.volume).toBeCloseTo(4, 6)
    expect(measured!.measures.faces).toBe(6)
    expect(measured!.measures.edges).toBe(12)

    // The top wall's top rim was two edges (midpoints -0.5 and 0.5) before the
    // fuse; it is one edge through (0, 1, 1) now, so one pick reaches it.
    const rim = await selectHeadless(built.doc!, {
      kind: 'edge',
      where: { and: [{ parallel: [1, 0, 0] }, { center: { point: [0, 1, 1] } }] },
    })
    expect(rim).not.toBeNull()
    expect(rim!.queries).toHaveLength(1)

    const filleted = await runHeadless({
      doc: built.doc!,
      steps: [{ mutation: { type: 'add_fillet', featureId: 'fi1', edges: rim!.queries, radius: 0.2 } }],
    })
    expect(filleted.ok).toBe(true)
    expect(filleted.features.find((problem) => problem.id === 'fi1')).toBeUndefined()
  }, 120_000)

  it('a circle split by a construction diameter extrudes to one cylinder face', async () => {
    const built = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [0, 0, 5], entityId: 'circ' } },
        { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [-6, 0, 6, 0], entityId: 'dia' } },
        { mutation: { type: 'toggle_construction', targets: ['entity:sk1:dia'] } },
        { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 1, operation: 'new' } },
      ],
    })
    expect(built.ok).toBe(true)
    expect(built.features).toEqual([])
    const measured = await measureHeadless(built.doc!)
    expect(measured!.measures.faces).toBe(3)
    // Two circular rims plus the cylinder's seam edge.
    expect(measured!.measures.edges).toBe(3)
  }, 120_000)

  it('a pick stored on a construction-split piece resolves to the merged face', async () => {
    const built = await runHeadless({ doc: emptyDriveDoc(), steps: crossedRectangleSteps() })
    expect(built.ok).toBe(true)
    const doc = built.doc!
    const wall = await selectHeadless(doc, {
      kind: 'face',
      where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] },
    })
    expect(wall!.queries).toHaveLength(1)
    const [ids, typeRestriction, classifier] = parseAncestry(wall!.queries[0])
    const slot = ids.find((id) => id.startsWith('@sk1/'))!
    const classifiers = ids.filter((id) => isClassifierId(id))
    const base = mintFaceUuid(sideFacePath('ex1', slot.slice(1)))
    // The two pieces of the construction-split top line were named
    // splitFacePath(base, 0) and splitFacePath(base, 1) before the fuse.
    for (const index of [0, 1]) {
      const dead = mintFaceUuid(splitFacePath(base, index))
      const stored = makeAncestryQuery(
        ['@ex1', slot, constructionUuidToken(dead), ...classifiers],
        typeRestriction,
        classifier,
      )
      const shelled = await runHeadless({
        doc,
        steps: [{ mutation: { type: 'add_shell', featureId: `sh${index}`, faces: [stored], thickness: 0.1, direction: 'inward' } }],
      })
      expect(shelled.ok).toBe(true)
      expect(shelled.features.find((problem) => problem.id === `sh${index}`)).toBeUndefined()
    }
  }, 120_000)

  it('a face pick on the pre-fix mirror piece still resolves to the merged face', async () => {
    // A half rectangle mirrored about a construction Y line: the top side is
    // two authored collinear lines (top and its mirror). The merged wall is
    // named by the smaller id; a pick made on the other piece's old face UUID
    // must recover through the ancestral alias.
    const quadrant = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, -3, 0, 3], entityId: 'ax' } },
        { mutation: { type: 'toggle_construction', targets: ['entity:sk1:ax'] } },
        { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 2, 3, 2], entityId: 'top' } },
        { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [3, 2, 3, -2], entityId: 'side' } },
        { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [3, -2, 0, -2], entityId: 'bottom' } },
        { mutation: { type: 'mirror_entities', featureId: 'sk1', sourceIds: ['top', 'side', 'bottom'], line: 'ax' } },
        { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 5, operation: 'new' } },
      ],
    })
    expect(quadrant.ok).toBe(true)
    const doc = quadrant.doc!
    const initial = featureById(doc, 'sk1', 'sketch').initial ?? {}
    const topIds = sketchIds(doc).filter((id) => {
      const p = initial[id]
      return Array.isArray(p) && p.length === 4 && p[1] === 2 && p[3] === 2
    })
    expect(topIds).toHaveLength(2)
    const primary = [...topIds].sort()[0]
    const alias = topIds.find((id) => id !== primary)!

    const wall = await selectHeadless(doc, {
      kind: 'face',
      where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] },
    })
    expect(wall!.queries).toHaveLength(1)

    const [queryIds, typeRestriction, classifier] = parseAncestry(wall!.queries[0])
    const deadUuid = mintFaceUuid(sideFacePath('ex1', `sk1/${alias}`))
    const classifiers = queryIds.filter((id) => isClassifierId(id))
    const migrated = makeAncestryQuery(
      ['@ex1', `@sk1/${alias}`, constructionUuidToken(deadUuid), ...classifiers],
      typeRestriction,
      classifier,
    )
    const shelled = await runHeadless({
      doc,
      steps: [{ mutation: { type: 'add_shell', featureId: 'sh1', faces: [migrated], thickness: 0.1, direction: 'inward' } }],
    })
    expect(shelled.ok).toBe(true)
    expect(shelled.features.find((problem) => problem.id === 'sh1')).toBeUndefined()
  }, 120_000)
})
