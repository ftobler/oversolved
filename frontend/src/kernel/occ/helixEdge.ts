// Build a helix as an OCC edge on a cylinder. This is the only place an OCC
// helix edge is made; it is rebuilt from the pure descriptor (helixMath) on
// every use, never cached, so the repo can keep plain data and a checkpoint
// restore needs no special handling.
//
// The curve lives in the cylinder surface's parameter space: a Geom2d_Line in
// (u, v) with u the angle about the climb axis and v the axial rise, built by
// the parametric BRepBuilderAPI_MakeEdge overload and lifted to 3D by
// BRepLib::BuildCurves3d. The descriptor carries a0 (refAxis) and x0, so
// startUV/uvDirection own the frame conversion and this adapter only wires it to
// OCC.

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'
import { startUV, uvDirection, type HelixDescriptor } from '../features/helixMath'

const TWO_PI = 2 * Math.PI

/**
 * The BuildCurves3d segment count for a turn count. BuildCurves3d approximates
 * the parametric edge with a BSpline whose deviation grows with the sweep, so
 * an unbounded default lets a 100-turn helix drift off the cylinder. Four
 * segments per turn keeps the radial/axial deviation far under 1e-6 * r for the
 * turn counts the probe measures (1, 10, 100).
 */
export function helixMaxSegment(turns: number): number {
  return Math.max(24, Math.ceil(Math.abs(turns) * 4))
}

/** Build the helix edge for `desc`. OWNERSHIP: returned UNTRACKED, as every
 *  occ/primitives.ts producer; the caller tracks or releases it. */
export function buildCurveEdge(oc: OccModule, scope: DisposeScope, desc: HelixDescriptor): OccShape {
  const pnt = scope.track(new oc.gp_Pnt_3(desc.origin[0], desc.origin[1], desc.origin[2]))
  const normal = scope.track(new oc.gp_Dir_4(desc.axis[0], desc.axis[1], desc.axis[2]))
  const xDir = scope.track(new oc.gp_Dir_4(desc.xAxis[0], desc.xAxis[1], desc.xAxis[2]))
  const ax3 = scope.track(new oc.gp_Ax3_3(pnt, normal, xDir))
  const surf = scope.track(new oc.Geom_CylindricalSurface_1(ax3, desc.radius))

  const { u } = startUV(desc)
  const { du, dv } = uvDirection(desc)
  const p2d = scope.track(new oc.gp_Pnt2d_3(u, 0))
  const d2d = scope.track(new oc.gp_Dir2d_4(du, dv))
  const line = scope.track(new oc.Geom2d_Line_3(p2d, d2d))

  const hCurve = scope.track(new oc.Handle_Geom2d_Curve_2(line))
  const hSurf = scope.track(new oc.Handle_Geom_Surface_2(surf))

  // Over the parameter range [0, len2d] the 2D line advances one turn of angle
  // per pitch of axial rise, for `turns` turns.
  const len2d = desc.turns * Math.hypot(TWO_PI, desc.pitch)
  const maker = scope.track(new oc.BRepBuilderAPI_MakeEdge_31(hCurve, hSurf, 0, len2d))
  const edge = maker.Edge()
  oc.BRepLib.BuildCurves3d_1(
    edge,
    1e-7,
    oc.GeomAbs_Shape.GeomAbs_C1,
    14,
    helixMaxSegment(desc.turns),
  )
  return edge
}
