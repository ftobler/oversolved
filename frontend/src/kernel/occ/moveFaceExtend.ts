/**
 * Analytic face extension, the rung that survived the direct move-face rewrite.
 *
 * The move-face slab route needed a whole ladder here: rung 1 rebuilt the
 * analytic kinds, rung 2 widened a freeform face's UV window, rung 2b was its
 * ruled tangent strip, and rungs 3/4 probed two OCCT calls this build does not
 * bind. The slab route, and with it every freeform/flattening rung, is gone.
 * Defeature's wedge support still needs one bounded analytic face on a support
 * surface, which is rung 1 and only rung 1: a freeform support is refused by
 * name. `moveFaceRungs.ts` carries the one label and the text a refusal quotes.
 */

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'
import { faceSurfaceName, MoveFaceRefusal } from './moveFaceSurfaces'
import { RUNG_1, rungCatalog } from './moveFaceRungs'
import { TOL_SURFACE_IDENTITY } from '../solverConstants'

/** The surface classes an extension can grow. `freeform` is every non-analytic
 *  kind (B-spline, Bezier, revolution, extrusion, offset, other); rung 1 has no
 *  primitive for it, so the extender refuses it by name. */
export type ExtensionKind = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'freeform'

/** The one face (and, for a closed surface, the one solid) that can stand in
 *  for a neighbour as a bounded tool. */
export interface NeighbourTool {
  face: OccShape
  // A solid on the same surface for a kind whose full face is closed. Null when
  // the face alone bounds.
  solid: OccShape | null
  // The rung that produced it, for a refusal's rung list.
  rung: string
}

// ─── kinds ───

export function extensionKind(oc: OccModule, scope: DisposeScope, face: OccShape): ExtensionKind | null {
  const t = scope.track(new oc.BRepAdaptor_Surface_2(face, true)).GetType().value
  const S = oc.GeomAbs_SurfaceType
  if (t === S.GeomAbs_Plane.value) return 'plane'
  if (t === S.GeomAbs_Cylinder.value) return 'cylinder'
  if (t === S.GeomAbs_Cone.value) return 'cone'
  if (t === S.GeomAbs_Sphere.value) return 'sphere'
  if (t === S.GeomAbs_Torus.value) return 'torus'
  if (
    t === S.GeomAbs_BSplineSurface.value
    || t === S.GeomAbs_BezierSurface.value
    || t === S.GeomAbs_SurfaceOfRevolution.value
    || t === S.GeomAbs_SurfaceOfExtrusion.value
    || t === S.GeomAbs_OffsetSurface.value
    || t === S.GeomAbs_OtherSurface.value
  ) return 'freeform'
  return null
}

// ─── the analytic window ───

function analyticWindow(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  kind: 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus',
  L: number,
): OccShape {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  // The plane/cylinder/cone windows are the shipped construction: the v range
  // is [-L, L] (axial or slant length), a cone stops at its own apex so only
  // one nappe bounds, and the u range is the full turn.
  if (kind === 'plane') {
    const builder = scope.track(
      new oc.BRepBuilderAPI_MakeFace_9(scope.track(adaptor.Plane()), -L, L, -L, L),
    )
    return scope.track(builder.Face())
  }
  if (kind === 'cylinder') {
    const builder = scope.track(
      new oc.BRepBuilderAPI_MakeFace_10(scope.track(adaptor.Cylinder()), 0, 2 * Math.PI, -L, L),
    )
    return scope.track(builder.Face())
  }
  if (kind === 'cone') {
    const cone = scope.track(adaptor.Cone())
    const semi = cone.SemiAngle()
    const refR = cone.RefRadius()
    // v runs along the slant; the apex is where the radius reaches zero.
    const vApex = -refR / Math.sin(semi)
    let lo = -L
    let hi = L
    if (semi < 0) hi = vApex
    else lo = vApex
    const coneFace = scope.track(new oc.BRepBuilderAPI_MakeFace_11(cone, 0, 2 * Math.PI, lo, hi))
    return scope.track(coneFace.Face())
  }
  // Sphere and torus: the closed surface's own full parameter domain is the
  // only exact extension (a window past its poles/pinch is not the same
  // surface). The unrestricted adaptor reports that domain.
  const whole = scope.track(new oc.BRepAdaptor_Surface_2(face, false))
  const surface = scope.track(oc.BRep_Tool.Surface_2(face))
  const builder = scope.track(
    new oc.BRepBuilderAPI_MakeFace_14(
      surface,
      whole.FirstUParameter(),
      whole.LastUParameter(),
      whole.FirstVParameter(),
      whole.LastVParameter(),
      TOL_SURFACE_IDENTITY,
    ),
  )
  if (!builder.IsDone()) {
    throw new MoveFaceRefusal(`move_face: the full ${kind} face could not be rebuilt`)
  }
  return scope.track(builder.Face())
}

/** A solid on the neighbour's own analytic surface, for a kind whose full face
 *  is closed (a sphere or a torus): the boundary must partition the inside from
 *  the outside. */
function analyticSolid(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  kind: 'sphere' | 'torus',
): OccShape {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  if (kind === 'sphere') {
    const sph = scope.track(adaptor.Sphere())
    const pos = scope.track(sph.Position())
    const loc = scope.track(pos.Location())
    const centre = scope.track(new oc.gp_Pnt_3(loc.X(), loc.Y(), loc.Z()))
    const builder = scope.track(new oc.BRepPrimAPI_MakeSphere_5(centre, sph.Radius()))
    return scope.track(builder.Shape())
  }
  const tor = scope.track(adaptor.Torus())
  const pos = scope.track(tor.Position())
  const loc = scope.track(pos.Location())
  const dir = scope.track(pos.Direction())
  const frame = scope.track(
    new oc.gp_Ax2_4(
      scope.track(new oc.gp_Pnt_3(loc.X(), loc.Y(), loc.Z())),
      scope.track(new oc.gp_Dir_5(dir.X(), dir.Y(), dir.Z())),
    ),
  )
  const builder = scope.track(new oc.BRepPrimAPI_MakeTorus_5(frame, tor.MajorRadius(), tor.MinorRadius()))
  return scope.track(builder.Shape())
}

/**
 * Rebuild `face` as a large bounded analytic tool, or refuse by name. `L` sizes
 * the window; `margin` is accepted for the defeature caller's historical
 * signature and ignored by rung 1.
 */
export function extendNeighbour(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  L: number,
  _margin: number = L,
): NeighbourTool {
  const kind = extensionKind(oc, scope, face)
  if (kind === null || kind === 'freeform') {
    throw new MoveFaceRefusal(
      `move_face: neighbour face of type ${faceSurfaceName(oc, scope, face)} cannot be extended; ${rungCatalog(oc)}`,
    )
  }
  if (kind === 'sphere' || kind === 'torus') {
    return {
      face: analyticWindow(oc, scope, face, kind, L),
      solid: analyticSolid(oc, scope, face, kind),
      rung: RUNG_1,
    }
  }
  return {
    face: analyticWindow(oc, scope, face, kind, L),
    solid: null,
    rung: RUNG_1,
  }
}
