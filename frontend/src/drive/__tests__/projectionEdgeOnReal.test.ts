// @vitest-environment node
//
// The real-kernel half of edge-on curve projection, rebuilt from scratch (not
// from the practice example). A circle in the Right plane is seen edge-on by a
// sketch on the box's +Z face, so it lowers to its silhouette line; a coplanar
// circle that the line spans as a diameter then extrudes to a full disc (two
// half-disc regions) instead of failing on a degenerate ellipse
// (`make_ellipse_edge: needs a >= b > 0`). Moving the source sketch back to a
// face-parallel plane re-resolves the projection as a circle. A declared
// `point` on a body circle edge projects that circle's centre, in any
// orientation. Skips when OCC.js or the Rust solver is absent.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { runHeadless, measureHeadless, selectHeadless, emptyDriveDoc } from '../headlessOps'
import { nonSketchProblems } from './buildProblems'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { sketchToWorld2d, worldToSketch2d } from '@/kernel/features/shared/planes'
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
const ready = oc && solveBytes

/** A step carrying mutation fields the drive accepts but the Mutation union does
 *  not spell (a plane selector). */
const step = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

// The box's +Z face: normal +Z at the extreme of the world z range.
const TOP_FACE = {
  selector: {
    kind: 'face',
    where: { and: [{ parallel: [0, 0, 1] }, { extreme: { axis: 'z', side: 'max' } }] },
  },
}

/** A 40 x 30 box on Top extruded 10 along +Y. */
const BOX_STEPS: Record<string, unknown>[] = [
  { type: 'add_sketch', featureId: 'sk1', label: 'Box', plane: '@builtin_plane_top' },
  { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [40, 30], p0Ref: '@builtin_origin', dimensions: true },
  { type: 'add_extrude', featureId: 'ex1', label: 'Box', sketchQuery: '$sk1', distance: 10, operation: 'new' },
]

/** The box plus the source circle in the Right plane, a sketch on its +Z face
 *  and the circle projected into it. The circle centre is world (0, 5, 0): on
 *  both the Right plane (x = 0) and the +Z face plane (z = 0), so the edge-on
 *  silhouette passes through the face sketch's diameter. */
function boxAndProjectedCircle() {
  const steps = [
    ...BOX_STEPS,
    { type: 'add_sketch', featureId: 'sk2', label: 'Source', plane: '@builtin_plane_right' },
    { type: 'add_entity', featureId: 'sk2', kind: 'circle', params: [0, 5, 3], entityId: 'c0' },
    { type: 'add_sketch', featureId: 'sk3', label: 'Face', plane: TOP_FACE },
    { type: 'add_projected_entity', featureId: 'sk3', kind: 'circle', source: '@sk2/c0', entityId: 'px0' },
  ].map(step)
  return runHeadless({ doc: emptyDriveDoc(), steps, frames: 'all' })
}

function sketchOf(doc: PartDoc | null, id: string): SketchFeature | undefined {
  const feature = doc?.features?.find(candidate => candidate.id === id)
  return feature?.kind === 'sketch' ? feature : undefined
}

