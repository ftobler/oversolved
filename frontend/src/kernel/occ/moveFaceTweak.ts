/**
 * The direct B-rep move-face: move the picked faces' surfaces, re-intersect the
 * edges and vertices that touch them, rebuild the changed faces, assemble the
 * shell and hand the result to the cleanup layer.
 *
 * The construction is a modification, not a boolean:
 *
 *   1. Surfaces: each picked face carries its moved surface from
 *      `moveFaceSurfaces.ts`; every other face keeps its own.
 *   2. Edges: an edge with a picked incident face gets the intersection curve
 *      of its two (possibly moved) surfaces. A seam edge uses the moved
 *      surface's own seam plane. Coincident surfaces keep the edge, which is
 *      what lets the cleanup fold a moved face onto a coplanar neighbour.
 *   3. Vertices: a vertex with a picked incident face is the intersection of
 *      its incident surfaces (a 3-plane linear solve, or the nearest meeting
 *      point of the incident intersection curves).
 *   4. Faces: every face with a changed edge is rebuilt from its surface and
 *      its wires; the others are reused. `targetFace` gives the moved surface's
 *      large section face, and `targetSurface` the surface the rebuilt face is
 *      made on.
 *   5. Shell: the faces share their edge objects, so a `BRep_Builder` shell and
 *      `MakeSolid` are enough (`BRepBuilderAPI_Sewing` is not bound).
 *
 * A signed distance means: positive grows (the tweak), negative removes
 * material. The negative direction is the boundaryless cutter the user asked
 * for: the body is intersected with the material half-space of the moved
 * surface, so features away from the picked face are cut too. For a plane that
 * is the half-space box; for a curved kind it is the primitive's outside solid.
 * Every inward pick is one cut, so the result is independent of pick order.
 *
 * No naming happens here: `applyMoveFaces` returns the final-face to source-face
 * origin, which the leaf hands to `transferBooleanNames`.
 */

import type { DisposeScope } from './disposeScope'
import type { OccAx3, OccDisposable, OccModule, OccReShape, OccShape, OccSubShape } from './occTypes'
import type { BrepDiff } from '../types3d'
import { emptyBrepDiff } from '../types3d'
import { SubShapeMap as IdentityMap } from './subshapeIdentity'
import {
  canonicalEdges,
  canonicalFaces,
  canonicalVertices,
} from './partNames'
import {
  makeArcEdge,
  makeCircleEdge,
  bboxDiagonal,
  faceArea,
  faceCentroid,
  faceNormal,
  type Vec3,
} from './primitives'
import { booleanWithDiff } from './booleans'
import { movedSurface, sameAnalyticSurface, type MovedSurface, MoveFaceRefusal } from './moveFaceSurfaces'
import { offsetResultSolid } from './offsetShape'
import { runCleanup } from './cleanup/pipeline'
import { heal } from './cleanup/heal'
import { unifySameDomain } from './cleanup/unifySameDomain'
import { shapeIsValid } from './cleanup/guard'
import { volumeOfDefault } from './volume'
import { TOL_SURFACE_IDENTITY } from '../solverConstants'
import { noProgress } from './defaultArgs'
import { add, cross, dot, scale, sub } from '@/utils/vec3'
import {
  chooseBranch,
  intersectThreePlanes,
  type Plane,
} from './moveFaceTweakGeometry'

/** One pick: the face and its signed distance along the outward normal. */
export interface TweakPick {
  face: OccShape
  distance: number
}

/**
 * A final face's source. `fromTool` carries an inward cutter's cap, which has
 * no original face; the leaf names it with the pick that produced it.
 */
export interface TweakOrigin {
  output: OccSubShape
  source: OccSubShape
  fromTool: boolean
}

export interface TweakResult {
  shape: OccShape
  // Final face -> source face, ready for `transferBooleanNames`.
  faceOrigin: TweakOrigin[]
  // The source tool faces of the inward caps, mapped to the pick that made
  // them, so the leaf can name each cap with that pick's UUID.
  toolFacePick: IdentityMap<TweakPick>
  diff: BrepDiff
  changed: boolean
}

// ─── surfaces ───

/** A face's (possibly moved) surface in the two forms the tweak reads. */
interface TweakSurface {
  kind: string
  // A large bounded face on the surface, for the section tools.
  large(L: number): OccShape
  // The Geom_Surface a rebuilt face is made on (owned by the caller's scope).
  surface(): OccDisposable
  // The plane, when the surface is planar (the fast vertex solve).
  plane: Plane | null
}

function originalSurface(oc: OccModule, scope: DisposeScope, face: OccShape): TweakSurface {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const S = oc.GeomAbs_SurfaceType
  const t = adaptor.GetType().value
  // The surface a rebuilt face is made on must be in WORLD coordinates, like
  // the new edges. BRep_Tool.Surface_2(face) can carry the face's placement
  // unapplied, which a placed import or an extruded sketch exposes; the large
  // face built from the adaptor is already world and shares the frame.
  const worldSurface = (large: () => OccShape): (() => OccDisposable) => () => scope.track(oc.BRep_Tool.Surface_2(large()))
  if (t === S.GeomAbs_Plane.value) {
    const plane = scope.track(adaptor.Plane())
    const n = normalOf(oc, scope, face)
    const large = (L: number): OccShape => scope.track(new oc.BRepBuilderAPI_MakeFace_9(plane, -L, L, -L, L).Face())
    return {
      kind: 'plane',
      large,
      surface: worldSurface(() => large(1)),
      plane: { point: centroidOf(oc, scope, face), normal: n },
    }
  }
  if (t === S.GeomAbs_Cylinder.value) {
    const cyl = scope.track(adaptor.Cylinder())
    const large = (L: number): OccShape => scope.track(new oc.BRepBuilderAPI_MakeFace_10(cyl, 0, 2 * Math.PI, -L, L).Face())
    return { kind: 'cylinder', large, surface: worldSurface(() => large(1)), plane: null }
  }
  if (t === S.GeomAbs_Cone.value) {
    const cone = scope.track(adaptor.Cone())
    const large = (L: number): OccShape => scope.track(new oc.BRepBuilderAPI_MakeFace_11(cone, 0, 2 * Math.PI, -2 * L, 2 * L).Face())
    return { kind: 'cone', large, surface: worldSurface(() => large(1)), plane: null }
  }
  if (t === S.GeomAbs_Sphere.value) {
    const sphere = scope.track(adaptor.Sphere())
    const large = (): OccShape => scope.track(new oc.BRepBuilderAPI_MakeFace_6(sphere).Face())
    return { kind: 'sphere', large, surface: worldSurface(large), plane: null }
  }
  if (t === S.GeomAbs_Torus.value) {
    const torus = scope.track(adaptor.Torus())
    const large = (): OccShape => scope.track(new oc.BRepBuilderAPI_MakeFace_7(torus).Face())
    return { kind: 'torus', large, surface: worldSurface(large), plane: null }
  }
  // A freeform neighbour: its own trimmed surface widened by the generic maker.
  // Out-of-domain parameters are the end-span extension the rung-2b strip uses;
  // a refusal here is the pick's named refusal, not a guess.
  return {
    kind: 'freeform',
    large: (L) => scope.track(new oc.BRepBuilderAPI_MakeFace_14(scope.track(oc.BRep_Tool.Surface_2(face)), -L, L, -L, L, 1e-7).Face()),
    surface: () => scope.track(oc.BRep_Tool.Surface_2(face)),
    plane: null,
  }
}

function movedTweakSurface(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  surface: MovedSurface,
  d: number,
): TweakSurface {
  const S = oc.GeomAbs_SurfaceType
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const t = adaptor.GetType().value
  let plane: Plane | null = null
  if (t === S.GeomAbs_Plane.value) {
    const n = normalOf(oc, scope, face)
    plane = { point: add(centroidOf(oc, scope, face), scale(n, d)), normal: n }
  }
  return {
    kind: surface.kind,
    large: (L) => surface.targetFace(L),
    surface: () => surface.targetSurface(),
    plane,
  }
}

const centroidOf = faceCentroid
const normalOf = faceNormal

// ─── incidence ───

interface Incidence {
  faces: OccShape[]
  edges: OccShape[]
  vertices: OccShape[]
  edgesOfFace: IdentityMap<OccShape[]>
  facesOfEdge: IdentityMap<OccShape[]>
  verticesOfEdge: IdentityMap<OccShape[]>
  edgesOfVertex: IdentityMap<OccShape[]>
  facesOfVertex: IdentityMap<OccShape[]>
  verticesOfFace: (face: OccShape) => OccShape[]
}

