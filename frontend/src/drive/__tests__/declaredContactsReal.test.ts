// @vitest-environment node
//
// The area builder trusts the author's declared contacts. A large profile's
// satisfied solve leaves its coincident-pinned joints farther apart than the
// builder's absolute 1e-5 merge, so the raw geometry says "open" while the
// constraints say "one vertex". This suite proves the builder welds them, that
// the welded joint reaches OCC as one wire vertex, and that a contact the
// geometry really did not meet is named in the extrude error instead of being
// welded over.
//
// Real kernel, gated like the other drive suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { runHeadless, measureHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import { featureById } from '@/testing/featureAccess'
import { endpointVertices } from '@/utils/geometry/offsetProfile'
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

/** A 4 x 2 rounded-corner profile at `scale`, every joint a coincident.
 *
 * The left line's two ends are fixed and its length is dimensioned 3e-4 past
 * its seed. The conflict is well inside the sketch's verdict width (a satisfied
 * solve), but the least-squares compromise leaves the bottom-left joint open by
 * more than the builder's absolute 1e-5 merge: exactly the case a declared
 * coincident has to cover. */
const AREA_PER_UNIT = 8 - (1 - Math.PI / 4)

function profileSteps(scale: number): ScriptStep[] {
  const s = scale
  return [
    m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
    m({ type: 'add_entity', featureId: 'sk1', kind: 'line', entityId: 'bottom', params: [0, 0, 4 * s, 0] }),
    m({ type: 'add_entity', featureId: 'sk1', kind: 'line', entityId: 'right', params: [4 * s, 0, 4 * s, 2 * s] }),
    m({ type: 'add_entity', featureId: 'sk1', kind: 'line', entityId: 'top', params: [4 * s, 2 * s, s, 2 * s] }),
    m({ type: 'add_entity', featureId: 'sk1', kind: 'arc', entityId: 'round', params: [s, s, s, 90, 180] }),
    m({ type: 'add_entity', featureId: 'sk1', kind: 'line', entityId: 'left', params: [0, s, 0, 0] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:bottom:end', 'vertex:sk1:right:start'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:right:end', 'vertex:sk1:top:start'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:top:end', 'vertex:sk1:round:start'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:round:end', 'vertex:sk1:left:start'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:left:end', 'vertex:sk1:bottom:start'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'tangent', targets: ['entity:sk1:top', 'entity:sk1:round'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'tangent', targets: ['entity:sk1:round', 'entity:sk1:left'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'fixed', targets: ['vertex:sk1:left:start'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'fixed', targets: ['vertex:sk1:left:end'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'point_distance', targets: ['vertex:sk1:left:start', 'vertex:sk1:left:end'], value: s + 3e-4 }),
  ]
}

function sketchOf(doc: PartDoc): SketchFeature {
  return featureById(doc, 'sk1', 'sketch')
}

type JointPair = [string, string, 'start' | 'end', string, 'start' | 'end']

/** The declared joints as (endpoint, endpoint) solved positions. */
function jointGaps(doc: PartDoc, pairs: JointPair[]): { id: string; gap: number }[] {
  const sk = sketchOf(doc)
  const at = (id: string, key: 'start' | 'end'): [number, number] => {
    const ent = sk.entities!.find((e) => e.id === id)
    if (!ent) throw new Error(`missing entity ${id} in ${JSON.stringify(sk.entities)}`)
    const params = sk.initial?.[id]
    if (!params) throw new Error(`missing initial ${id}`)
    const v = endpointVertices(ent.kind, params).find((p) => p.vertexKey === key)
    if (!v) throw new Error(`no ${key} on ${id}`)
    return v.point
  }
  return pairs.map(([id, a, aKey, b, bKey]) => {
    const p = at(a, aKey)
    const q = at(b, bKey)
    return { id, gap: Math.hypot(p[0] - q[0], p[1] - q[1]) }
  })
}

const ROUNDED_CORNER_JOINTS: JointPair[] = [
  ['j1', 'bottom', 'end', 'right', 'start'],
  ['j2', 'right', 'end', 'top', 'start'],
  ['j3', 'top', 'end', 'round', 'start'],
  ['j4', 'round', 'end', 'left', 'start'],
  ['j5', 'left', 'end', 'bottom', 'start'],
]

const OPEN_SQUARE_JOINTS: JointPair[] = [
  ['j1', 'b', 'end', 'r', 'start'],
  ['j2', 'r', 'end', 't', 'start'],
  ['j3', 't', 'end', 'l', 'start'],
  ['j4', 'l', 'end', 'b', 'start'],
]

describe.skipIf(!ready)('declared contacts at the real kernel', () => {
  it('welds a 1000 mm joint the solver left past 1e-5 and extrudes one body', async () => {
    // The precondition is the whole point: find a scale where the satisfied
    // solve really leaves a joint wider than the builder's absolute merge, so
    // the test proves the declared contact did the work.
    let doc: PartDoc | null = null
    let scale = 1000
    let maxGap = 0
    for (const s of [1000, 10_000, 100_000]) {
      const solved = await runHeadless({ doc: emptyDriveDoc(), steps: profileSteps(s) })
      expect(solved.ok).toBe(true)
      expect(solved.features).toEqual([])
      const gaps = jointGaps(solved.doc!, ROUNDED_CORNER_JOINTS)
      const gap = Math.max(...gaps.map((g) => g.gap))
      doc = solved.doc
      scale = s
      maxGap = gap
      if (gap > 1e-5) break
    }
    expect(doc).not.toBeNull()
    expect(maxGap).toBeGreaterThan(1e-5)

    const built = await runHeadless({
      doc: doc!,
      steps: [m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: scale, operation: 'new' })],
    })
    expect(built.ok).toBe(true)
    expect(built.features).toEqual([])

    const measured = await measureHeadless(built.doc!)
    expect(measured).not.toBeNull()
    expect(measured!.ok).toBe(true)
    expect(measured!.features).toEqual([])
    // One body: a second would mean the open joint split the profile.
    expect(measured!.measures.bodies).toBe(1)
    const expected = AREA_PER_UNIT * scale ** 3
    expect(Math.abs(measured!.measures.volume - expected) / expected).toBeLessThan(1e-6)
  }, 300_000)

  it('names an unmet coincident instead of welding it', async () => {
    // A small real profile with one joint open by 2e-4, every line fixed so the
    // solve cannot close it. A far construction line inflates the solver's
    // sketch scale (its verdict width follows the SEED bbox), so the miss still
    // reads as a satisfied solve; the area builder's own scale comes from the
    // real geometry only, so the same gap is past its cap and must be reported,
    // not welded.
    const gap = 1e-3
    const built = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
        m({ type: 'add_entity', featureId: 'sk1', kind: 'line', entityId: 'b', params: [0, 0, 1, 0] }),
        m({ type: 'add_entity', featureId: 'sk1', kind: 'line', entityId: 'r', params: [1, 0, 1, 1] }),
        m({ type: 'add_entity', featureId: 'sk1', kind: 'line', entityId: 't', params: [1, 1, 0, 1] }),
        m({ type: 'add_entity', featureId: 'sk1', kind: 'line', entityId: 'l', params: [0, 1, 0, gap] }),
        m({ type: 'add_entity', featureId: 'sk1', kind: 'line', entityId: 'far', params: [1e5, 1e5, 1e5 + 1, 1e5] }),
        m({ type: 'toggle_construction', targets: ['entity:sk1:far'] }),
        ...['b', 'r', 't', 'l'].map((id) =>
          m({ type: 'add_constraint', featureId: 'sk1', kind: 'fixed', targets: [`entity:sk1:${id}`] })),
        m({ type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:b:end', 'vertex:sk1:r:start'] }),
        m({ type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:r:end', 'vertex:sk1:t:start'] }),
        m({ type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:t:end', 'vertex:sk1:l:start'] }),
        m({ type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:l:end', 'vertex:sk1:b:start'] }),
        m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 1, operation: 'new' }),
      ],
    })
    expect(built.ok).toBe(true)
    const gaps = jointGaps(built.doc!, OPEN_SQUARE_JOINTS)
    const open = gaps.find((g) => g.gap > 1e-5)
    expect(open, `one joint really stayed open: ${JSON.stringify(gaps)}`).toBeDefined()
    // The builder's scale is the real bbox (1 x 1): its cap is ~1.4e-7, far
    // below the realised gap.
    expect(open!.gap).toBeGreaterThan(1e-7)

    const problem = built.features.find((f) => f.id === 'ex1')
    expect(problem).toMatchObject({ id: 'ex1', kind: 'extrude', status: 'error' })
    expect(problem!.message).toMatch(/declared contact \S+ is not met: gap/)
  }, 240_000)
})
