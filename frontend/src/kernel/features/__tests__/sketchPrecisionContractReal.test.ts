// @vitest-environment node
//
// The solver/kernel precision contract against the real kernel, on the mirror
// seam report's own document (`__fixtures__/mirrorSeams.json`, a faithful copy
// of the document block in `bugreports/20261114_0039_mirror_seams.md`).
//
// Two things are pinned here:
//   1. The kernel builds from the solve's f64 `paramsSolved`, never from the
//      6 dp baked document. The sketch below is seeded OPEN and closed only by
//      its constraints, so a build that read the stored seed would fail to
//      close the profile.
//   2. No edge lying on the mirror plane separates two planar faces with
//      (near-)parallel normals: that edge is the seam the report saw.
//
// The seam assertion is `.todo`: on this tree the solver's contract finish
// lands the pair inside `OCC_ANGULAR`, but the kernel half (reading that report
// and applying it per call) is `feature/kernel-unify-within-contract.md`. If
// the seam survives here, that plan owns it; this suite is where it turns
// green.

import { describe, it, expect, afterAll } from 'vitest'
import type { BuildResponse } from '../../builder'
import type { BuildState } from '../../types3d'
import type { OccModule, OccShape, OccSubShape } from '../../occ/occTypes'
import { exploreEdges, exploreFaces } from '../../occ/edgeModifier'
import { DisposeScope } from '../../occ/disposeScope'
import { TOL_SELECT_DIRECTION } from '../../solverConstants'
import {
  oc, solveBytes, extrudeTestHarness, rectSketchSk, extrudeSpec,
} from '../extrudeRealSupport'
import mirrorSeams from '../__fixtures__/mirrorSeams.json'

type Vec3 = [number, number, number]

const doc = mirrorSeams as unknown as {
  features: Array<Record<string, unknown>>
  part_style: Record<string, unknown>
}

/** The live body shape at the last checkpoint. The harness table keeps the
 *  handles across builds (the scope is per build), so the final body is
 *  readable here. */
function lastBodyShape(h: ReturnType<typeof extrudeTestHarness>, result: BuildResponse, bodyId: string): OccShape | null {
  const state = result._build_state as BuildState
  const order = state.feature_order
  const checkpoint = order.length > 0 ? state.checkpoints[order[order.length - 1]] : undefined
  const handle = checkpoint?.body_store_snapshot[bodyId]?.shape
  if (!handle) return null
  return h.table.get<OccShape>(handle)
}

/** The outward unit normal of `face` at the midpoint of `edge`, sampled on the
 *  edge's pcurve (so a curved face is read where it meets the edge). */
function normalAtEdge(
  ocModule: OccModule,
  scope: DisposeScope,
  face: OccShape,
  edge: OccShape,
): Vec3 | null {
  try {
    const c2d = scope.track(new ocModule.BRepAdaptor_Curve2d_2(edge, face))
    const t = (c2d.FirstParameter() + c2d.LastParameter()) / 2
    const uv = scope.track(c2d.Value(t))
    const adaptor = scope.track(new ocModule.BRepAdaptor_Surface_2(face, true))
    const p = scope.track(new ocModule.gp_Pnt_1())
    const du = scope.track(new ocModule.gp_Vec_1())
    const dv = scope.track(new ocModule.gp_Vec_1())
    adaptor.D1(uv.X(), uv.Y(), p, du, dv)
    const n: Vec3 = [
      du.Y() * dv.Z() - du.Z() * dv.Y(),
      du.Z() * dv.X() - du.X() * dv.Z(),
      du.X() * dv.Y() - du.Y() * dv.X(),
    ]
    const len = Math.hypot(n[0], n[1], n[2])
    if (!(len > 1e-12)) return null
    const unit = n.map((c) => c / len) as Vec3
    const reversed =
      (face as unknown as { Orientation_1(): { value: number } }).Orientation_1().value
      === ocModule.TopAbs_Orientation.TopAbs_REVERSED.value
    return reversed ? [-unit[0], -unit[1], -unit[2]] : unit
  } catch {
    return null
  }
}

