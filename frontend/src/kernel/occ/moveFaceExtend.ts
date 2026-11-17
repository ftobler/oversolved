/**
 * Neighbour extension for move-face, as a rung ladder.
 *
 * The slab between the picked surface S and its target S_d is thin (|d|), so a
 * neighbour only has to be continued a little past its own boundary to cross
 * it. Rung 1 rebuilds the analytic kinds exactly (a full sphere or torus, the
 * existing plane/cylinder/cone windows). Rung 2 widens a freeform face's own
 * UV window on the very Geom_Surface the face is stored on, which is OCCT's
 * end-span polynomial extension for a B-spline/Bezier surface and the exact
 * continuation of a revolution/extrusion/offset basis. Rung 2b is the fallback
 * when OCCT refuses that window: a ruled strip from the edge shared with the
 * picked face, the G1 tangent continuation. Rung 3 would call
 * GeomLib::ExtendSurfByLength (not bound in this pinned OCCT build) and rung 4
 * the per-face BRepOffset_MakeOffset (also not bound). The two unbound rungs
 * are probed by `typeof` at runtime, so a future binding flips them on without
 * a code change, and a refusal names every rung and why it did not run.
 *
 * The widened patch passes the extension gate first: the original face's
 * boundary still lies on the extended face (no trim lost) and the surface
 * normal does not flip anywhere on the widened grid (a polynomial continuation
 * can fold). A patch that fails is not returned; the ladder falls through. The
 * pinned build rejects every out-of-domain window in BRepCheck, so rung 2b is
 * the rung that runs here; the gate stays because a future build may accept the
 * window. This is deliberately cheaper than a mesh self-intersection test and
 * catches the one failure mode a widened window has: a fold.
 *
 * A full sphere or torus face is a closed shell with no free boundary and does
 * not partition the slab (the same reason a full cylinder needs a solid
 * replacement in moveFaceSurfaces.ts), so rung 1 also offers a solid on the
 * same surface for the splitter's replacement ladder.
 */

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccSurfaceAdaptor } from './occTypes'
import { canonicalEdges } from './partNames'
import { faceSurfaceName, MoveFaceRefusal, pointInFace } from './moveFaceSurfaces'
import { unboundRungReason, RUNG_1, RUNG_2, RUNG_2_STRIP, RUNG_3, RUNG_4, rungCatalog } from './moveFaceRungs'
import { TOL_SURFACE_IDENTITY } from '../solverConstants'
import { isHeapCorruptionTrap } from '../errors'
import { makeTranslationTrsf, transformCopy } from './transforms'
import type { Vec3 } from '@/utils/vec3'

/** The surface classes an extension can grow. `freeform` is every kind rung 2
 *  widens through the face's own surface window (B-spline, Bezier, revolution,
 *  extrusion, offset, other). */
export type ExtensionKind = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'freeform'

/** The one face (and, for a closed surface, the one solid) that replaces a
 *  neighbour as a splitter tool. */