function buildIncidence(oc: OccModule, scope: DisposeScope, part: OccShape): Incidence {
  const faces = canonicalFaces(oc, scope, part) as OccShape[]
  const edges = canonicalEdges(oc, scope, part) as OccShape[]
  const vertices = canonicalVertices(oc, scope, part) as OccShape[]
  const edgesOfFace = new IdentityMap<OccShape[]>()
  const facesOfEdge = new IdentityMap<OccShape[]>()
  const verticesOfEdge = new IdentityMap<OccShape[]>()
  const edgesOfVertex = new IdentityMap<OccShape[]>()
  const facesOfVertex = new IdentityMap<OccShape[]>()
  const push = <T>(map: IdentityMap<T[]>, key: OccSubShape, value: T): void => {
    const list = map.get(key)
    if (list === undefined) map.set(key, [value])
    else list.push(value)
  }
  const addFace = (face: OccShape, edge: OccShape): void => {
    push(edgesOfFace, face as OccSubShape, edge)
    push(facesOfEdge, edge as OccSubShape, face)
  }
  const addVertex = (edge: OccShape, vertex: OccShape): void => {
    push(verticesOfEdge, edge as OccSubShape, vertex)
    push(edgesOfVertex, vertex as OccSubShape, edge)
  }
  for (const face of faces) {
    for (const edge of canonicalEdges(oc, scope, face) as OccShape[]) addFace(face, edge)
  }
  for (const edge of edges) {
    for (const vertex of canonicalVertices(oc, scope, edge) as OccShape[]) addVertex(edge, vertex)
  }
  // facesOfVertex from the edge incidence, not a scan: every face of a vertex
  // owns one of its edges.
  for (const vertex of vertices) {
    const list: OccShape[] = []
    for (const edge of edgesOfVertex.get(vertex as OccSubShape) ?? []) {
      for (const face of facesOfEdge.get(edge as OccSubShape) ?? []) {
        if (!list.some((f) => (f as OccSubShape).IsSame(face as OccSubShape))) list.push(face)
      }
    }
    facesOfVertex.set(vertex as OccSubShape, list)
  }
  const verticesOfFace = (face: OccShape): OccShape[] => {
    const out: OccShape[] = []
    for (const edge of edgesOfFace.get(face as OccSubShape) ?? []) {
      for (const vertex of verticesOfEdge.get(edge as OccSubShape) ?? []) {
        if (!out.some((v) => (v as OccSubShape).IsSame(vertex as OccSubShape))) out.push(vertex)
      }
    }
    return out
  }
  return { faces, edges, vertices, edgesOfFace, facesOfEdge, verticesOfEdge, edgesOfVertex, facesOfVertex, verticesOfFace }
}

// ─── sections ───

interface SectionCurve {
  edge: OccShape
  mid: Vec3
  tangent: Vec3 | null
}

/** Edges on `b`'s surface after `a` is split by `b`; the split lines. */
function sectionCurves(
  oc: OccModule,
  scope: DisposeScope,
  a: OccShape,
  b: OccShape,
): SectionCurve[] {
  const splitter = scope.track(new oc.BRepAlgoAPI_Splitter_1())
  const args = scope.track(new oc.TopTools_ListOfShape_1())
  args.Append_1(a)
  const tools = scope.track(new oc.TopTools_ListOfShape_1())
  tools.Append_1(b)
  splitter.SetArguments(args)
  splitter.SetTools(tools)
  splitter.Build(noProgress(oc))
  if (!splitter.IsDone()) throw new MoveFaceRefusal('move_face: the surface intersection did not complete')
  const result = scope.track(splitter.Shape())
  const out: SectionCurve[] = []
  for (const edge of canonicalEdges(oc, scope, result) as OccShape[]) {
    if (oc.BRep_Tool.Degenerated?.(edge)) continue
    const adaptor = scope.track(new oc.BRepAdaptor_Curve_2(edge))
    const u0 = adaptor.FirstParameter()
    const u1 = adaptor.LastParameter()
    const mid = pointAt(adaptor, (u0 + u1) / 2)
    if (distanceToShape(oc, scope, mid, b) > TOL_SURFACE_IDENTITY) continue
    const h = Math.abs(u1 - u0) * 1e-4 + 1e-9
    const before = pointAt(adaptor, Math.max(u0, (u0 + u1) / 2 - h))
    const after = pointAt(adaptor, Math.min(u1, (u0 + u1) / 2 + h))
    const tangent = unit(sub(after, before))
    out.push({ edge, mid, tangent })
  }
  return out
}

function pointAt(adaptor: { Value(u: number): { X(): number; Y(): number; Z(): number; delete(): void } }, u: number): Vec3 {
  const p = adaptor.Value(u)
  const out: Vec3 = [p.X(), p.Y(), p.Z()]
  p.delete()
  return out
}

function unit(v: Vec3): Vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2])
  return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : null
}

function distanceToShape(oc: OccModule, scope: DisposeScope, p: Vec3, shape: OccShape): number {
  const vertex = scope.track(new oc.BRepBuilderAPI_MakeVertex(
    scope.track(new oc.gp_Pnt_3(p[0], p[1], p[2])),
  ).Vertex())
  const extrema = scope.track(new oc.BRepExtrema_DistShapeShape_3(
    vertex,
    shape,
    1e-7,
    oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN,
    oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad,
    noProgress(oc),
  ))
  return extrema.IsDone() ? extrema.Value() : Infinity
}

function closestPointOn(oc: OccModule, scope: DisposeScope, p: Vec3, shape: OccShape): Vec3 | null {
  const vertex = scope.track(new oc.BRepBuilderAPI_MakeVertex(
    scope.track(new oc.gp_Pnt_3(p[0], p[1], p[2])),
  ).Vertex())
  const extrema = scope.track(new oc.BRepExtrema_DistShapeShape_3(
    vertex,
    shape,
    1e-7,
    oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN,
    oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad,
    noProgress(oc),
  ))
  if (!extrema.IsDone()) return null
  const hit = extrema.PointOnShape2(1)
  return [hit.X(), hit.Y(), hit.Z()]
}

// ─── the tweak ───

interface EdgePlan {
  oldEdge: OccShape
  newEdge: OccShape | null
  closed: boolean
}

