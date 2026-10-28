// A finite half-space tool: a box that covers everything on ONE side of a
// plane and nothing on the other, sized from the body it will cut.
//
// The split leaf intersects a body with a closed half-space. OCC has an
// infinite half-space primitive (BRepPrimAPI_MakeHalfSpace) but it is not
// bound, and infinite solids are a known OCC 7.4 boolean fragility. A finite
// box built through the ordinary boolean pipeline reuses the history-aware
// name transfer, the soundness guard and the tangency retry for free.
//
// The box is sized so nothing of the body can reach a wall or the far face:
// with `d` the body's bbox diagonal and `h` the distance from the bbox centre
// to the plane, the half-side and the prism length are both
// R = 2 * (d + h) + 1. Every point of the body is within `d` of the centre, so
// it is at most `h + d` from the plane and at most `d` from the centre's
// in-plane projection. The base square is centred on that projection, so the
// margin is positive on every side.

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccSubShape } from './occTypes'
import { drainList } from './disposeScope'
import {
  makeFaceFromWire,
  makeLineEdge,
  makeWire,
  shapeBndBox,
  type Vec3,
} from './primitives'
import { normalToFrame } from '../types3d'

export interface HalfSpaceBox {
  // The prism solid: the material the caller cuts away.
  shape: OccShape
  // The prism's start face, lying in the plane. Named by the caller so the cap
  // it leaves in the result carries a construction UUID.
  base: OccShape
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2])
  if (!(length > 1e-12)) throw new Error('halfSpace: the plane normal must be a non-zero vector')
  return [v[0] / length, v[1] / length, v[2] / length]
}

function addScaled(p: Vec3, axis: Vec3, s: number): Vec3 {
  return [p[0] + axis[0] * s, p[1] + axis[1] * s, p[2] + axis[2] * s]
}

/** The one face of `shape` that is the same sub-shape as `candidate`, or null. */
function sameFace(oc: OccModule, scope: DisposeScope, shape: OccShape, candidate: OccShape): OccShape | null {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const raw = scope.track(exp.Current())
    if ((raw as OccSubShape).IsSame(candidate as OccSubShape)) {
      return scope.track(oc.TopoDS.Face_1(raw))
    }
  }
  return null
}

/**
 * The prism's start face, found by construction.
 *
 * `FirstShape()` is the builder's own answer and the only fully direct route.
 * The binding marks it optional, so when it is absent (or returns a null
 * shape) fall back to the face the builder reports as Generated() from the
 * profile face: a copy of that face in the prism. Never by geometry -- a cap
 * matched by area and centroid would be indistinguishable from a wall on a
 * degenerate box.
 */
function prismBaseFace(
  oc: OccModule,
  scope: DisposeScope,
  builder: { FirstShape?(): OccShape; Generated(shape: OccShape): unknown },
  shape: OccShape,
  profile: OccShape,
): OccShape {
  if (typeof builder.FirstShape === 'function') {
    try {
      const first = scope.track(builder.FirstShape())
      // A null shape explores to nothing, so no IsNull probe is needed.
      const E = oc.TopAbs_ShapeEnum
      const exp = scope.track(new oc.TopExp_Explorer_2(first, E.TopAbs_FACE, E.TopAbs_SHAPE))
      if (exp.More()) return scope.track(oc.TopoDS.Face_1(scope.track(exp.Current())))
    } catch {
      // Fall through to the Generated() image below.
    }
  }
  const generated = drainList(scope, builder.Generated(profile) as never) as OccSubShape[]
  for (const g of generated) {
    const match = sameFace(oc, scope, shape, g as OccShape)
    if (match !== null) return match
  }
  throw new Error('halfSpace: the prism builder reported no start face for the half-space box')
}

/**
 * A box covering the whole `normal` side of the plane (origin, normal) around
 * `around`, and nothing on the other side. The plane is a boundary face of the
 * box; the caller cuts with it and names the resulting cap.
 *
 * The returned shapes are owned by the caller's scope.
 */
export function makeHalfSpaceBox(
  oc: OccModule,
  scope: DisposeScope,
  origin: Vec3,
  normal: Vec3,
  around: OccShape,
): HalfSpaceBox {
  const n = normalize(normal)
  const { centre, diagonal } = shapeBndBox(oc, scope, around)
  const offset = (centre[0] - origin[0]) * n[0] + (centre[1] - origin[1]) * n[1] + (centre[2] - origin[2]) * n[2]
  const reach = 2 * (diagonal + Math.abs(offset)) + 1
  // The base square is centred on the projection of the body's bbox centre, so
  // the body stays inside it even when the plane's origin is far in-plane.
  const projected = addScaled(centre, n, -offset)
  const { x_axis, y_axis } = normalToFrame(n)

  const corners: Vec3[] = []
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      corners.push(addScaled(addScaled(projected, x_axis, sx * reach), y_axis, sy * reach))
    }
  }
  // Walk the square in order so the wire is closed; makeWire heals the corners.
  const loop: Vec3[] = [corners[0], corners[1], corners[3], corners[2]]
  const edges = loop.map((corner, i) => scope.track(makeLineEdge(oc, scope, corner, loop[(i + 1) % loop.length])))
  const wire = scope.track(makeWire(oc, scope, edges, { requireClosed: true }))
  const profile = scope.track(makeFaceFromWire(oc, scope, wire))

  const vec = scope.track(new oc.gp_Vec_4(n[0] * reach, n[1] * reach, n[2] * reach))
  const builder = scope.track(new oc.BRepPrimAPI_MakePrism_1(profile, vec, true, true))
  const shape = scope.track(builder.Shape())
  const base = prismBaseFace(oc, scope, builder, shape, profile)
  return { shape, base }
}