export interface NeighbourTool {
  face: OccShape
  // A solid on the same surface for a kind whose full face cannot partition
  // the slab. Null when the face alone cuts.
  solid: OccShape | null
  // The rung that produced it, for the refusal ladder and the probe.
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

// ─── rung 1: analytic windows ───

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
  // one nappe splits, and the u range is the full turn.
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
  // surface). The unrestricted adaptor reports that domain; the restricted one
  // reports only this face's trim.
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
 *  is closed (a sphere or a torus): the splitter needs a shape whose boundary
 *  partitions the slab. */
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

// ─── rung 2: the widened UV patch ───

/**
 * A widened window that stays inside a periodic direction's own period; a
 * closed non-periodic direction (a sphere's polar angle, a closed B-spline
 * direction without a period) is not widened at all: past the closure the
 * window would fold the surface onto itself. OCCT throws for UPeriod() on a
 * direction that is not periodic, so the period is only read when
 * `periodic` is true.
 */
function widenedRange(
  lo: number,
  hi: number,
  margin: number,
  periodic: boolean,
  closed: boolean,
  period: number,
): [number, number] {
  if (closed && !periodic) return [lo, hi]
  let a = lo - margin
  let b = hi + margin
  if (periodic && period > 0 && b - a > period) {
    const centre = (lo + hi) / 2
    a = centre - period / 2
    b = centre + period / 2
  }
  return [a, b]
}

/** The surface normal (du x dv, unnormalised) at a UV point, or null at a
 *  degenerate point (a pole, a cone apex) where it vanishes. */
function surfaceNormalAt(
  oc: OccModule,
  scope: DisposeScope,
  adaptor: OccSurfaceAdaptor,
  u: number,
  v: number,
): Vec3 | null {
  const p = scope.track(new oc.gp_Pnt_1())
  const du = scope.track(new oc.gp_Vec_1())
  const dv = scope.track(new oc.gp_Vec_1())
  adaptor.D1(u, v, p, du, dv)
  const x = du.Y() * dv.Z() - du.Z() * dv.Y()
  const y = du.Z() * dv.X() - du.X() * dv.Z()
  const z = du.X() * dv.Y() - du.Y() * dv.X()
  const len = Math.hypot(x, y, z)
  if (len < 1e-12) return null
  return [x / len, y / len, z / len]
}

/**
 * The extension gate for a widened patch: every sampled boundary point of the
 * original face classifies on the extended face, and the patch's surface normal
 * keeps the original's sense on a grid over its window. A polynomial
 * continuation that folds flips the normal, which is the failure this catches;
 * a lost trim shows as a boundary point outside the patch.
 */
function assertExtensionSound(
  oc: OccModule,
  scope: DisposeScope,
  original: OccShape,
  extended: OccShape,
  surfaceName: string,
): void {
  for (const edge of canonicalEdges(oc, scope, original) as OccShape[]) {
    const curve = scope.track(new oc.BRepAdaptor_Curve_2(edge))
    const first = curve.FirstParameter()
    const last = curve.LastParameter()
    for (const t of [0.25, 0.5, 0.75]) {
      const pnt = scope.track(curve.Value(first + (last - first) * t))
      const p: Vec3 = [pnt.X(), pnt.Y(), pnt.Z()]
      if (!pointInFace(oc, scope, extended, p, TOL_SURFACE_IDENTITY)) {
        throw new MoveFaceRefusal(
          `move_face: the widened ${surfaceName} patch lost the neighbour's original boundary`,
        )
      }
    }
  }
  const baseAdaptor = scope.track(new oc.BRepAdaptor_Surface_2(original, true))
  const bu = (baseAdaptor.FirstUParameter() + baseAdaptor.LastUParameter()) / 2
  const bv = (baseAdaptor.FirstVParameter() + baseAdaptor.LastVParameter()) / 2
  const base = surfaceNormalAt(oc, scope, baseAdaptor, bu, bv)
  if (base === null) return
  const wide = scope.track(new oc.BRepAdaptor_Surface_2(extended, true))
  const u0 = wide.FirstUParameter()
  const u1 = wide.LastUParameter()
  const v0 = wide.FirstVParameter()
  const v1 = wide.LastVParameter()
  for (let i = 0; i <= 6; i++) {
    for (let j = 0; j <= 6; j++) {
      const n = surfaceNormalAt(oc, scope, wide, u0 + ((u1 - u0) * i) / 6, v0 + ((v1 - v0) * j) / 6)
      if (n === null) continue
      if (n[0] * base[0] + n[1] * base[1] + n[2] * base[2] <= 0) {
        throw new MoveFaceRefusal(
          `move_face: the widened ${surfaceName} patch folds (the surface normal flips inside the slab)`,
        )
      }
    }
  }
}

function widenedFreeformFace(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  margin: number,
): OccShape {
  const restricted = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const uPeriodic = restricted.IsUPeriodic()
  const uRange = widenedRange(
    restricted.FirstUParameter(),
    restricted.LastUParameter(),
    margin,
    uPeriodic,
    restricted.IsUClosed(),
    uPeriodic ? restricted.UPeriod() : 0,
  )
  const vPeriodic = restricted.IsVPeriodic()
  const vRange = widenedRange(
    restricted.FirstVParameter(),
    restricted.LastVParameter(),
    margin,
    vPeriodic,
    restricted.IsVClosed(),
    vPeriodic ? restricted.VPeriod() : 0,
  )
  const surface = scope.track(oc.BRep_Tool.Surface_2(face))
  const builder = scope.track(
    new oc.BRepBuilderAPI_MakeFace_14(surface, uRange[0], uRange[1], vRange[0], vRange[1], TOL_SURFACE_IDENTITY),
  )
  // MakeFace can report done and still leave an empty face when the window
  // crosses a pole; the builder state is the cheap half of the gate.
  if (!builder.IsDone()) {
    throw new MoveFaceRefusal('move_face: the widened patch could not be built on the neighbour surface')
  }
  const extended = scope.track(builder.Face())
  // OCCT refuses a face window past a B-spline's knot range even though the
  // evaluator extrapolates: BRepCheck calls the out-of-domain window invalid,
  // and an invalid tool face makes the splitter give up. That is exactly the
  // case the pinned build hits, so the ladder falls through to the G1 strip.
  const analyser = scope.track(new oc.BRepCheck_Analyzer(extended, true, false, false))
  if (!analyser.IsValid_2()) {
    throw new MoveFaceRefusal(
      'move_face: the widened patch is not a valid face (OCCT rejects a window past the surface domain)',
    )
  }
  assertExtensionSound(oc, scope, face, extended, faceSurfaceName(oc, scope, face))
  return extended
}

/**
 * The G1 fallback for a freeform neighbour: a ruled strip swept from the edge
 * the neighbour shares with the picked face, through the slab along the picked
 * face's own normal. It is the tangent-plane continuation the surface's own
 * first derivative gives at that edge, so it meets the neighbour and the moved
 * face tangentially; the deviation from the true continuation is O(d^2 / R)
 * (0.005 mm for the fixture's r=25 sphere at d=0.5), below the consumer of the
 * mesh and far below the model's own tolerance.
 *
 * The strip starts a margin BEHIND the slab's source face and ends a margin
 * past the target face. A tool that starts flush with a slab face shares an
 * edge with it, and OCCT's splitter leaves the two cells merged on that
 * coincident start; crossing both faces removes the coincidence.
 */
function tangentStrip(
  oc: OccModule,
  scope: DisposeScope,
  edge: OccShape,
  normal: Vec3,
  d: number,
): OccShape {
  const margin = Math.max(0.25 * Math.abs(d), 1e-3)
  const sign = Math.sign(d)
  const trsf = makeTranslationTrsf(
    oc,
    scope,
    normal[0] * -sign * margin,
    normal[1] * -sign * margin,
    normal[2] * -sign * margin,
  )
  const start = scope.track(transformCopy(oc, scope, edge, trsf))
  const length = sign * (Math.abs(d) + 2 * margin)
  const vec = scope.track(new oc.gp_Vec_4(normal[0] * length, normal[1] * length, normal[2] * length))
  const builder = scope.track(new oc.BRepPrimAPI_MakePrism_1(start, vec, true, false))
  // A prism of an edge is a shell holding one face; the splitter and the
  // name transfer both want the face itself.
  const shape = scope.track(builder.Shape())
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  if (!exp.More()) throw new MoveFaceRefusal('move_face: the ruled continuation of the neighbour edge produced no face')
  return scope.track(oc.TopoDS.Face_1(scope.track(exp.Current())))
}

// ─── the ladder ───

/**
 * Rebuild `face` as a large tool face (and, for a closed surface, a solid
 * replacement), trying rung 1 then rung 2's widened patch, then rung 2b's
 * ruled tangent continuation along the edge shared with the picked face. `L`
 * sizes the analytic windows (they are the shipped global span); `margin` is
 * how far a freeform patch is widened past the face; `normal` and `d` are the
 * move the strip follows. Throws MoveFaceRefusal naming every rung when none
 * produces a usable tool.
 */
export function extendNeighbour(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  edge: OccShape | null,
  normal: Vec3,
  d: number,
  L: number,
  margin: number,
): NeighbourTool {
  const kind = extensionKind(oc, scope, face)
  const name = faceSurfaceName(oc, scope, face)
  const failures: string[] = []
  if (kind === null) {
    throw new MoveFaceRefusal(
      `move_face: neighbour face of type ${name} cannot be extended; ${rungCatalog(oc)}`,
    )
  }
  if (kind === 'plane' || kind === 'cylinder' || kind === 'cone') {
    return {
      face: analyticWindow(oc, scope, face, kind, L),
      solid: null,
      rung: RUNG_1,
    }
  }
  if (kind === 'sphere' || kind === 'torus') {
    try {
      return {
        face: analyticWindow(oc, scope, face, kind, L),
        solid: analyticSolid(oc, scope, face, kind),
        rung: RUNG_1,
      }
    } catch (e) {
      // An embind binding error (a surface handle this build will not accept)
      // is a rung failure like a refusal: fall through, do not crash the move.
      if (isHeapCorruptionTrap(e)) throw e
      failures.push(`${RUNG_1}: ${(e as Error).message}`)
    }
  }
  try {
    return {
      face: widenedFreeformFace(oc, scope, face, margin),
      solid: null,
      rung: RUNG_2,
    }
  } catch (e) {
    if (isHeapCorruptionTrap(e)) throw e
    failures.push(`${RUNG_2}: ${(e as Error).message}`)
  }
  // A freeform kind never had an analytic primitive: rung 1's reason is part
  // of the ladder even though it was not attempted, so a refusal names it.
  if (kind === 'freeform') failures.unshift(`${RUNG_1}: ${name} has no analytic primitive to rebuild`)
  if (d !== 0 && edge !== null) {
    return {
      face: tangentStrip(oc, scope, edge, normal, d),
      solid: null,
      rung: RUNG_2_STRIP,
    }
  }
  failures.push(`${RUNG_2_STRIP}: ${edge === null ? 'no shared edge' : 'no move direction (d = 0)'}`)
  failures.push(unboundRungReason(oc, RUNG_3))
  failures.push(unboundRungReason(oc, RUNG_4))
  throw new MoveFaceRefusal(
    `move_face: neighbour face of type ${name} cannot be extended (${failures.join('; ')})`,
  )
}