/** Move the positive picks in one simultaneous tweak. */
function tweakOutward(
  oc: OccModule,
  scope: DisposeScope,
  part: OccShape,
  picks: TweakPick[],
): { shape: OccShape; faceOrigin: TweakOrigin[]; modified: Set<OccShape> } {
  const inc = buildIncidence(oc, scope, part)
  const picked = new IdentityMap<number>()
  picks.forEach((pick, i) => picked.set(pick.face as OccSubShape, i))
  const L = 4 * (bboxDiagonal(oc, scope, part) + Math.max(...picks.map((p) => Math.abs(p.distance))))

  // The original surfaces first: the planar collapse clamp below reads the
  // neighbours' own surfaces, not their moved copies.
  const originals = new IdentityMap<TweakSurface>()
  for (const face of inc.faces) originals.set(face as OccSubShape, originalSurface(oc, scope, face))
  const originalPairs = new Map<string, SectionCurve[]>()
  const sectionOriginal = (a: OccShape, b: OccShape): SectionCurve[] => {
    const keyA = sectionKey(a, b)
    const cached = originalPairs.get(keyA)
    if (cached !== undefined) return cached
    const curves = sectionCurves(oc, scope, (originals.get(a as OccSubShape) as TweakSurface).large(L), (originals.get(b as OccSubShape) as TweakSurface).large(L))
    originalPairs.set(keyA, curves)
    return curves
  }
  // A planar picked face whose neighbours converge behind it vanishes when the
  // move reaches their meeting curve. Clamp the distance to that curve so a
  // move past the collapse gives the same body as the move exactly to it (the
  // wedge's stability invariant); the pick's own edges then re-intersect the
  // neighbours with each other.
  const effective = picks.map((pick) => {
    if (pick.distance <= 0) return pick.distance
    const surface = originals.get(pick.face as OccSubShape) as TweakSurface
    if (surface.plane === null) return pick.distance
    const neighbours: OccShape[] = []
    for (const edge of inc.edgesOfFace.get(pick.face as OccSubShape) ?? []) {
      for (const other of inc.facesOfEdge.get(edge as OccSubShape) ?? []) {
        if ((other as OccSubShape).IsSame(pick.face as OccSubShape)) continue
        if (!neighbours.some((f) => (f as OccSubShape).IsSame(other as OccSubShape))) neighbours.push(other)
      }
    }
    let limit = Infinity
    for (let a = 0; a < neighbours.length; a++) {
      for (let b = a + 1; b < neighbours.length; b++) {
        if (a === b) continue
        if ((neighbours[a] as OccSubShape).IsSame(neighbours[b] as OccSubShape)) continue
        for (const curve of sectionOriginal(neighbours[a], neighbours[b])) {
          const adaptor = scope.track(new oc.BRepAdaptor_Curve_2(curve.edge))
          const u0 = adaptor.FirstParameter()
          const u1 = adaptor.LastParameter()
          const distances = [u0, (u0 + u1) / 2, u1].map((u) => {
            const p = pointAt(adaptor, u)
            return dot(sub(p, surface.plane!.point), surface.plane!.normal)
          })
          const spread = Math.max(...distances) - Math.min(...distances)
          if (spread > 1e-6 * L) continue
          const at = distances[1]
          if (at > 1e-9 && at < limit) limit = at
        }
      }
    }
    return Number.isFinite(limit) ? Math.min(pick.distance, limit) : pick.distance
  })

  const surfaces = new IdentityMap<TweakSurface>()
  for (const face of inc.faces) {
    const at = picked.get(face as OccSubShape)
    surfaces.set(
      face as OccSubShape,
      at === undefined
        ? (originals.get(face as OccSubShape) as TweakSurface)
        : movedTweakSurface(oc, scope, face, movedSurface(oc, scope, face, effective[at]), effective[at]),
    )
  }
  // A picked face whose neighbour ends at a vertex before the moved surface
  // (a cap moved past a cone's apex) would let the neighbour close before the
  // face arrives; the tweak cannot express the vanish, so refuse and let the
  // compatibility route handle it.
  for (const face of inc.faces) {
    if (!picked.has(face as OccSubShape)) continue
    const plane = (originals.get(face as OccSubShape) as TweakSurface).plane
    if (plane === null) continue
    const d = effective[picked.get(face as OccSubShape) as number]
    if (d <= 0) continue
    const own = new Set<OccShape>()
    for (const v of inc.verticesOfFace(face)) own.add(v)
    for (const edge of inc.edgesOfFace.get(face as OccSubShape) ?? []) {
      for (const neighbour of inc.facesOfEdge.get(edge as OccSubShape) ?? []) {
        if ((neighbour as OccSubShape).IsSame(face as OccSubShape)) continue
        // A cone neighbour's surface ends at its apex even when the trimmed
        // face stops earlier; a move past the apex would build the mirrored
        // nappe, so the face must vanish instead.
        const apex = coneApexOf(oc, scope, neighbour)
        if (apex !== null) {
          const s = dot(sub(apex, plane.point), plane.normal)
          if (s > 1e-6 && s < d - 1e-9) {
            throw new MoveFaceRefusal(
              'move_face: the move passes a neighbour cone\'s apex; the moved face would vanish',
            )
          }
        }
        for (const vertex of inc.verticesOfFace(neighbour)) {
          if ([...own].some((o) => (o as OccSubShape).IsSame(vertex as OccSubShape))) continue
          const p = vertexPoint(oc, vertex)
          const s = dot(sub(p, plane.point), plane.normal)
          if (s > 1e-6 && s < d - 1e-9) {
            throw new MoveFaceRefusal(
              'move_face: a neighbour ends before the moved surface; the moved face would vanish',
            )
          }
        }
      }
    }
  }

  // A moved face whose same-surface sibling stays behind leaves a step that
  // needs a NEW face between them. The direct tweak keeps every UUID and mints
  // none, so it refuses this by name instead of shipping an open shell; the
  // step is a backlog item (it would have to mint a face the old slab route
  // named `|extend|`).
  for (const face of inc.faces) {
    if (!picked.has(face as OccSubShape)) continue
    for (const edge of inc.edgesOfFace.get(face as OccSubShape) ?? []) {
      for (const other of inc.facesOfEdge.get(edge as OccSubShape) ?? []) {
        if ((other as OccSubShape).IsSame(face as OccSubShape)) continue
        if (picked.has(other as OccSubShape)) continue
        if (!sameAnalyticSurface(oc, scope, face, other)) continue
        throw new MoveFaceRefusal(
          'move_face: a picked face shares its own surface with a face that stays behind; ' +
          'the step between them needs a new face, which the direct tweak does not mint',
        )
      }
    }
  }
  const surfaceOf = (face: OccShape): TweakSurface => surfaces.get(face as OccSubShape) as TweakSurface
  const isPicked = (face: OccShape): boolean => picked.get(face as OccSubShape) !== undefined
  // A closed picked face (a full sphere or torus) has no boundary edges to
  // re-intersect: its seam and degenerate edges stay the primitive's own.
  const closedPicked = new IdentityMap<true>()
  for (const face of inc.faces) {
    if (!isPicked(face)) continue
    const boundary = (inc.edgesOfFace.get(face as OccSubShape) ?? []).filter((e) =>
      !oc.BRep_Tool.Degenerated?.(e) && !oc.BRep_Tool.IsClosed_2(e, face))
    if (boundary.length === 0) closedPicked.set(face as OccSubShape, true)
  }

  // Section cache: one split per unordered surface-face pair.
  const sectionPairs = new Map<string, SectionCurve[]>()
  const sectionOf = (a: OccShape, b: OccShape): SectionCurve[] => {
    const keyA = sectionKey(a, b)
    const cached = sectionPairs.get(keyA)
    if (cached !== undefined) return cached
    const curves = sectionCurves(
      oc,
      scope,
      surfaceOf(a).large(L),
      surfaceOf(b).large(L),
    )
    sectionPairs.set(keyA, curves)
    return curves
  }

  // Vertices first: a moved vertex is the intersection of its incident surfaces.
  const newVertex = new IdentityMap<Vec3>()
  for (const vertex of inc.vertices) {
    const faces = inc.facesOfVertex.get(vertex as OccSubShape) ?? []
    if (!faces.some(isPicked)) continue
    const oldPoint = vertexPoint(oc, vertex)
    const planes = faces.map((f) => surfaceOf(f).plane).filter((p): p is Plane => p !== null)
    if (planes.length === faces.length && planes.length === 3) {
      const solved = intersectThreePlanes(planes[0], planes[1], planes[2])
      if (solved !== null) {
        newVertex.set(vertex as OccSubShape, solved)
        continue
      }
    }
    const distinct: OccShape[] = []
    for (const f of faces) if (!distinct.some((d) => (d as OccSubShape).IsSame(f as OccSubShape))) distinct.push(f)
    const curves: SectionCurve[] = []
    for (let i = 0; i < distinct.length; i++) {
      for (let j = i + 1; j < distinct.length; j++) curves.push(...sectionOf(distinct[i], distinct[j]))
    }
    if (curves.length === 0) continue
    if (curves.length === 1) {
      const p = closestPointOn(oc, scope, oldPoint, curves[0].edge)
      if (p !== null) newVertex.set(vertex as OccSubShape, p)
      continue
    }
    // Two curves meet at the vertex: the pair with the smallest mutual
    // distance, midpointed so a hairline gap does not bias either side.
    let best: { a: Vec3; b: Vec3; d: number } | null = null
    for (let i = 0; i < curves.length; i++) {
      for (let j = i + 1; j < curves.length; j++) {
        const extrema = scope.track(new oc.BRepExtrema_DistShapeShape_3(
          curves[i].edge,
          curves[j].edge,
          1e-7,
          oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN,
          oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad,
          noProgress(oc),
        ))
        if (!extrema.IsDone()) continue
        const a = extrema.PointOnShape1(1)
        const b = extrema.PointOnShape2(1)
        const d = extrema.Value()
        if (best === null || d < best.d) best = { a: [a.X(), a.Y(), a.Z()], b: [b.X(), b.Y(), b.Z()], d }
      }
    }
    if (best !== null && best.d <= 1e-4) {
      newVertex.set(vertex as OccSubShape, scale(add(best.a, best.b), 0.5))
    } else {
      const p = closestPointOn(oc, scope, oldPoint, curves[0].edge)
      if (p !== null) newVertex.set(vertex as OccSubShape, p)
    }
  }

  // Canonical vertex shapes: an edge built from a curve creates its own end
  // vertices, so every new edge is welded to the one vertex object per moved
  // vertex below. Vertices that collapse to one point (the wedge's tip at the
  // meeting line) share one object too, or their incident edges would meet
  // geometrically but not topologically and the shell would be open.
  const vertexShape = new IdentityMap<OccShape>()
  const clusters: { point: Vec3; shape: OccShape }[] = []
  const clusterTol = 1e-7 * L
  for (const vertex of inc.vertices) {
    const moved = newVertex.get(vertex as OccSubShape)
    if (moved === undefined) {
      vertexShape.set(vertex as OccSubShape, vertex)
      continue
    }
    const hit = clusters.find((c) => Math.hypot(
      c.point[0] - moved[0], c.point[1] - moved[1], c.point[2] - moved[2],
    ) <= clusterTol)
    if (hit !== undefined) {
      newVertex.set(vertex as OccSubShape, hit.point)
      vertexShape.set(vertex as OccSubShape, hit.shape)
      continue
    }
    const maker = scope.track(new oc.BRepBuilderAPI_MakeVertex(
      scope.track(new oc.gp_Pnt_3(moved[0], moved[1], moved[2])),
    ))
    const shape = scope.track(maker.Vertex())
    clusters.push({ point: moved, shape })
    vertexShape.set(vertex as OccSubShape, shape)
  }

  // Edges: a changed edge gets the section curve nearest its old one; an edge
  // between two coincident surfaces keeps its own curve (the cleanup merge).
  const edgePlans = new IdentityMap<EdgePlan>()
  for (const edge of inc.edges) {
    const faces = inc.facesOfEdge.get(edge as OccSubShape) ?? []
    if (faces.length === 1 && closedPicked.has(faces[0] as OccSubShape)) continue
    const movedVertex = (inc.verticesOfEdge.get(edge as OccSubShape) ?? []).some((v) => newVertex.has(v as OccSubShape))
    if (!faces.some(isPicked) && !movedVertex) continue
    if (oc.BRep_Tool.Degenerated?.(edge)) continue
    const closed = (inc.verticesOfEdge.get(edge as OccSubShape) ?? []).length <= 1
    const oldMid = edgeMidpoint(oc, scope, edge)
    const oldTangent = edgeTangent(oc, scope, edge)
    let curves: SectionCurve[]
    if (faces.length <= 1) {
      // A seam: the moved surface's own seam plane.
      const seam = seamPlane(oc, scope, faces[0])
      curves = sectionCurves(oc, scope, surfaceOf(faces[0]).large(L), seam)
    } else if (sameSurface(oc, scope, surfaceOf(faces[0]), surfaceOf(faces[1]))) {
      // Two faces on one surface (split siblings, or a face landing on a
      // neighbour's surface). The intersection is the whole surface, so the
      // edge is mapped onto the moved surface point by point; the cleanup then
      // folds the coincident faces if they are the same domain.
      const owner = faces.find((f) => isPicked(f))
      if (owner === undefined) continue
      const d = effective[picked.get(owner as OccSubShape) as number]
      const movedEdge = offsetEdge(oc, scope, edge, owner, d)
      if (movedEdge === null) continue
      edgePlans.set(edge as OccSubShape, { oldEdge: edge, newEdge: movedEdge, closed })
      continue
    } else {
      curves = sectionOf(faces[0], faces[1])
    }
    if (curves.length === 0) {
      throw new MoveFaceRefusal(
        'move_face: the moved surface has no intersection branch near the picked face edge; ' +
        'refused rather than shipping a changed face with a stale boundary',
      )
    }
    const index = chooseBranch(
      curves.map((c) => c.mid),
      curves.map((c) => c.tangent),
      oldMid,
      oldTangent,
      1e-3 * L,
    )
    if (index < 0) continue
    const chosen = curves[index]
    const newEdge = buildTrimmedEdge(oc, scope, edge, chosen, inc, newVertex, vertexShape, closed)
    edgePlans.set(edge as OccSubShape, { oldEdge: edge, newEdge, closed })
  }

  // Two old edges can meet at the same new vertex pair (the wedge's top and
  // bottom tip edges both collapse onto the sharp edge). They must become ONE
  // edge object or the two neighbour faces do not share it and the shell is
  // open. The identity key is the curve kind plus its endpoints and midpoint.
  const canonicalEdge = new Map<string, OccShape>()
  for (const [, plan] of edgePlans.entries()) {
    if (plan.newEdge === null) continue
    const key = edgeIdentity(oc, scope, plan.newEdge)
    const hit = canonicalEdge.get(key)
    if (hit !== undefined) plan.newEdge = hit
    else canonicalEdge.set(key, plan.newEdge)
  }

  // A picked face none of whose edges could be re-intersected has neighbours
  // that do not reach the moved surface (a cap moved past a cone's apex). The
  // face vanishes; the slab route is the compatibility fallback for that case.
  for (const face of inc.faces) {
    if (!picked.has(face as OccSubShape)) continue
    if (closedPicked.has(face as OccSubShape)) continue
    const faceEdges = inc.edgesOfFace.get(face as OccSubShape) ?? []
    if (faceEdges.length === 0) continue
    if (faceEdges.some((e) => edgePlans.get(e as OccSubShape) !== undefined)) continue
    throw new MoveFaceRefusal(
      'move_face: the moved face\'s neighbours do not reach its new surface; the face would vanish',
    )
  }

  // Faces: rebuild every face with a changed edge, reuse the rest.
  const newFaces: OccShape[] = []
  const faceOrigin: TweakOrigin[] = []
  const modified = new Set<OccShape>()
  for (const face of inc.faces) {
    const faceEdges = inc.edgesOfFace.get(face as OccSubShape) ?? []
    const changed = faceEdges.some((e) => edgePlans.get(e as OccSubShape) !== undefined)
    const pickedFace = isPicked(face)
    if (!changed && !pickedFace) {
      newFaces.push(face)
      faceOrigin.push({ output: face as OccSubShape, source: face as OccSubShape, fromTool: false })
      continue
    }
    const hasCollapse = faceEdges.some((e) => {
      const plan = edgePlans.get(e as OccSubShape)
      return plan !== undefined && plan.newEdge === null
    })
    const rebuilt = pickedFace && (faceEdges.length === 0 || closedPicked.has(face as OccSubShape))
      ? orientedLargeFace(oc, scope, face, surfaceOf(face).large(L))
      : pickedFace || hasCollapse
        ? rebuildFace(oc, scope, face, surfaceOf(face), edgePlans, L)
        : reshapeFace(oc, scope, face, edgePlans)
    // A face whose wire collapsed with its edge (the wedge tip at the meeting
    // point) vanishes: the pick's UUID dies and the neighbours already meet.
    if (rebuilt === null) {
      modified.add(face)
      continue
    }
    newFaces.push(rebuilt)
    faceOrigin.push({ output: rebuilt as OccSubShape, source: face as OccSubShape, fromTool: false })
    if (changed || pickedFace) modified.add(face)
  }

  const shape = assembleSolid(oc, scope, newFaces)
  // Orient the hand-built shell before it leaves the tweak: an inward cut runs
  // on this shape, and a shell without the closed flag reads as zero material.
  const repaired = repairSolid(oc, scope, shape, faceOrigin)
  return { shape: repaired.shape, faceOrigin: repaired.faceOrigin, modified }
}