function isPlanar(ocModule: OccModule, scope: DisposeScope, face: OccShape): boolean {
  const adaptor = scope.track(new ocModule.BRepAdaptor_Surface_2(face, true))
  return adaptor.GetType().value === ocModule.GeomAbs_SurfaceType.GeomAbs_Plane.value
}

/** Sample points along an edge; a seam's edge must lie IN the mirror plane, so
 *  every sample's x is checked, not just the endpoints. */
function edgeSamples(
  ocModule: OccModule,
  scope: DisposeScope,
  edge: OccShape,
): Vec3[] {
  const curve = scope.track(new ocModule.BRepAdaptor_Curve_2(edge))
  const first = curve.FirstParameter()
  const last = curve.LastParameter()
  return [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const p = curve.Value(first + f * (last - first))
    const out: Vec3 = [p.X(), p.Y(), p.Z()]
    p.delete()
    return out
  })
}

/** Every edge on the mirror plane whose two adjacent faces are planar, with the
 *  sine of the angle between their normals. A near-zero sine on such an edge is
 *  a seam: two coplanar faces the merge should have folded into one. */
function seamEdges(
  ocModule: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  planeX = 0,
  tolerance = 1e-6,
): Array<{ at: Vec3; sine: number }> {
  const faces = exploreFaces(ocModule, scope, shape)
  const seen: OccShape[] = []
  const out: Array<{ at: Vec3; sine: number }> = []
  for (const face of faces) {
    for (const edge of exploreEdges(ocModule, scope, face)) {
      if (seen.some((e) => (e as OccSubShape).IsSame(edge as OccSubShape))) continue
      seen.push(edge)
      const samples = edgeSamples(ocModule, scope, edge)
      if (!samples.every((s) => Math.abs(s[0] - planeX) <= tolerance)) continue
      const adjacent = faces.filter((f) =>
        exploreEdges(ocModule, scope, f).some((fe) => (fe as OccSubShape).IsSame(edge as OccSubShape)),
      )
      const unique = adjacent.filter(
        (f, i) => adjacent.findIndex((g) => (g as OccSubShape).IsSame(f as OccSubShape)) === i,
      )
      if (unique.length !== 2) continue
      if (!unique.every((f) => isPlanar(ocModule, scope, f))) continue
      const na = normalAtEdge(ocModule, scope, unique[0], edge)
      const nb = normalAtEdge(ocModule, scope, unique[1], edge)
      if (na === null || nb === null) continue
      const sine = Math.hypot(
        na[1] * nb[2] - na[2] * nb[1],
        na[2] * nb[0] - na[0] * nb[2],
        na[0] * nb[1] - na[1] * nb[0],
      )
      out.push({ at: samples[0], sine })
    }
  }
  return out
}

/** The report document with `horizontal` added on `l1`, which is the variant
 *  the report's own experiment used: the top edge then has an absolute
 *  direction, so its parallel partner's precision is what the merge reads. */
function reportWithHorizontal(): Record<string, unknown> {
  const features = doc.features.map((feature) => {
    if (feature.id !== 'sk1') return feature
    const constraints = (feature.constraints as Array<Record<string, unknown>>) ?? []
    return {
      ...feature,
      constraints: [
        ...constraints,
        { id: 'c_horizontal_l1', kind: 'horizontal', target: '$l1' },
      ],
    }
  })
  return { features, part_style: doc.part_style }
}

