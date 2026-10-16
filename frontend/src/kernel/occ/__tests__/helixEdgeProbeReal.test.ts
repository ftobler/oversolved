// @vitest-environment node
//
// Real-OCC probe for the helix feature, kept as a regression guard. It pins the
// pieces the plan could not verify from names alone:
//   - BRepBuilderAPI_MakeEdge_31 (the parametric-space overload) + BuildCurves3d
//     build an edge whose samples sit on the analytic helix, and the
//     BuildCurves3d deviation at 1/10/100 turns stays under 1e-6 * r;
//   - which SetMode_* on BRepOffsetAPI_MakePipeShell takes a gp_Dir;
//   - a cylinder surface's V range is its axial extent and which way its axis
//     points for a primitive/extruded cylinder.
// Skips when opencascade.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { makeLineEdge, makeWire, faceSurfaceType, type Vec3 } from '../primitives'
import { makeCylinder, makeCylinderWithFaces } from '../primitives'
import { buildCurveEdge, helixMaxSegment } from '../helixEdge'
import { helixFrame, resolveHelixParams, helixPoint, type HelixReference } from '../../features/helixMath'
import type { HelixFeatureDef } from '@/types/cad'
import type { OccModule, OccShape } from '../occTypes'

const oc = await loadOcc()
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

function descFor(turns: number, radius = 10, pitch = 3) {
  const ref: HelixReference = { kind: 'cylinderface', axis: [0, 0, 1], origin: [0, 0, 0], radius, extent: 100 }
  const def: HelixFeatureDef = {
    mode: 'pitch_turns', pitch, turns, hand: 'right', direction: 'normal', start_angle: 0, offset: 0,
  }
  const params = resolveHelixParams(def, ref)
  return helixFrame(ref, params, def)
}

function sampleEdge(occ: OccModule, scope: DisposeScope, edge: OccShape, n: number): Vec3[] {
  const ad = scope.track(new occ.BRepAdaptor_Curve_2(edge))
  const u0 = ad.FirstParameter()
  const u1 = ad.LastParameter()
  const out: Vec3[] = []
  for (let i = 0; i <= n; i++) {
    const p = ad.Value(u0 + ((u1 - u0) * i) / n)
    out.push([p.X(), p.Y(), p.Z()])
    p.delete()
  }
  return out
}

describe.skipIf(!oc)('helix edge probe (real OCC)', () => {
  it('MakeEdge_31 + BuildCurves3d builds an edge on the analytic helix', () => {
    for (const turns of [1, 10, 100]) {
      const scope = new DisposeScope()
      try {
        const desc = descFor(turns)
        const edge = buildCurveEdge(oc!, scope, desc)
        const pts = sampleEdge(oc!, scope, edge, 500)
        const hz = desc.pitch / (2 * Math.PI)
        let worst = 0
        let worstRadial = 0
        for (const p of pts) {
          // The helix is a graph over the axial coordinate, so the axial
          // position of a sample names its parameter.
          const t = dot(sub(p, desc.origin), desc.axis) / hz
          const expected = helixPoint(desc, t)
          worst = Math.max(worst, dist(p, expected))
          const radial = dist(p, [
            desc.origin[0] + dot(sub(p, desc.origin), desc.axis) * desc.axis[0],
            desc.origin[1] + dot(sub(p, desc.origin), desc.axis) * desc.axis[1],
            desc.origin[2] + dot(sub(p, desc.origin), desc.axis) * desc.axis[2],
          ])
          worstRadial = Math.max(worstRadial, Math.abs(radial - desc.radius))
        }
        expect(worstRadial).toBeLessThan(1e-6 * desc.radius)
        expect(worst).toBeLessThan(1e-6 * desc.radius)
      } finally {
        scope.dispose()
      }
    }
  })

  it('helixMaxSegment grows with the turn count', () => {
    expect(helixMaxSegment(1)).toBeGreaterThanOrEqual(24)
    expect(helixMaxSegment(100)).toBeGreaterThan(helixMaxSegment(10))
  })

  it('BRepOffsetAPI_MakePipeShell SetMode_3 takes a gp_Dir', () => {
    const scope = new DisposeScope()
    try {
      const e = scope.track(makeLineEdge(oc!, scope, [0, 0, 0], [0, 0, 5]))
      const wire = scope.track(makeWire(oc!, scope, [e]))
      const builder = scope.track(new oc!.BRepOffsetAPI_MakePipeShell(wire))
      const dir = scope.track(new oc!.gp_Dir_4(0, 0, 1))
      // The gp_Dir overload is _3 (OCCT declares SpineSupport, gp_Ax2, gp_Dir,
      // boolean). A wrong overload throws a binding error naming the arity.
      expect(() => builder.SetMode_3(dir)).not.toThrow()
    } finally {
      scope.dispose()
    }
  })

  it('a cylinder surface reports its axial extent as the V range', () => {
    const scope = new DisposeScope()
    try {
      const { shape, faces } = makeCylinderWithFaces(oc!, scope, [0, 0, 0], [0, 0, 1], 5, 10)
      scope.track(shape)
      expect(faceSurfaceType(oc!, scope, faces.lateral)).toBe('cylinderface')
      const ad = scope.track(new oc!.BRepAdaptor_Surface_2(faces.lateral, true))
      const v0 = ad.FirstVParameter()
      const v1 = ad.LastVParameter()
      expect(Math.abs(Math.abs(v1 - v0) - 10)).toBeLessThan(1e-6)
      const cyl = scope.track(ad.Cylinder())
      const ax = cyl.Axis().Direction()
      const axis: Vec3 = [ax.X(), ax.Y(), ax.Z()]
      expect(dist(axis, [0, 0, 1])).toBeLessThan(1e-9)
      const radius = cyl.Radius()
      expect(Math.abs(radius - 5)).toBeLessThan(1e-6)
    } finally {
      scope.dispose()
    }
  })

  it('a primitive cylinder surface V runs along its axis from the base', () => {
    const scope = new DisposeScope()
    try {
      const shape = scope.track(makeCylinder(oc!, scope, [0, 0, 2], [0, 0, 1], 4, 6))
      const exp = scope.track(new oc!.TopExp_Explorer_2(shape, oc!.TopAbs_ShapeEnum.TopAbs_FACE, oc!.TopAbs_ShapeEnum.TopAbs_SHAPE))
      let lateral: OccShape | null = null
      for (; exp.More(); exp.Next()) {
        const f = scope.track(oc!.TopoDS.Face_1(exp.Current()))
        if (faceSurfaceType(oc!, scope, f) === 'cylinderface') { lateral = f; break }
      }
      if (lateral === null) throw new Error('no cylinder face')
      const ad = scope.track(new oc!.BRepAdaptor_Surface_2(lateral, true))
      const pos = scope.track(ad.Cylinder().Position())
      const loc = pos.Location()
      const base: Vec3 = [loc.X(), loc.Y(), loc.Z()]
      // The surface's V=0 reference sits at the cylinder's base corner.
      expect(dist(base, [0, 0, 2])).toBeLessThan(1e-6)
    } finally {
      scope.dispose()
    }
  })
})