/** A full primitive face takes the replaced face's orientation: a sphere or
 *  torus solid's single face is REVERSED, and its replacement must be too. */
function orientedLargeFace(
  oc: OccModule,
  scope: DisposeScope,
  oldFace: OccShape,
  large: OccShape,
): OccShape {
  const orientation = (oldFace as OccShape & { Orientation_1?: () => { value: number } }).Orientation_1?.().value
  if (orientation === oc.TopAbs_Orientation.TopAbs_REVERSED.value) {
    return scope.track(oc.TopoDS.Face_1(scope.track((large as OccShape & { Reversed(): OccShape }).Reversed())))
  }
  return large
}

/** Curve kind + rounded endpoints and midpoint: two new edges with the same
 *  identity are the same geometric edge and must share one object. */
function edgeIdentity(oc: OccModule, scope: DisposeScope, edge: OccShape): string {
  const adaptor = scope.track(new oc.BRepAdaptor_Curve_2(edge))
  const r = (v: number): number => Math.round(v * 1e6) / 1e6
  const fmt = (p: Vec3): string => p.map(r).join(',')
  const a = pointAt(adaptor, adaptor.FirstParameter())
  const b = pointAt(adaptor, adaptor.LastParameter())
  const m = pointAt(adaptor, (adaptor.FirstParameter() + adaptor.LastParameter()) / 2)
  const kind = adaptor.GetType().value
  return `${kind}|${fmt(a)}|${fmt(b)}|${fmt(m)}`
}

/** Order edges into one chain by their curve endpoints. The old wire's
 *  explorer order is not reliable on every body (a placed extrude's rectangular
 *  side face came back with its two pairs interleaved), and a wire built from
 *  an interleaved list does not close. */
function orderChain(oc: OccModule, scope: DisposeScope, edges: OccShape[], tol: number): OccShape[] {
  // A degenerate (apex/pole) edge has coincident endpoints, so a chain search
  // is ambiguous there; the explorer order of a cone's lateral wire is the
  // correct one, so keep it.
  if (edges.some((e) => oc.BRep_Tool.Degenerated?.(e))) return edges
  const ends = edges.map((edge) => {
    const adaptor = scope.track(new oc.BRepAdaptor_Curve_2(edge))
    return { a: pointAt(adaptor, adaptor.FirstParameter()), b: pointAt(adaptor, adaptor.LastParameter()) }
  })
  const near = (p: Vec3, q: Vec3): boolean =>
    Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= tol
  const used = new Set<number>()
  const out: OccShape[] = []
  let current = ends[0].a
  while (out.length < edges.length) {
    let found = -1
    let flip = false
    for (let i = 0; i < edges.length; i++) {
      if (used.has(i)) continue
      if (near(ends[i].a, current)) { found = i; flip = false; break }
      if (near(ends[i].b, current)) { found = i; flip = true; break }
    }
    if (found < 0) return edges
    used.add(found)
    out.push(flip
      ? scope.track(oc.TopoDS.Edge_1(scope.track((edges[found] as OccShape & { Reversed(): OccShape }).Reversed())))
      : edges[found])
    current = flip ? ends[found].a : ends[found].b
  }
  return out
}

/** A new edge on the moved surface from an edge that lies on it, for the
 *  coincident-surface case where there is no intersection curve. Only the
 *  straight and circular cases are supported; a refused edge keeps the old
 *  plan and the feature refuses by the surface kind it cannot map. */
