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
// orientation. The 0 deg / 90 deg annulus pair pins the decision at the second
// bad angle: the edge-on inner circle is a line, so its centre key is gone and
// the coincidence is dropped by name rather than silently dragging the user
// circle into a clean full disc. A blind side hole (entry circle plus a bottom
// arc slotted on one side) projects both edges as lines. Skips when OCC.js or
// the Rust solver is absent.

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

/** The box plus a through hole along Z at world (20, 5, 0): the source for the
 *  0 deg / 90 deg annulus pair. */
function boxWithThroughHole() {
  return runHeadless({
    doc: emptyDriveDoc(),
    steps: [
      ...BOX_STEPS,
      { type: 'add_sketch', featureId: 'skh', label: 'Hole', plane: '@builtin_plane_front' },
      { type: 'add_entity', featureId: 'skh', kind: 'circle', params: [20, 5, 3], entityId: 'h1', dimensions: true },
      {
        type: 'add_constraint', featureId: 'skh', kind: 'point_distance_x',
        targets: ['vertex:skh:h1:center', '@builtin_origin'], value: 20,
      },
      {
        type: 'add_constraint', featureId: 'skh', kind: 'point_distance_y',
        targets: ['vertex:skh:h1:center', '@builtin_origin'], value: 5,
      },
      {
        type: 'add_extrude', featureId: 'exh', label: 'Hole', sketchQuery: '$skh', distance: 1,
        operation: 'cut', termination: 'through_all', direction: 'symmetric',
      },
    ].map(step),
  })
}

/** The Resin_Mold side-hole shape: a blind hole drilled along +Y from the
 *  block's bottom face, its bottom half removed by a slot cut from the Front,
 *  so the entry is a full circle and the bottom is an arc. */
function blindHoleWithSlottedBottom() {
  return runHeadless({
    doc: emptyDriveDoc(),
    steps: [
      ...BOX_STEPS,
      { type: 'add_sketch', featureId: 'skh', label: 'Blind hole', plane: '@builtin_plane_top' },
      { type: 'add_entity', featureId: 'skh', kind: 'circle', params: [20, 15, 3], entityId: 'h1', dimensions: true },
      {
        type: 'add_constraint', featureId: 'skh', kind: 'point_distance_x',
        targets: ['vertex:skh:h1:center', '@builtin_origin'], value: 20,
      },
      {
        type: 'add_constraint', featureId: 'skh', kind: 'point_distance_y',
        targets: ['vertex:skh:h1:center', '@builtin_origin'], value: 15,
      },
      { type: 'add_extrude', featureId: 'exh', label: 'Blind hole', sketchQuery: '$skh', distance: 6, operation: 'cut' },
      { type: 'add_sketch', featureId: 'skp', label: 'Slot', plane: '@builtin_plane_front' },
      {
        type: 'add_rect', featureId: 'skp', p0: [20, 4], p1: [40, 6],
        entityIds: ['sb', 'sr', 'st', 'sl'], dimensions: true,
      },
      {
        type: 'add_constraint', featureId: 'skp', kind: 'point_distance_x',
        targets: ['vertex:skp:sb:start', '@builtin_origin'], value: 20,
      },
      {
        type: 'add_constraint', featureId: 'skp', kind: 'point_distance_y',
        targets: ['vertex:skp:sb:start', '@builtin_origin'], value: 4,
      },
      {
        type: 'add_extrude', featureId: 'exp', label: 'Slot', sketchQuery: '$skp', distance: 1,
        operation: 'cut', termination: 'through_all', direction: 'symmetric',
      },
    ].map(step),
  })
}