describe.skipIf(!oc || !solveBytes)('sketch precision contract (real OCC)', () => {
  const h = extrudeTestHarness()
  const scope = new DisposeScope()
  afterAll(() => scope.dispose())

  it('builds the profile from the solved params, not the stored seed', () => {
    // The seed is OPEN (a 0.5 gap at the bottom-right joint) and dimensioned to
    // close only through the solve. The doc's `initial` is exactly that open
    // seed; a kernel that read the stored geometry would fail to extrude (no
    // closed profile) instead of measuring 10 x 6.
    const features = [
      {
        id: 'sk1', kind: 'sketch', label: 'Rectangle', plane: '@builtin_plane_front',
        entities: [
          { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
          { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
        ],
        initial: {
          bottom: [0, 0, 9.5, 0],
          right: [10, 1, 10, 6],
          top: [10, 6, 0, 6],
          left: [0, 6, 0, 0],
        },
        constraints: [
          { id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
          { id: 'c2', kind: 'coincident', a: { entity: 'right', point: 'end' }, b: { entity: 'top', point: 'start' } },
          { id: 'c3', kind: 'coincident', a: { entity: 'top', point: 'end' }, b: { entity: 'left', point: 'start' } },
          { id: 'c4', kind: 'coincident', a: { entity: 'left', point: 'end' }, b: { entity: 'bottom', point: 'start' } },
          { id: 'c5', kind: 'horizontal', target: { entity: 'bottom' } },
          { id: 'c6', kind: 'horizontal', target: { entity: 'top' } },
          { id: 'c7', kind: 'vertical', target: { entity: 'right' } },
          { id: 'c8', kind: 'vertical', target: { entity: 'left' } },
          { id: 'c9', kind: 'length', target: { entity: 'bottom' }, value: 10 },
          { id: 'c10', kind: 'length', target: { entity: 'left' }, value: 6 },
        ],
      },
      extrudeSpec('sk1', 'ex1', { distance: 4, direction: 'normal' }),
    ]
    const result = h.run({ features })
    expect(h.res(result, 'ex1').status).toBe('ok')
    const mesh = h.body(result, 'body_ex1').mesh as { vertices: number[][] } | undefined
    expect(mesh).toBeDefined()
    const xs = (mesh?.vertices ?? []).map((v) => v[0])
    const ys = (mesh?.vertices ?? []).map((v) => v[1])
    // The span is the solved size; the absolute position may translate (the
    // sketch has no origin fix), which is irrelevant to what this pins.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10, 6)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(6, 6)
  })

  it('takes the area builder input from the solved params too', () => {
    // The same mechanism one level down: `solveSketch` feeds `richGeom` (built
    // from `paramsSolved`) to the Rust area builder, and postRegister publishes
    // that topology as `_topo_sk1`. If the profile were built from the open
    // seed, the area builder would publish no surface and the extrude would
    // report an unbuildable profile instead of a body.
    const sketch = rectSketchSk('sk1', 12, 8)
    sketch.initial = {
      bottom: [0, 0, 12, 0],
      right: [11.4, -0.3, 11.4, 8],
      top: [12, 8, 0, 8],
      left: [0.2, 8.2, 0, 0],
    }
    const result = h.run({ features: [sketch, extrudeSpec('sk1', 'ex1', { distance: 3 })] })
    expect(h.res(result, 'ex1').status).toBe('ok')
  })

  it('finds the bottom seam surviving the solver contract (plan 2)', () => {
    // The report's experiment: `horizontal` on l1 gives the top edge an
    // absolute direction. The solver meets the contract on this sketch (the
    // assertion below is the boundary between the two halves), the top wall
    // pair merges, and one edge is still left in x = 0 between two nearly
    // coplanar faces: the bottom wall through xip0, at a 1.8e-9 normal sine.
    // That residual is OCC's own surface/merge decision, not the solve, which
    // is why the no-seam assertion is plan 2's
    // (`feature/kernel-unify-within-contract.md`).
    const result = h.run(reportWithHorizontal())
    const row = h.res(result, 'sk1')
    expect(row.status).toBe('underconstrained')
    expect(Number(row.angular_miss)).toBeLessThanOrEqual(1e-12)
    const shape = lastBodyShape(h, result, 'body_ex1')
    expect(shape).not.toBeNull()
    const seams = seamEdges(oc!, scope, shape!)
    // The pin records today's seam so plan 2's fix cannot pass unnoticed: when
    // it discriminates the pair, this list empties and the `.todo` below is
    // the assertion that takes over.
    const summary = seams.map((s) => `edge at [${s.at.join(', ')}] sine ${s.sine.toExponential(2)}`)
    expect(summary).toHaveLength(1)
    expect(summary[0]).toContain('0, -4')
    expect(seams[0].sine).toBeLessThan(TOL_SELECT_DIRECTION)
  })

  it.todo('mirrors without a seam across x = 0: feature/kernel-unify-within-contract.md')
})