function offsetEdge(
  oc: OccModule,
  scope: DisposeScope,
  edge: OccShape,
  owner: OccShape,
  d: number,
): OccShape | null {
  const adaptor = scope.track(new oc.BRepAdaptor_Curve_2(edge))
  const C = oc.GeomAbs_CurveType
  const t = adaptor.GetType().value
  if (t === C.GeomAbs_Line.value) {
    const a = movedPoint(oc, scope, owner, d, pointAt(adaptor, adaptor.FirstParameter()))
    const b = movedPoint(oc, scope, owner, d, pointAt(adaptor, adaptor.LastParameter()))
    return scope.track(scope.track(new oc.BRepBuilderAPI_MakeEdge_3(
      scope.track(new oc.gp_Pnt_3(a[0], a[1], a[2])),
      scope.track(new oc.gp_Pnt_3(b[0], b[1], b[2])),
    )).Edge())
  }
  if (t === C.GeomAbs_Circle.value) {
    const circ = scope.track(adaptor.Circle())
    const c = circ.Location()
    const axis = circ.Axis().Direction()
    const xaxis = circ.XAxis().Direction()
    const center = movedPoint(oc, scope, owner, d, [c.X(), c.Y(), c.Z()])
    const radius = circ.Radius() + movedRadiusDelta(oc, scope, owner, d)
    const out = makeCircleEdge(
      oc,
      scope,
      center,
      [axis.X(), axis.Y(), axis.Z()],
      [xaxis.X(), xaxis.Y(), xaxis.Z()],
      Math.abs(radius),
    )
    axis.delete()
    xaxis.delete()
    c.delete()
    return scope.track(out)
  }
  return null
}

/** The radius change a normal move `d` makes on `face`'s surface: the target
 *  primitive's radius minus the source's. */
function movedRadiusDelta(oc: OccModule, scope: DisposeScope, face: OccShape, d: number): number {
  const source = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const target = scope.track(new oc.BRepAdaptor_Surface_2(movedSurface(oc, scope, face, d).targetFace(1), true))
  const S = oc.GeomAbs_SurfaceType
  const t = source.GetType().value
  if (t === S.GeomAbs_Cylinder.value) {
    return scope.track(target.Cylinder()).Radius() - scope.track(source.Cylinder()).Radius()
  }
  if (t === S.GeomAbs_Sphere.value) {
    return scope.track(target.Sphere()).Radius() - scope.track(source.Sphere()).Radius()
  }
  return 0
}

/** The image of a point on `face`'s surface after the normal move `d`. */
function movedPoint(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  d: number,
  p: Vec3,
): Vec3 {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const S = oc.GeomAbs_SurfaceType
  const t = adaptor.GetType().value
  if (t === S.GeomAbs_Plane.value) return add(p, scale(faceNormal(oc, scope, face), d))
  if (t === S.GeomAbs_Cylinder.value) {
    const cyl = scope.track(adaptor.Cylinder())
    const dir = takeAxis(cyl.Axis())
    const pos = scope.track(cyl.Position())
    const loc = pos.Location()
    const origin: Vec3 = [loc.X(), loc.Y(), loc.Z()]
    loc.delete()
    const rel = sub(p, origin)
    const axial = scale(dir, dot(rel, dir))
    const radial = sub(rel, axial)
    const len = Math.hypot(radial[0], radial[1], radial[2])
    if (len <= 0) return p
    const delta = movedRadiusDelta(oc, scope, face, d)
    return add(p, scale(radial, delta / len))
  }
  if (t === S.GeomAbs_Sphere.value) {
    const sph = scope.track(adaptor.Sphere())
    const pos = scope.track(sph.Position())
    const loc = pos.Location()
    const centre: Vec3 = [loc.X(), loc.Y(), loc.Z()]
    loc.delete()
    const rel = sub(p, centre)
    const len = Math.hypot(rel[0], rel[1], rel[2])
    if (len <= 0) return p
    return add(p, scale(rel, movedRadiusDelta(oc, scope, face, d) / len))
  }
  return p
}

function takeAxis(axis: { Direction(): { X(): number; Y(): number; Z(): number; delete(): void }; delete(): void }): Vec3 {
  const dir = axis.Direction()
  const out: Vec3 = [dir.X(), dir.Y(), dir.Z()]
  dir.delete()
  axis.delete()
  return out
}

/** The apex of a cone face's surface, or null for any other kind. */
function coneApexOf(oc: OccModule, scope: DisposeScope, face: OccShape): Vec3 | null {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  if (adaptor.GetType().value !== oc.GeomAbs_SurfaceType.GeomAbs_Cone.value) return null
  const cone = scope.track(adaptor.Cone())
  const semi = cone.SemiAngle()
  const ref = cone.RefRadius()
  const pos = scope.track(cone.Position())
  const loc = pos.Location()
  const origin: Vec3 = [loc.X(), loc.Y(), loc.Z()]
  const z = pos.Direction()
  const axis: Vec3 = [z.X(), z.Y(), z.Z()]
  loc.delete()
  z.delete()
  return add(origin, scale(axis, -ref / Math.tan(semi)))
}

/** A stable key for the unordered pair of faces, by canonical index. */
const faceIndexKey = new WeakMap<object, number>()
let nextFaceKey = 1
function sectionKey(a: OccShape, b: OccShape): string {
  const key = (f: OccShape): number => {
    const existing = faceIndexKey.get(f as object)
    if (existing !== undefined) return existing
    const set = nextFaceKey++
    faceIndexKey.set(f as object, set)
    return set
  }
  const ka = key(a)
  const kb = key(b)
  return ka < kb ? `${ka}:${kb}` : `${kb}:${ka}`
}

/** `sameAnalyticSurface` on the two large faces: comparing the ORIGINAL faces
 *  would miss a moved cylinder that landed on a neighbour's radius. */
function sameSurface(oc: OccModule, scope: DisposeScope, a: TweakSurface, b: TweakSurface): boolean {
  return sameAnalyticSurface(oc, scope, a.large(1), b.large(1))
}

/** The seam's own plane: through the axis, spanned by the surface's Z and X. */
function seamPlane(oc: OccModule, scope: DisposeScope, face: OccShape): OccShape {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const S = oc.GeomAbs_SurfaceType
  const t = adaptor.GetType().value
  let pos: OccAx3
  if (t === S.GeomAbs_Cylinder.value) pos = scope.track(scope.track(adaptor.Cylinder()).Position())
  else if (t === S.GeomAbs_Cone.value) pos = scope.track(scope.track(adaptor.Cone()).Position())
  else if (t === S.GeomAbs_Sphere.value) pos = scope.track(scope.track(adaptor.Sphere()).Position())
  else pos = scope.track(scope.track(adaptor.Torus()).Position())
  const loc = pos.Location()
  const origin: Vec3 = [loc.X(), loc.Y(), loc.Z()]
  const y = pos.YDirection()
  const normal = unit([y.X(), y.Y(), y.Z()]) ?? [0, 1, 0]
  loc.delete()
  y.delete()
  return planeFace(oc, scope, origin, normal, 4 * 1e3)
}

function planeFace(oc: OccModule, scope: DisposeScope, origin: Vec3, normal: Vec3, L: number): OccShape {
  const n = unit(normal) ?? [0, 0, 1]
  const x = perpendicular(n)
  const frame = scope.track(new oc.gp_Ax3_3(
    scope.track(new oc.gp_Pnt_3(origin[0], origin[1], origin[2])),
    scope.track(new oc.gp_Dir_5(n[0], n[1], n[2])),
    scope.track(new oc.gp_Dir_5(x[0], x[1], x[2])),
  ))
  const plane = scope.track(new oc.gp_Pln_2(frame))
  return scope.track(new oc.BRepBuilderAPI_MakeFace_9(plane, -L, L, -L, L).Face())
}

function perpendicular(n: Vec3): Vec3 {
  const axis: Vec3 = Math.abs(n[2]) >= 0.9 ? [1, 0, 0] : [0, 0, 1]
  const x = cross(n, axis)
  return unit(x) ?? [1, 0, 0]
}

function vertexPoint(oc: OccModule, vertex: OccShape): Vec3 {
  const p = oc.BRep_Tool.Pnt(vertex)
  const out: Vec3 = [p.X(), p.Y(), p.Z()]
  p.delete()
  return out
}

function edgeMidpoint(oc: OccModule, scope: DisposeScope, edge: OccShape): Vec3 {
  const adaptor = scope.track(new oc.BRepAdaptor_Curve_2(edge))
  return pointAt(adaptor, (adaptor.FirstParameter() + adaptor.LastParameter()) / 2)
}

function edgeTangent(oc: OccModule, scope: DisposeScope, edge: OccShape): Vec3 | null {
  const adaptor = scope.track(new oc.BRepAdaptor_Curve_2(edge))
  const u = (adaptor.FirstParameter() + adaptor.LastParameter()) / 2
  const h = Math.abs(adaptor.LastParameter() - adaptor.FirstParameter()) * 1e-4 + 1e-9
  const before = pointAt(adaptor, u - h)
  const after = pointAt(adaptor, u + h)
  return unit(sub(after, before))
}

/**
 * Build the changed edge from the chosen section curve, trimmed between the
 * edge's (possibly moved) vertices. Full circles stay full circles; arcs keep
 * the branch through the old midpoint; anything else is a dense polyline edge
 * on the section, which the freeform neighbour case needs.
 */