/** The silhouette line's per-axis span, whichever endpoint order it is in. */
function lineSpan(params: number[]) {
  return {
    xMin: Math.min(params[0], params[2]), xMax: Math.max(params[0], params[2]),
    yMin: Math.min(params[1], params[3]), yMax: Math.max(params[1], params[3]),
  }
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

  it('12b. keeps the concentric annulus clean at 0 deg', async () => {
    const base = await boxWithThroughHole()
    expect(base.ok).toBe(true)
    expect(nonSketchProblems(base.features)).toEqual([])
    const source = (await selectHeadless(base.doc!, {
      kind: 'edge', where: { and: [{ type: 'circle' }, { center: { axis: 'z', at: 0 } }] },
    }))!.queries
    expect(source).toHaveLength(1)

    const run = await runHeadless({
      doc: structuredClone(base.doc!),
      steps: [
        step({ type: 'add_sketch', featureId: 'sk0', label: 'Annulus', plane: '@builtin_plane_front' }),
        step({ type: 'add_projected_entity', featureId: 'sk0', kind: 'circle', source: source[0], entityId: 'pc' }),
        step({
          type: 'add_entity', featureId: 'sk0', kind: 'circle', params: [20, 5, 5],
          entityId: 'uc', dimensions: true,
        }),
        step({
          type: 'add_constraint', featureId: 'sk0', kind: 'coincident',
          targets: ['vertex:sk0:uc:center', 'vertex:sk0:pc:center'],
        }),
        step({ type: 'add_extrude', featureId: 'ex0', label: 'Annulus', sketchQuery: '$sk0', distance: 2, operation: 'new' }),
      ],
    })
    expect(run.ok).toBe(true)
    // Coplanar source: the projection stays a circle, so the centre
    // coincidence is a real relation and the sketch is clean.
    expect(nonSketchProblems(run.features)).toEqual([])
    const sk0 = sketchOf(run.doc, 'sk0')
    expect(sk0?.entities?.find(e => e.id === 'pc')?.kind).toBe('circle')
    expect(sk0?.initial?.uc).toEqual([20, 5, 5])
    expect(run.featureDeltas?.find(entry => entry.id === 'ex0')?.volumeDelta).toBeCloseTo(32 * Math.PI, 6)
  }, 240_000)

  it('12c. warns when the edge-on annulus loses its hole instead of a clean full disc', async () => {
    const base = await boxWithThroughHole()
    expect(base.ok).toBe(true)
    const source = (await selectHeadless(base.doc!, {
      kind: 'edge', where: { and: [{ type: 'circle' }, { center: { axis: 'z', at: 0 } }] },
    }))!.queries
    expect(source).toHaveLength(1)

    const run = await runHeadless({
      doc: structuredClone(base.doc!),
      steps: [
        step({ type: 'add_sketch', featureId: 'sk90', label: 'Annulus', plane: '@builtin_plane_right' }),
        step({ type: 'add_projected_entity', featureId: 'sk90', kind: 'circle', source: source[0], entityId: 'pc' }),
        step({
          type: 'add_entity', featureId: 'sk90', kind: 'circle', params: [0, 5, 5],
          entityId: 'uc', dimensions: true,
        }),
        step({
          type: 'add_constraint', featureId: 'sk90', kind: 'coincident',
          targets: ['vertex:sk90:uc:center', 'vertex:sk90:pc:center'],
        }),
        step({ type: 'add_extrude', featureId: 'ex90', label: 'Disc', sketchQuery: '$sk90', distance: 2, operation: 'new' }),
      ],
    })
    expect(run.ok).toBe(true)
    // Edge-on, the inner boundary is a real line and the source's vertex keys
    // are gone. The centre coincidence is dropped by name instead of being
    // rebound to the line's start, so the user circle does not move and the
    // full disc is not a clean result. Test 15a pins the structured
    // `dropped_constraints` record; this reply surfaces it as the warning row.
    const sk90 = sketchOf(run.doc, 'sk90')
    expect(sk90?.entities?.find(e => e.id === 'pc')?.kind).toBe('line')
    expect(sk90?.initial?.uc).toEqual([0, 5, 5])
    const row = run.features.find(problem => problem.id === 'sk90')
    expect(row).toBeDefined()
    expect(row!.status).not.toBe('fully_constrained')
    expect(row!.message).toContain('operand center not on line')
    expect(JSON.stringify(run.features)).not.toContain('make_ellipse_edge')
    expect(run.featureDeltas?.find(entry => entry.id === 'ex90')?.volumeDelta).toBeCloseTo(50 * Math.PI, 6)
  }, 240_000)

  it('12d. projects a blind side hole entry circle and its slotted bottom arc edge-on', async () => {
    const base = await blindHoleWithSlottedBottom()
    expect(base.ok).toBe(true)
    expect(nonSketchProblems(base.features)).toEqual([])
    const entry = (await selectHeadless(base.doc!, { kind: 'edge', where: { type: 'circle' } }))!.queries
    const bottom = (await selectHeadless(base.doc!, {
      kind: 'edge', where: { and: [{ type: 'arc' }, { center: { axis: 'y', at: 6 } }] },
    }))!.queries
    expect(entry).toHaveLength(1)
    expect(bottom).toHaveLength(1)

    const run = await runHeadless({
      doc: structuredClone(base.doc!),
      steps: [
        step({ type: 'add_sketch', featureId: 'skproj', label: 'Section', plane: '@builtin_plane_front' }),
        step({ type: 'add_projected_entity', featureId: 'skproj', kind: 'circle', source: entry[0], entityId: 'pe' }),
        step({ type: 'add_projected_entity', featureId: 'skproj', kind: 'arc', source: bottom[0], entityId: 'pb' }),
        step({
          type: 'add_rect', featureId: 'skproj', p0: [17, 0], p1: [23, 6],
          p0Ref: 'vertex:skproj:pe:start', dimensions: true,
        }),
        step({ type: 'add_extrude', featureId: 'exr', label: 'Section', sketchQuery: '$skproj', distance: 2, operation: 'new' }),
      ],
    })
    expect(run.ok).toBe(true)
    expect(nonSketchProblems(run.features)).toEqual([])
    expect(JSON.stringify(run.features)).not.toContain('make_ellipse_edge')
    const skproj = sketchOf(run.doc, 'skproj')
    expect(skproj?.entities?.find(e => e.id === 'pe')?.kind).toBe('line')
    expect(skproj?.entities?.find(e => e.id === 'pb')?.kind).toBe('line')
    // The entry silhouette spans the full diameter; the slotted bottom keeps
    // only the half that still exists, so its covered line is shorter.
    const pe = lineSpan(skproj!.initial!.pe)
    expect(pe.xMin).toBeCloseTo(17)
    expect(pe.xMax).toBeCloseTo(23)
    expect(pe.yMin).toBeCloseTo(0)
    expect(pe.yMax).toBeCloseTo(0)
    const pb = lineSpan(skproj!.initial!.pb)
    expect(pb.xMin).toBeCloseTo(17)
    expect(pb.xMax).toBeCloseTo(20)
    expect(pb.yMin).toBeCloseTo(6)
    expect(pb.yMax).toBeCloseTo(6)
    expect(run.featureDeltas?.find(entry => entry.id === 'exr')?.volumeDelta).toBeCloseTo(72, 6)
  }, 240_000)
})
