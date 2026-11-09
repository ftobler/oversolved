// @vitest-environment node
//
// The hanger-style strip end to end, at two scales: draw the bend line open,
// fillet the corner, offset by the thickness, cap both ends (pinned with
// add_entity_with_constraint, the run's end-cap lesson), extrude.
//
// The tangent offset joints used to carry only a `tangent`, so the copies met
// only because their seeds happened to agree; the area builder then saw no
// closed loop. With the coincident authored beside the tangent, the joint is
// one declared contact and the profile closes at both 1 mm and 1000 mm.
// Volume: the two 7 x 1 runs plus the quarter annulus between r3 and r2, scaled
// by s^3 (runs scale s^2, thickness and extrude s).
//
// Real kernel, gated like the other drive suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { runHeadless, measureHeadless, emptyDriveDoc, type HeadlessRunResult } from '../headlessOps'
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

const AREA_PER_UNIT = 7 + 7 + (Math.PI / 4) * (3 ** 2 - 2 ** 2)

function sketchOf(doc: PartDoc): SketchFeature {
  return featureById(doc, 'sk1', 'sketch')
}

/** The clone a source's parallel/concentric relationship points at. */
function cloneOfSource(doc: PartDoc, sourceId: string): string {
  const f = sketchOf(doc)
  const rel = f.constraints!.find(
    (c) => (c.kind === 'parallel' || c.kind === 'concentric') && c.a === '$' + sourceId,
  )!
  return (rel.b as string).slice(1)
}

/** Draw the two runs and fillet their corner, leaving the arc id behind. */
async function outline(scale: number): Promise<{ doc: PartDoc; arcId: string }> {
  const outlined = await runHeadless({
    doc: emptyDriveDoc(),
    steps: [
      { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
      { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line',
        params: [0, 0, -10 * scale, 0], entityId: 'l1' } },
      { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line',
        params: [-10 * scale, 0, -10 * scale, -10 * scale], entityId: 'l2' } },
      { mutation: { type: 'fillet_corners', featureId: 'sk1', radius: 3 * scale, corners: [
        { a: 'l1', aVertex: 'end', b: 'l2', bVertex: 'start' },
      ] } },
    ],
  })
  expect(outlined.ok).toBe(true)
  expect(outlined.features).toEqual([])
  const arcId = sketchOf(outlined.doc!).entities!.find((entity) => entity.kind === 'arc')!.id
  return { doc: outlined.doc!, arcId }
}

async function strip(scale: number, nudge?: [number, number]): Promise<HeadlessRunResult> {
  const drawn = await outline(scale)
  // Offset as its own run so the clone ids the caps pin to can be read back.
  const offset = await runHeadless({
    doc: drawn.doc,
    steps: [
      { mutation: { type: 'apply_offset', featureId: 'sk1',
        sourceIds: ['l1', drawn.arcId, 'l2'], distance: scale } },
    ],
  })
  expect(offset.ok).toBe(true)
  expect(offset.features).toEqual([])
  const cloneL1 = cloneOfSource(offset.doc!, 'l1')
  const cloneL2 = cloneOfSource(offset.doc!, 'l2')

  // cap1 closes the free start (0, 0) onto the clone's start (0, -s); cap2
  // closes the free end (-10s, -10s) onto the clone's end (-9s, -10s). Each cap
  // is pinned at BOTH ends: one by add_entity_with_constraint at creation, the
  // other by an explicit coincident, so a solve moves the cap with its joint.
  const steps: ScriptStep[] = [
    ...(nudge === undefined ? [] : [{
      mutation: { type: 'move_entity' as const, featureId: 'sk1', entityId: drawn.arcId, delta: nudge },
    }]),
    { mutation: { type: 'add_entity_with_constraint', featureId: 'sk1', kind: 'line',
      params: [0, -scale, 0, 0], entityId: 'cap1', vertexKey: 'start',
      snapVertexId: `vertex:sk1:${cloneL1}:start`, constraintKind: 'coincident' } },
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'coincident',
      targets: ['vertex:sk1:cap1:end', 'vertex:sk1:l1:start'] } },
    { mutation: { type: 'add_entity_with_constraint', featureId: 'sk1', kind: 'line',
      params: [-10 * scale, -10 * scale, -9 * scale, -10 * scale], entityId: 'cap2', vertexKey: 'end',
      snapVertexId: `vertex:sk1:${cloneL2}:end`, constraintKind: 'coincident' } },
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'coincident',
      targets: ['vertex:sk1:cap2:start', 'vertex:sk1:l2:end'] } },
    { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: scale, operation: 'new' } },
  ]
  return runHeadless({ doc: offset.doc!, steps })
}

describe.skipIf(!ready)('the hanger strip closes at both scales', () => {
  for (const scale of [1, 1000]) {
    it(`at ${scale} mm: one body, volume ${(AREA_PER_UNIT * scale ** 3).toFixed(3)}`, async () => {
      const built = await strip(scale)
      expect(built.ok).toBe(true)
      expect(built.features).toEqual([])

      const measured = await measureHeadless(built.doc!)
      expect(measured).not.toBeNull()
      expect(measured!.ok).toBe(true)
      expect(measured!.features).toEqual([])
      // One body: a second body would mean the profile did not close or split.
      expect(measured!.measures.bodies).toBe(1)
      const expected = AREA_PER_UNIT * scale ** 3
      expect(Math.abs(measured!.measures.volume - expected) / expected).toBeLessThan(1e-9)
    }, 240_000)
  }

  // The joint the bug report saw open: after the offset, a solve nudges the
  // source arc, so the copies must carry the joint rather than meet at the seed.
  // With only a tangent the clone chain opens and the extrude finds no closed
  // profile.
  it('a small source-arc nudge still fills one body', async () => {
    const built = await strip(1, [0.01, -0.005])
    expect(built.ok).toBe(true)
    expect(built.features).toEqual([])

    const f = sketchOf(built.doc!)
    const concentric = f.constraints!.find((c) => c.kind === 'concentric')!
    const cloneArc = (concentric.b as string).slice(1)
    const cloneL1 = cloneOfSource(built.doc!, 'l1')
    const cloneL2 = cloneOfSource(built.doc!, 'l2')
    const arcStart = endpointVertices('arc', f.initial![cloneArc])
      .find((v) => v.vertexKey === 'start')!.point
    const arcEnd = endpointVertices('arc', f.initial![cloneArc])
      .find((v) => v.vertexKey === 'end')!.point
    expect(Math.hypot(f.initial![cloneL1][2] - arcStart[0], f.initial![cloneL1][3] - arcStart[1]))
      .toBeLessThan(1e-3)
    expect(Math.hypot(f.initial![cloneL2][0] - arcEnd[0], f.initial![cloneL2][1] - arcEnd[1]))
      .toBeLessThan(1e-3)

    const measured = await measureHeadless(built.doc!)
    expect(measured).not.toBeNull()
    expect(measured!.ok).toBe(true)
    expect(measured!.features).toEqual([])
    expect(measured!.measures.bodies).toBe(1)
    expect(measured!.measures.volume).toBeGreaterThan(0)
  }, 240_000)
})