function buildTrimmedEdge(
  oc: OccModule,
  scope: DisposeScope,
  oldEdge: OccShape,
  curve: SectionCurve,
  inc: Incidence,
  newVertex: IdentityMap<Vec3>,
  vertexShape: IdentityMap<OccShape>,
  closed: boolean,
): OccShape | null {
  const adaptor = scope.track(new oc.BRepAdaptor_Curve_2(curve.edge))
  const C = oc.GeomAbs_CurveType
  const t = adaptor.GetType().value
  const vertices = inc.verticesOfEdge.get(oldEdge as OccSubShape) ?? []
  const canonical = vertices.map((v) => vertexShape.get(v as OccSubShape) as OccShape)
  const points = vertices.map((v) => newVertex.get(v as OccSubShape) ?? vertexPoint(oc, v))
  if (!closed && points.length >= 2) {
    const span = Math.hypot(points[0][0] - points[1][0], points[0][1] - points[1][1], points[0][2] - points[1][2])
    const scaleRef = Math.max(1, ...points[0].map(Math.abs), ...points[1].map(Math.abs))
    if (span <= 1e-9 * scaleRef) return null
  }
  const weld = (edge: OccShape): OccShape => weldEdgeVertices(oc, scope, edge, canonical)
  if (closed || points.length < 2) {
    if (t === C.GeomAbs_Circle.value) {
      const circ = scope.track(adaptor.Circle())
      const c = circ.Location()
      const axis = circ.Axis().Direction()
      const xaxis = circ.XAxis().Direction()
      const out = makeCircleEdge(
        oc,
        scope,
        [c.X(), c.Y(), c.Z()],
        [axis.X(), axis.Y(), axis.Z()],
        [xaxis.X(), xaxis.Y(), xaxis.Z()],
        circ.Radius(),
      )
      axis.delete()
      xaxis.delete()
      c.delete()
      return scope.track(weld(out))
    }
    // A closed non-circle seam (a sphere meridian) falls through to the
    // sampled edge below.
  }
  if (t === C.GeomAbs_Line.value) {
    const maker = scope.track(new oc.BRepBuilderAPI_MakeEdge_2(canonical[0], canonical[1]))
    return scope.track(maker.Edge())
  }
  if (t === C.GeomAbs_Circle.value) {
    const circ = scope.track(adaptor.Circle())
    const c = circ.Location()
    const axisDir = circ.Axis().Direction()
    const xdir = circ.XAxis().Direction()
    const center: Vec3 = [c.X(), c.Y(), c.Z()]
    const normal: Vec3 = [axisDir.X(), axisDir.Y(), axisDir.Z()]
    const xAxis: Vec3 = [xdir.X(), xdir.Y(), xdir.Z()]
    const radius = circ.Radius()
    const angleOf = (p: Vec3): number => {
      const rel = sub(p, center)
      const x = dot(rel, xAxis)
      const y = dot(rel, cross(normal, xAxis))
      return Math.atan2(y, x)
    }
    let a0 = angleOf(points[0])
    let a1 = angleOf(points[1])
    if (a1 <= a0) a1 += 2 * Math.PI
    // Pick the sweep that contains the old midpoint; the other arc is the rest
    // of the circle.
    const oldMid = edgeMidpoint(oc, scope, oldEdge)
    const midAngle = angleOf(oldMid)
    const inRange = (a: number): boolean => {
      const m = ((midAngle - a) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
      return m <= a1 - a0
    }
    if (!inRange(a0)) {
      const tmp = a0
      a0 = a1
      a1 = tmp + 2 * Math.PI
    }
    axisDir.delete()
    xdir.delete()
    c.delete()
    return scope.track(weld(scope.track(makeArcEdge(oc, scope, center, normal, xAxis, radius, a0, a1))))
  }
  // Freeform: sample the section between the parameters nearest the vertices
  // and fit a degree-1 B-spline, which is an exact polyline.
  const pa = nearestParameter(adaptor, points[0])
  const pb = nearestParameter(adaptor, points[1])
  const lo = Math.min(pa, pb)
  const hi = Math.max(pa, pb)
  const N = 24
  const poles: Vec3[] = []
  for (let i = 0; i <= N; i++) poles.push(pointAt(adaptor, lo + ((hi - lo) * i) / N))
  return scope.track(weld(scope.track(polylineEdge(oc, scope, poles))))
}

/** Replace an edge's end vertices with the canonical vertex objects of the
 *  tweak. `explore` order is the edge's own start-then-end order. */
function weldEdgeVertices(
  oc: OccModule,
  scope: DisposeScope,
  edge: OccShape,
  canonical: OccShape[],
): OccShape {
  if (canonical.length === 0) return edge
  const shape = scope.track(new oc.BRepTools_ReShape())
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(edge, E.TopAbs_VERTEX, E.TopAbs_SHAPE))
  const seen = new Set<string>()
  const verts: OccShape[] = []
  for (; exp.More(); exp.Next()) {
    const v = scope.track(oc.TopoDS.Vertex_1(scope.track(exp.Current())))
    const key = String((v as unknown as { HashCode?: (u: number) => number }).HashCode?.(1) ?? 0)
    if (seen.has(key)) continue
    seen.add(key)
    verts.push(v)
  }
  let replaced = false
  verts.forEach((v, i) => {
    const want = canonical[Math.min(i, canonical.length - 1)]
    if ((v as OccSubShape).IsSame(want as OccSubShape)) return
    shape.Replace(v, want)
    replaced = true
  })
  if (!replaced) return edge
  return scope.track(oc.TopoDS.Edge_1(scope.track(shape.Apply(edge, E.TopAbs_VERTEX))))
}

function nearestParameter(adaptor: { FirstParameter(): number; LastParameter(): number; Value(u: number): { X(): number; Y(): number; Z(): number; delete(): void } }, target: Vec3): number {
  let best = adaptor.FirstParameter()
  let bestD = Infinity
  const N = 64
  for (let i = 0; i <= N; i++) {
    const u = adaptor.FirstParameter() + ((adaptor.LastParameter() - adaptor.FirstParameter()) * i) / N
    const p = pointAt(adaptor, u)
    const d = (p[0] - target[0]) ** 2 + (p[1] - target[1]) ** 2 + (p[2] - target[2]) ** 2
    if (d < bestD) { bestD = d; best = u }
  }
  return best
}

/** A degree-1 B-spline through `points`: exactly the polyline. */
function polylineEdge(oc: OccModule, scope: DisposeScope, points: Vec3[]): OccShape {
  const poles = scope.track(new oc.TColgp_Array1OfPnt_2(1, points.length))
  points.forEach((p, i) => poles.SetValue(i + 1, scope.track(new oc.gp_Pnt_3(p[0], p[1], p[2]))))
  const knots = scope.track(new oc.TColStd_Array1OfReal_2(1, points.length))
  const mult = scope.track(new oc.TColStd_Array1OfInteger_2(1, points.length))
  points.forEach((_, i) => {
    knots.SetValue(i + 1, i)
    mult.SetValue(i + 1, i === 0 || i === points.length - 1 ? 2 : 1)
  })
  const curve = new oc.Geom_BSplineCurve_1(poles, knots, mult, 1, false)
  const handle = scope.track(new oc.Handle_Geom_Curve_2(curve))
  return scope.track(new oc.BRepBuilderAPI_MakeEdge_24(handle).Edge())
}