describe.skipIf(!ready)('edge-on projection lowers to a real line (real OCC + Rust solver)', () => {
  it('12. extrudes a full disc from the silhouette and a circle it spans', async () => {
    const built = await boxAndProjectedCircle()
    expect(built.ok).toBe(true)
    // The projection itself is not a build problem: it resolves as a line, and
    // the in-process solve adopts the resolved kind on the document entity.
    expect(sketchOf(built.doc, 'sk3')?.entities?.find(e => e.id === 'px0')?.kind).toBe('line')
    expect(sketchOf(built.doc, 'sk3')?.initial?.px0).toHaveLength(4)

    const faceFrame = built.frames?.sk3
    const sourceFrame = built.frames?.sk2
    expect(faceFrame).toBeDefined()
    expect(sourceFrame).toBeDefined()
    // The disc sits at the projected centre; only the frame changes, not the
    // geometry, so the circle is derived from the two resolved frames.
    const centreWorld = sketchToWorld2d([0, 5], sourceFrame!)
    const centreLocal = worldToSketch2d(centreWorld, faceFrame!)

    const disc = await runHeadless({
      doc: structuredClone(built.doc!),
      steps: [
        step({
          type: 'add_entity', featureId: 'sk3', kind: 'circle',
          params: [centreLocal[0], centreLocal[1], 3], entityId: 'disc',
        }),
        step({ type: 'add_extrude', featureId: 'ex2', label: 'Disc', sketchQuery: '$sk3', distance: 5, operation: 'new' }),
      ],
    })
    expect(disc.ok).toBe(true)
    // The degenerate-ellipse failure and the empty-profile fallback are both
    // build problems; the split disc must reach OCC cleanly.
    expect(nonSketchProblems(disc.features)).toEqual([])
    expect(JSON.stringify(disc.features)).not.toContain('make_ellipse_edge')
    const row = disc.featureDeltas?.find(entry => entry.id === 'ex2')
    expect(row?.volumeDelta).toBeCloseTo(Math.PI * 9 * 5, 3)
    const measured = await measureHeadless(disc.doc!)
    expect(measured!.measures.volume).toBeCloseTo(12000 + Math.PI * 9 * 5, 2)
  }, 240_000)

  it('13. re-resolves to a circle when the source sketch moves face-parallel', async () => {
    const built = await boxAndProjectedCircle()
    expect(built.ok).toBe(true)
    const moved = await runHeadless({
      doc: structuredClone(built.doc!),
      steps: [step({ type: 'set_feature_plane', featureId: 'sk2', plane: TOP_FACE })],
      frames: 'all',
    })
    expect(moved.ok).toBe(true)
    // Same face plane normal: the source circle is now parallel to the target
    // sketch plane, so the kind is re-derived back to a circle.
    expect(moved.frames?.sk2?.normal).toEqual([0, 0, 1])
    expect(sketchOf(moved.doc, 'sk3')?.entities?.find(e => e.id === 'px0')?.kind).toBe('circle')
    expect(sketchOf(moved.doc, 'sk3')?.initial?.px0).toHaveLength(3)
  }, 240_000)

  it('14. projects a body circle edge declared point as its centre', async () => {
    const cylinder = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        step({ type: 'add_sketch', featureId: 'sk1', label: 'Circle', plane: '@builtin_plane_front' }),
        step({ type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [0, 0, 3], entityId: 'c1', dimensions: true }),
        step({
          type: 'add_constraint', featureId: 'sk1', kind: 'coincident',
          targets: ['vertex:sk1:c1:center', '@builtin_origin'],
        }),
        step({ type: 'add_extrude', featureId: 'ex1', label: 'Cylinder', sketchQuery: '$sk1', distance: 10, operation: 'new' }),
      ],
    })
    expect(cylinder.ok).toBe(true)
    const edges = async (at: number) => (await selectHeadless(cylinder.doc!, {
      kind: 'edge',
      where: { and: [{ type: 'circle' }, { center: { axis: 'z', at } }] },
    }))!.queries
    const top = await edges(10)
    const bottom = await edges(0)
    expect(top).toHaveLength(1)
    expect(bottom).toHaveLength(1)

    // The Right plane sees both circles edge-on. Declared point means the
    // centre, so the two are the cylinder axis' ends, 10 apart: one
    // point_distance between two pinned points closes the sketch.
    const centres = await runHeadless({
      doc: structuredClone(cylinder.doc!),
      steps: [
        step({ type: 'add_sketch', featureId: 'sk2', label: 'Centres', plane: '@builtin_plane_right' }),
        step({ type: 'add_projected_entity', featureId: 'sk2', kind: 'point', entityId: 'top', source: top[0] }),
        step({ type: 'add_projected_entity', featureId: 'sk2', kind: 'point', entityId: 'bottom', source: bottom[0] }),
        step({
          type: 'add_constraint', featureId: 'sk2', kind: 'point_distance',
          targets: ['vertex:sk2:top:xy', 'vertex:sk2:bottom:xy'], value: 10,
        }),
      ],
    })
    expect(centres.ok).toBe(true)
    expect(nonSketchProblems(centres.features)).toEqual([])
    const sk2 = sketchOf(centres.doc, 'sk2')
    expect(sk2?.entities?.map(e => e.kind)).toEqual(['point', 'point'])
    // Right-plane local frame: u = -world z, v = world y.
    expect(sk2?.initial?.top).toEqual([-10, 0])
    expect(sk2?.initial?.bottom).toEqual([0, 0])
    expect(centres.featureDeltas?.find(entry => entry.id === 'sk2')?.status).toBe('fully_constrained')
  }, 240_000)
})