/** Rebuild `face` on `surface` from its wires, substituting the changed edges. */
function rebuildFace(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  target: TweakSurface,
  edgePlans: IdentityMap<EdgePlan>,
  L: number,
): OccShape | null {
  const outer = scope.track(oc.BRepTools.OuterWire(face))
  const wires: OccShape[] = []
  const S = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(face, S.TopAbs_WIRE, S.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) wires.push(scope.track(oc.TopoDS.Wire_1(scope.track(exp.Current()))))
  const ordered = wires.filter((w) => (w as OccSubShape).IsSame(outer)).concat(
    wires.filter((w) => !(w as OccSubShape).IsSame(outer)),
  )
  const made: OccShape[] = []
  const madeEdges: OccShape[][] = []
  for (const wire of ordered) {
    const edges: OccShape[] = []
    const eexp = scope.track(new oc.TopExp_Explorer_2(wire, S.TopAbs_EDGE, S.TopAbs_SHAPE))
    for (; eexp.More(); eexp.Next()) {
      const oriented = scope.track(oc.TopoDS.Edge_1(eexp.Current())) as OccShape & { Orientation_1?: () => { value: number } }
      const plan = edgePlans.get(oriented as OccSubShape)
      if (plan !== undefined && plan.newEdge === null) continue  // collapsed edge
      if (plan?.newEdge != null) {
        const reversed = oriented.Orientation_1?.().value === oc.TopAbs_Orientation.TopAbs_REVERSED.value
        edges.push(reversed
          ? scope.track(oc.TopoDS.Edge_1(scope.track((plan.newEdge as OccShape & { Reversed(): OccShape }).Reversed())))
          : scope.track(oc.TopoDS.Edge_1(plan.newEdge)))
      } else {
        edges.push(oriented)
      }
    }
    if (edges.length === 0) return null
    const orderedEdges = orderChain(oc, scope, edges, 1e-6 * L)
    const wireMaker = scope.track(new oc.BRepBuilderAPI_MakeWire_1())
    for (const edge of orderedEdges) wireMaker.Add_1(edge)
    const closedWire = scope.track(wireMaker.Wire())
    made.push(closedWire)
    madeEdges.push(orderedEdges)
  }
  const sample = target.large(1)
  const sampleAdaptor = scope.track(new oc.BRepAdaptor_Surface_2(sample, true))
  const G = oc.GeomAbs_SurfaceType
  const sampleKind = sampleAdaptor.GetType().value
  // The kind-specific makers are the ones the curved move-face regions already
  // use; the generic surface one leaves the whole surface bounds and is the
  // last resort for a freeform neighbour.
  const maker = target.kind === 'plane'
    ? scope.track(new oc.BRepBuilderAPI_MakeFace_15(made[0], true))
    : sampleKind === G.GeomAbs_Cylinder.value
      ? scope.track(new oc.BRepBuilderAPI_MakeFace_17(scope.track(sampleAdaptor.Cylinder()), made[0], true))
      : sampleKind === G.GeomAbs_Cone.value
        ? scope.track(new oc.BRepBuilderAPI_MakeFace_18(scope.track(sampleAdaptor.Cone()), made[0], true))
        : sampleKind === G.GeomAbs_Sphere.value
          ? scope.track(new oc.BRepBuilderAPI_MakeFace_19(scope.track(sampleAdaptor.Sphere()), made[0], true))
          : sampleKind === G.GeomAbs_Torus.value
            ? scope.track(new oc.BRepBuilderAPI_MakeFace_20(scope.track(sampleAdaptor.Torus()), made[0], true))
            : scope.track(new oc.BRepBuilderAPI_MakeFace_21(target.surface(), made[0], true))
  if (!maker.IsDone()) throw new MoveFaceRefusal('move_face: a rebuilt face did not bound on its surface')
  for (let i = 1; i < made.length; i++) maker.Add(made[i])
  let built = scope.track(maker.Face())
  // MakeFace copies the wire to write its own pcurves; replace the copies with
  // the one shared edge per edge so the faces form a connected shell. ShapeFix
  // then writes the pcurve on that shared edge for this face's surface (an
  // edge carries one pcurve per surface), which is how a boolean result's shell
  // stays closed without a sewing pass.
  const reshape = scope.track(new oc.BRepTools_ReShape())
  let replaced = false
  const bexp = scope.track(new oc.TopExp_Explorer_2(built, S.TopAbs_WIRE, S.TopAbs_SHAPE))
  let w = 0
  for (; bexp.More() && w < madeEdges.length; bexp.Next(), w++) {
    const builtWire = scope.track(oc.TopoDS.Wire_1(scope.track(bexp.Current())))
    const edges: OccShape[] = []
    const eexp = scope.track(new oc.TopExp_Explorer_2(builtWire, S.TopAbs_EDGE, S.TopAbs_SHAPE))
    for (; eexp.More(); eexp.Next()) edges.push(scope.track(oc.TopoDS.Edge_1(eexp.Current())))
    if (edges.length !== madeEdges[w].length) continue
    const wanted = madeEdges[w].map((edge) => ({ edge, mid: edgeMidpoint(oc, scope, edge) }))
    edges.forEach((edge) => {
      const mid = edgeMidpoint(oc, scope, edge)
      let best = -1
      let bestD = Infinity
      wanted.forEach((want, i) => {
        const d = Math.hypot(mid[0] - want.mid[0], mid[1] - want.mid[1], mid[2] - want.mid[2])
        if (d < bestD) { bestD = d; best = i }
      })
      if (best < 0 || bestD > 1e-6 * L) return
      const want = wanted[best].edge
      if ((edge as OccSubShape).IsSame(want as OccSubShape)) return
      reshape.Replace(edge, want)
      replaced = true
    })
  }
  if (replaced) built = scope.track(oc.TopoDS.Face_1(scope.track(reshape.Apply(built, S.TopAbs_EDGE))))
  let rebuilt = built
  const orientation = (face as OccShape & { Orientation_1?: () => { value: number } }).Orientation_1?.().value
  if (orientation === oc.TopAbs_Orientation.TopAbs_REVERSED.value) {
    rebuilt = scope.track(oc.TopoDS.Face_1(scope.track((rebuilt as OccShape & { Reversed(): OccShape }).Reversed())))
  }
  // MakeFace_21 leaves the surface's own bounds; the face fixer trims it to
  // the wire (the move-face curved regions use the same pass, and the wrap
  // builder records that the edges stay IsSame through it).
  const fixer = scope.track(new oc.ShapeFix_Face_2(rebuilt))
  fixer.FixOrientation_1()
  fixer.Perform(noProgress(oc))
  const fixedFace = scope.track(fixer.Face())
  // A face whose boundary collapsed to coincident lines (the wedge tip exactly
  // at the meeting point) has no area and vanishes.
  const area = faceArea(oc, scope, fixedFace)
  if (area <= 1e-9 * L) return null
  return fixedFace
}

/** Substitute the changed edges in an UNPICKED face, keeping its surface,
 *  wire order and pcurves: ReShape rebuilds the ancestors of the replaced
 *  edges, which is much more faithful than re-making the face from scratch
 *  (a cone's degenerate apex wire survives this way). */
function reshapeFace(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  edgePlans: IdentityMap<EdgePlan>,
): OccShape | null {
  const reshape = scope.track(new oc.BRepTools_ReShape())
  const S = oc.TopAbs_ShapeEnum
  let replaced = false
  const exp = scope.track(new oc.TopExp_Explorer_2(face, S.TopAbs_EDGE, S.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const oriented = scope.track(oc.TopoDS.Edge_1(scope.track(exp.Current()))) as OccShape & { Orientation_1?: () => { value: number } }
    const plan = edgePlans.get(oriented as OccSubShape)
    if (plan === undefined || plan.newEdge === null) continue
    const reversed = oriented.Orientation_1?.().value === oc.TopAbs_Orientation.TopAbs_REVERSED.value
    const want = reversed
      ? scope.track(oc.TopoDS.Edge_1(scope.track((plan.newEdge as OccShape & { Reversed(): OccShape }).Reversed())))
      : plan.newEdge
    if ((oriented as OccSubShape).IsSame(want as OccSubShape)) continue
    reshape.Replace(oriented, want)
    replaced = true
  }
  if (!replaced) return face
  let out = scope.track(oc.TopoDS.Face_1(scope.track(reshape.Apply(face, S.TopAbs_EDGE))))
  try {
    const fixer = scope.track(new oc.ShapeFix_Face_2(out))
    fixer.FixOrientation_1()
    fixer.Perform(noProgress(oc))
    out = scope.track(fixer.Face())
  } catch {
    // The ReShape face is the faithful one; the fixer is a pcurve repair only.
  }
  return out
}

/** Assemble the rebuilt faces into one solid. Edges are shared objects, so the
 *  shell is connected without a sewing pass. */
function assembleSolid(oc: OccModule, scope: DisposeScope, faces: OccShape[]): OccShape {
  const shell = scope.track(new oc.TopoDS_Shell())
  const builder = scope.track(new oc.BRep_Builder())
  builder.MakeShell(shell)
  for (const face of faces) builder.Add(shell, face)
  // A manual shell carries no closed flag; BRepGProp's OnlyClosed read and
  // BRepCheck_Shell both trust it. Setting it is what BRepBuilderAPI_MakeSolid
  // does after counting the free boundaries.
  const shellFlags = shell as unknown as { Closed?: (value: boolean) => void; Closed_1?: (value: boolean) => void }
  shellFlags.Closed?.(true)
  shellFlags.Closed_1?.(true)
  const solid = scope.track(new oc.TopoDS_Solid())
  builder.MakeSolid(solid)
  builder.Add(solid, shell)
  const solidFlags = solid as unknown as { Closed?: (value: boolean) => void; Closed_1?: (value: boolean) => void }
  solidFlags.Closed?.(true)
  solidFlags.Closed_1?.(true)
  return solid
}

// ─── the inward cutter ───

/**
 * Cut one inward pick with the material half-space of its moved surface. The
 * cap the cut leaves on the moved surface is the tool face the cut generated,
 * named by the leaf with the pick's UUID.
 */
function cutInward(
  oc: OccModule,
  scope: DisposeScope,
  part: OccShape,
  pick: TweakPick,
): { shape: OccShape; faceOrigin: TweakOrigin[]; toolFacePick: IdentityMap<TweakPick>; modified: Set<OccShape> } {
  const surface = movedSurface(oc, scope, pick.face, pick.distance)
  const L = 4 * (bboxDiagonal(oc, scope, part) + Math.abs(pick.distance))
  const { tool, cap } = surface.outsideSolid(part, L)
  const res = booleanWithDiff(oc, scope, part, tool, 'cut')
  const toolFacePick = new IdentityMap<TweakPick>()
  const faceOrigin: TweakOrigin[] = res.faceOrigin.map((o) => {
    if (o.fromTool) {
      if ((o.source as OccSubShape).IsSame(cap as OccSubShape)) toolFacePick.set(o.source, pick)
      return { output: o.output, source: o.source, fromTool: true }
    }
    return { output: o.output, source: o.source, fromTool: false }
  })
  // The cut's own diff names the input faces whose trim it changed; those are
  // the picked face and the swallowed neighbours, all of them part of the
  // final modified set.
  const modified = new Set<OccShape>()
  for (const f of res.diff.modified_input_faces as OccShape[]) modified.add(f)
  return { shape: res.shape, faceOrigin, toolFacePick, modified }
}

// ─── the entry point ───

/** Compose `next` (output -> input of `next`) over `current` (input -> old). */
function composeOrigin(current: TweakOrigin[], next: TweakOrigin[]): TweakOrigin[] {
  return next.map((entry) => {
    if (entry.fromTool) return entry
    const hit = current.find((c) => (c.output as OccSubShape).IsSame(entry.source as OccSubShape))
    return hit === undefined ? entry : { output: entry.output, source: hit.source, fromTool: hit.fromTool }
  })
}

/** Map an input face of a later operation back to the original face. */
function originalFaceOf(current: TweakOrigin[], face: OccShape): OccShape | null {
  const hit = current.find((c) => (c.output as OccSubShape).IsSame(face as OccSubShape))
  return hit === undefined || hit.fromTool ? null : (hit.source as OccShape)
}

/**
 * Apply every pick of one body in one operation. Positive picks are the direct
 * tweak; negative picks are boundaryless cuts applied afterwards, so a mixed
 * set is still a function of the set alone.
 */
export function applyMoveFaces(
  oc: OccModule,
  scope: DisposeScope,
  part: OccShape,
  picks: TweakPick[],
): TweakResult {
  const sorted = [...picks].sort((a, b) => comparePoint(centroidOf(oc, scope, a.face), centroidOf(oc, scope, b.face)))
  const outward = sorted.filter((p) => p.distance > 0)
  const inward = sorted.filter((p) => p.distance < 0)
  if (outward.length === 0 && inward.length === 0) {
    const identity: TweakOrigin[] = (canonicalFaces(oc, scope, part) as OccShape[]).map((f) => ({
      output: f as OccSubShape, source: f as OccSubShape, fromTool: false,
    }))
    return { shape: part, faceOrigin: identity, toolFacePick: new IdentityMap<TweakPick>(), diff: emptyBrepDiff(), changed: false }
  }

  let shape = part
  let faceOrigin: TweakOrigin[]
  const modified = new Set<OccShape>()
  let changed = false
  if (outward.length > 0) {
    const tweak = tweakOutward(oc, scope, part, outward)
    shape = tweak.shape
    faceOrigin = tweak.faceOrigin
    for (const f of tweak.modified) modified.add(f)
    changed = true
  } else {
    faceOrigin = (canonicalFaces(oc, scope, part) as OccShape[]).map((f) => ({
      output: f as OccSubShape, source: f as OccSubShape, fromTool: false,
    }))
  }

  const toolFacePick = new IdentityMap<TweakPick>()
  inward.forEach((pick) => {
    const cut = cutInward(oc, scope, shape, pick)
    const originals = cut.modified
      ? [...cut.modified].map((f) => originalFaceOf(faceOrigin, f)).filter((f): f is OccShape => f !== null)
      : []
    faceOrigin = composeOrigin(faceOrigin, cut.faceOrigin)
    for (const original of originals) modified.add(original)
    for (const [source, value] of cut.toolFacePick.entries()) toolFacePick.set(source, value)
    shape = cut.shape
    changed = true
  })

  const diff = diffFromOrigin(faceOrigin, modified)
  // The cleanup layer folds a moved face onto a coplanar neighbour (a rejected
  // pass keeps the previous shape, exactly as the boolean path does).
  const cleanup = runCleanup(oc, scope, { shape, diff, faceOrigin }, [
    { name: 'heal', pass: heal, options: { onlyIfInvalid: true }, selfGuarded: true },
    { name: 'unifySameDomain', pass: unifySameDomain, options: { unifyFaces: true }, guard: {} },
  ])
  return {
    shape: cleanup.shape,
    faceOrigin: (cleanup.faceOrigin ?? faceOrigin) as TweakOrigin[],
    toolFacePick,
    diff: cleanup.diff ?? diff,
    changed,
  }
}

/** ShapeFix_Shape over the assembled shell, with the origin carried through the
 *  fixer's substitution context. Run even on a valid shell: a hand-built shell
 *  carries no closed flag, and BRepGProp's OnlyClosed read (and the cleanup
 *  guard) needs it. A repair that changes the topology is refused. */
function repairSolid(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  faceOrigin: TweakOrigin[],
): { shape: OccShape; faceOrigin: TweakOrigin[] } {
  const validBefore = shapeIsValid(oc, scope, shape)
  const facesBefore = canonicalFaces(oc, scope, shape).length
  const edgesBefore = canonicalEdges(oc, scope, shape).length
  let fixed: OccShape
  let context: OccReShape | null = null
  // Prefer the shell repair: ShapeFix is happier reorienting a shell than a
  // solid wrapper whose closed flag is still unset.
  const shellFix = repairShell(oc, scope, shape)
  if (shellFix !== null
    && canonicalFaces(oc, scope, shellFix.shape).length === facesBefore
    && canonicalEdges(oc, scope, shellFix.shape).length === edgesBefore) {
    fixed = shellFix.shape
    context = shellFix.context
  } else {
    try {
      const fixer = scope.track(new oc.ShapeFix_Shape_2(shape))
      fixer.Perform(noProgress(oc))
      const rawFixed = scope.track(fixer.Shape())
      // ShapeFix rebuilds a repaired solid as a lone shell; promote it back, the
      // same normalisation the offset route uses.
      fixed = offsetResultSolid(oc, scope, rawFixed) ?? rawFixed
      const handle = scope.track(fixer.Context())
      context = handle.get()
    } catch (e) {
      if (validBefore) return { shape, faceOrigin }
      throw new MoveFaceRefusal(`move_face: the rebuilt shell could not be oriented: ${String(e)}`)
    }
  }
  const E = oc.TopAbs_ShapeEnum
  if (!shapeIsValid(oc, scope, fixed)) {
    // A closed face with a degenerate boundary (a cone's apex) can leave the
    // solid wrapper unoriented while the shell itself is repairable; retry on
    // the shell and re-wrap.
    const shellFix = repairShell(oc, scope, shape)
    if (shellFix !== null) {
      fixed = shellFix.shape
      context = shellFix.context
    } else if (validBefore) {
      return { shape, faceOrigin }
    } else {
      throw new MoveFaceRefusal('move_face: the rebuilt shell is not a valid solid')
    }
  }
  if (canonicalFaces(oc, scope, fixed).length !== facesBefore
    || canonicalEdges(oc, scope, fixed).length !== edgesBefore) {
    if (validBefore) return { shape, faceOrigin }
    throw new MoveFaceRefusal('move_face: orienting the rebuilt shell changed its topology')
  }
  const mapped = faceOrigin.map((entry) => ({
    output: (context ? scope.track(context.Apply(entry.output, E.TopAbs_FACE)) : entry.output) as OccSubShape,
    source: entry.source,
    fromTool: entry.fromTool,
  }))
  // A shell repair can settle on the inward orientation: the volume sign is
  // the one authority, and reversing keeps every sub-shape identity the origin
  // map is keyed by.
  if (volumeOfDefault(oc, scope, fixed) < 0) {
    fixed = scope.track(oc.TopoDS.Solid_1(scope.track((fixed as OccShape & { Reversed(): OccShape }).Reversed())))
  }
  return { shape: fixed, faceOrigin: mapped }
}

function diffFromOrigin(faceOrigin: TweakOrigin[], modified: Set<OccShape>): BrepDiff {
  const diff = emptyBrepDiff()
  const seen = new Set<OccShape>()
  for (const entry of faceOrigin) {
    if (entry.fromTool) continue
    const source = entry.source as OccShape
    if (!modified.has(source)) continue
    if (seen.has(source)) continue
    seen.add(source)
    diff.modified_input_faces.push(source)
  }
  return diff
}

/** ShapeFix the body's own shell and re-wrap it; null when that does not
 *  produce a valid solid. */
function repairShell(oc: OccModule, scope: DisposeScope, shape: OccShape): { shape: OccShape; context: OccReShape | null } | null {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_SHELL, E.TopAbs_SHAPE))
  if (!exp.More()) return null
  const shell = scope.track(oc.TopoDS.Shell_1(scope.track(exp.Current())))
  try {
    const fixer = scope.track(new oc.ShapeFix_Shape_2(shell))
    fixer.Perform(noProgress(oc))
    const fixedShell = scope.track(fixer.Shape())
    const solid = offsetResultSolid(oc, scope, fixedShell)
    if (solid === null || !shapeIsValid(oc, scope, solid)) return null
    const handle = scope.track(fixer.Context())
    return { shape: solid, context: handle.get() }
  } catch {
    return null
  }
}

/** A face's outward normal + a point ON it, for the leaf's handle anchor. A
 *  planar face anchors at its centroid; a curved one at its UV-domain midpoint
 *  (a full cylinder's centroid lies on its axis, where the normal is
 *  undefined). */
export function faceNormalAndCentroid(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
): { normal: Vec3; centroid: Vec3 } {
  const anchor = movedSurface(oc, scope, face, 0).anchor()
  return { normal: anchor.normal, centroid: anchor.point }
}

export { MoveFaceRefusal } from './moveFaceSurfaces'

function comparePoint(a: Vec3, b: Vec3): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}
