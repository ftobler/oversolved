// The wrapped-footprint builder behind the `wrap` feature (features/wrap.ts).
//
// A wrap bends a planar profile face onto an analytic face of revolution and
// raises it by a height along the surface normal. The map is wrapMath's; this
// module turns it into a solid with the one construction the spike in
// occ/__tests__/wrapSolidReal.test.ts proved on all four surface kinds:
//
//   - The target surface is rebuilt in the map's own frame (seam at the back)
//     from a gp primitive, and so is its normal offset; the offset of every kind
//     keeps the (u, v) parameters, so one parameter point names a base point and
//     the top point straight above it along the normal.
//   - Each profile edge becomes one base edge on the target and one top edge on
//     the offset. A straight sketch line on a cylinder, cone or torus is a
//     straight p-curve in (u, v) and builds exactly (MakeEdge(Geom2d_Line,
//     surface) + BuildCurves3d, the helix's binding); every other edge is a C1
//     Hermite chain through mapped samples (wrapMath.hermiteChain), whose
//     p-curves a ShapeFix_Face pass on the surface adds in place (the edges stay
//     IsSame).
//   - One `BRepOffsetAPI_ThruSections(solid, ruled)` per loop between the base
//     and top wires. Ruled walls join corresponding parameters, which are normal
//     to the surface, and the loft caps itself on the analytic surface its
//     wires' p-curves lie on (spiked: the caps come back as the cylinder, cone,
//     sphere or torus, never a B-spline). Holes are lofted the same way and cut
//     out, as the twist loft does.
//
// History: `GeneratedFace(baseEdge)` is the wall a profile edge made, and the
// first and last sections are the caps; the builder hands both to
// `buildPrismLineageMap` keyed by the PLANAR profile edge, so a wrap's faces
// carry the same `@sketch/entity` side names and start/end caps an extrude's do.
//
// OWNERSHIP: every proxy is scope-owned, and `Shape()` hands back a fresh
// untracked handle the caller owns, the twist builder's contract.

import type { DisposeScope } from './disposeScope'
import type { OccDisposable, OccListOfShape, OccModule, OccPrismBuilder, OccShape, OccSubShape } from './occTypes'
import { faceWires, isNullShape, shapeProxy } from './draftPrism'
import { faceNormal, makeBSplineChainEdge, makeWire, SubShapeMultiIndex } from './primitives'
import { booleanWithHistory, shapeIsValid } from './booleans'
import { noProgress } from './defaultArgs'
import { worldToSketch2d, type PlaneLike } from '../features/shared/planes'
import {
  hermiteChain,
  WrapRefusal,
  type OffsetSurface,
  type Vec3,
  type WrapMap,
} from '../features/wrapMath'

/** The Geom surface handle of an offset surface, read off a natural face on its
 *  gp primitive (this build binds no Geom_Conical/Spherical/ToroidalSurface). */
function surfaceHandle(oc: OccModule, scope: DisposeScope, s: OffsetSurface): unknown {
  const f = s.frame
  const ax3 = scope.track(new oc.gp_Ax3_3(
    scope.track(new oc.gp_Pnt_3(f.origin[0], f.origin[1], f.origin[2])),
    scope.track(new oc.gp_Dir_5(f.z[0], f.z[1], f.z[2])),
    scope.track(new oc.gp_Dir_5(f.x[0], f.x[1], f.x[2])),
  ))
  let maker
  if (s.kind === 'cylinder') {
    maker = new oc.BRepBuilderAPI_MakeFace_4(scope.track(new oc.gp_Cylinder_2(ax3, s.radius)))
  } else if (s.kind === 'cone') {
    maker = new oc.BRepBuilderAPI_MakeFace_5(scope.track(new oc.gp_Cone_2(ax3, s.semiAngle ?? 0, s.radius)))
  } else if (s.kind === 'sphere') {
    maker = new oc.BRepBuilderAPI_MakeFace_6(scope.track(new oc.gp_Sphere_2(ax3, s.radius)))
  } else {
    maker = new oc.BRepBuilderAPI_MakeFace_7(scope.track(new oc.gp_Torus_2(ax3, s.radius, s.minor ?? 0)))
  }
  scope.track(maker)
  const face = scope.track(maker.Face())
  return scope.track(oc.BRep_Tool.Surface_2(face))
}

/** A planar profile edge read as a sketch-space curve. */
interface ProfileEdge {
  edge: OccShape
  line: boolean
  t0: number
  t1: number
  // Sketch coordinates of the start and end vertices, so neighbours share a
  // joint bit for bit.
  start: number[]
  end: number[]
  at: (t: number) => number[]
}

function readPoint(p: { X(): number; Y(): number; Z(): number; delete(): void }): Vec3 {
  const out: Vec3 = [p.X(), p.Y(), p.Z()]
  p.delete()
  return out
}

function edgesOf(oc: OccModule, scope: DisposeScope, wire: OccShape): OccShape[] {
  const E = oc.TopAbs_ShapeEnum
  const out: OccShape[] = []
  const exp = scope.track(new oc.TopExp_Explorer_2(wire, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) out.push(scope.track(oc.TopoDS.Edge_1(scope.track(exp.Current()))))
  return out
}

function readProfileEdge(oc: OccModule, scope: DisposeScope, edge: OccShape, plane: PlaneLike): ProfileEdge {
  const adaptor = scope.track(new oc.BRepAdaptor_Curve_2(edge))
  const t0 = adaptor.FirstParameter()
  const t1 = adaptor.LastParameter()
  const at = (t: number): number[] => worldToSketch2d(readPoint(adaptor.Value(t)), plane)
  // The joint points come from the edge's own vertices: the curve's end values
  // differ from them by up to the edge tolerance, and the neighbour reads the
  // same vertex.
  const E = oc.TopAbs_ShapeEnum
  const verts: number[][] = []
  const exp = scope.track(new oc.TopExp_Explorer_2(edge, E.TopAbs_VERTEX, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const v = scope.track(oc.TopoDS.Vertex_1(scope.track(exp.Current())))
    verts.push(worldToSketch2d(readPoint(oc.BRep_Tool.Pnt(v)), plane))
  }
  const p0 = at(t0)
  const p1 = at(t1)
  const nearest = (p: number[]): number[] => {
    let best = p
    let bestD = Infinity
    for (const v of verts) {
      const d = Math.hypot(v[0] - p[0], v[1] - p[1])
      if (d < bestD) {
        bestD = d
        best = v
      }
    }
    return best
  }
  return {
    edge,
    line: adaptor.GetType().value === oc.GeomAbs_CurveType.GeomAbs_Line.value,
    t0,
    t1,
    start: nearest(p0),
    end: nearest(p1),
    at,
  }
}

/** A straight p-curve from uv `a` to uv `b` on `surface`, lifted to 3D. */
function pcurveLine(oc: OccModule, scope: DisposeScope, surface: unknown, a: [number, number], b: [number, number]): OccShape {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  if (len < 1e-14) throw new WrapRefusal('wrap: a profile edge has no length on the target')
  const p2d = scope.track(new oc.gp_Pnt2d_3(a[0], a[1]))
  const d2d = scope.track(new oc.gp_Dir2d_5((b[0] - a[0]) / len, (b[1] - a[1]) / len))
  // Adopted by the Handle at once, as the helix edge: the edge's p-curve keeps
  // the line alive through it.
  const hCurve = scope.track(new oc.Handle_Geom2d_Curve_2(new oc.Geom2d_Line_3(p2d, d2d)))
  const maker = scope.track(new oc.BRepBuilderAPI_MakeEdge_31(hCurve, surface as never, 0, len))
  const edge = scope.track(maker.Edge())
  oc.BRepLib.BuildCurves3d_1(edge, 1e-7, oc.GeomAbs_Shape.GeomAbs_C1, 14, 24)
  return edge
}

/** The base and top edges one profile edge maps to. */
interface MappedEdge {
  base: OccShape
  top: OccShape
  // The edge carries no p-curve yet and needs the face pass.
  hermite: boolean
}

function mapEdge(
  oc: OccModule,
  scope: DisposeScope,
  pe: ProfileEdge,
  map: WrapMap,
  offset: number,
  baseSurface: unknown,
  topSurface: unknown,
  tol: number,
): MappedEdge {
  if (pe.line && map.uv !== null) {
    const a = map.uv(pe.start)
    const b = map.uv(pe.end)
    return {
      base: pcurveLine(oc, scope, baseSurface, a, b),
      top: pcurveLine(oc, scope, topSurface, a, b),
      hermite: false,
    }
  }
  const fBase = (t: number): Vec3 => map.point(pe.at(t), 0)
  const fTop = (t: number): Vec3 => map.point(pe.at(t), offset)
  const startBase = map.point(pe.start, 0)
  const endBase = map.point(pe.end, 0)
  const startTop = map.point(pe.start, offset)
  const endTop = map.point(pe.end, offset)
  // Both chains take the same segment count, so their knots coincide and the
  // ruled wall joins each base parameter to the top point above it.
  let base = hermiteChain(fBase, pe.t0, pe.t1, tol, startBase, endBase)
  const top = hermiteChain(fTop, pe.t0, pe.t1, tol, startTop, endTop, base.knots.length - 1)
  if (top.knots.length !== base.knots.length) {
    base = hermiteChain(fBase, pe.t0, pe.t1, Infinity, startBase, endBase, top.knots.length - 1)
  }
  return {
    base: scope.track(makeBSplineChainEdge(oc, scope, base.poles, base.knots)),
    top: scope.track(makeBSplineChainEdge(oc, scope, top.poles, top.knots)),
    hermite: true,
  }
}

/** Give a wire's Hermite edges their p-curves on `surface`, in place. */
function addPcurves(oc: OccModule, scope: DisposeScope, surface: unknown, wire: OccShape): void {
  const maker = scope.track(new oc.BRepBuilderAPI_MakeFace_21(surface as never, wire, true))
  if (!maker.IsDone()) throw new WrapRefusal('wrap: the wrapped footprint does not bound a face on the target')
  const raw = scope.track(maker.Face())
  const fixer = scope.track(new oc.ShapeFix_Face_2(raw))
  fixer.FixOrientation_1()
  fixer.Perform(noProgress(oc))
  scope.track(fixer.Face())
}

interface LoopLoft {
  solid: OccShape
  // Planar profile edge -> the wall the loft made for it.
  generated: SubShapeMultiIndex<OccShape>
  // The same walls as a flat list, for the history the hole cuts carry.
  walls: OccShape[]
  first: OccShape | null
  last: OccShape | null
}

/** Loft one planar profile wire between its base and top images. */
function loftLoop(
  oc: OccModule,
  scope: DisposeScope,
  wire: OccShape,
  plane: PlaneLike,
  map: WrapMap,
  offset: number,
  baseSurface: unknown,
  topSurface: unknown,
  tol: number,
): LoopLoft {
  const planar = edgesOf(oc, scope, wire)
  const mapped = planar.map((e) => mapEdge(oc, scope, readProfileEdge(oc, scope, e, plane), map, offset, baseSurface, topSurface, tol))
  const baseWire = scope.track(makeWire(oc, scope, mapped.map((m) => m.base), { requireClosed: true }))
  const topWire = scope.track(makeWire(oc, scope, mapped.map((m) => m.top), { requireClosed: true }))
  if (mapped.some((m) => m.hermite)) {
    addPcurves(oc, scope, baseSurface, baseWire)
    addPcurves(oc, scope, topSurface, topWire)
  }
  const builder = scope.track(new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6))
  // The two wires are built edge for edge from the same profile, so they
  // already correspond; the compatibility pass would only re-cut them.
  builder.CheckCompatibility(false)
  builder.AddWire(scope.track(oc.TopoDS.Wire_1(baseWire)))
  builder.AddWire(scope.track(oc.TopoDS.Wire_1(topWire)))
  builder.Build(noProgress(oc))
  if (!builder.IsDone()) {
    throw new WrapRefusal('wrap: the wrapped solid did not build; check the profile for a self-intersection')
  }
  const solid = scope.track(builder.Shape())
  // The loft knows the wire's own edges, which makeWire may have rebuilt (to
  // share a vertex) or, through its healing fallback, reordered. Each is matched
  // to the profile edge it came from by identity with the mapped edge, else by
  // its two end points, never by its position in the wire, so a wall cannot
  // take a neighbouring sketch line's name.
  const ends = mapped.map((m) => endPoints(oc, scope, m.base))
  const sourceOf = (edge: OccShape): number => {
    const same = mapped.findIndex((m) => (m.base as OccSubShape).IsSame(edge))
    if (same >= 0) return same
    const [p, q] = endPoints(oc, scope, edge)
    const near = (a: Vec3, b: Vec3): boolean => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol * 10
    const hits = ends
      .map(([a, b], i) => ((near(a, p) && near(b, q)) || (near(a, q) && near(b, p)) ? i : -1))
      .filter((i) => i >= 0)
    // Two profile edges with the same end points (the halves of a circle split
    // at its two joints) cannot be told apart this way; leave the wall unnamed
    // for the neighbour pass rather than guess.
    return hits.length === 1 ? hits[0] : -1
  }
  const generated = new SubShapeMultiIndex<OccShape>()
  const walls: OccShape[] = []
  for (const edge of edgesOf(oc, scope, baseWire)) {
    const i = sourceOf(edge)
    if (i < 0) continue
    try {
      const face = scope.track(builder.GeneratedFace(edge))
      if (!isNullShape(face)) {
        generated.add(planar[i] as OccSubShape, face)
        walls.push(face)
      }
    } catch {
      // An edge the loft folded into a neighbour has no wall of its own; the
      // lineage's neighbour pass names whatever face it joined.
    }
  }
  const cap = (read: () => OccShape): OccShape | null => {
    try {
      return scope.track(read())
    } catch {
      return null
    }
  }
  const repaired = repairCaps(oc, scope, solid, map.kind, [
    { cap: cap(() => builder.FirstShape()), surface: baseSurface },
    { cap: cap(() => builder.LastShape()), surface: topSurface },
  ])
  return { solid: repaired.solid, generated, walls, first: repaired.caps[0], last: repaired.caps[1] }
}

/** The two end points of an edge, in its own parameter order. */
function endPoints(oc: OccModule, scope: DisposeScope, edge: OccShape): [Vec3, Vec3] {
  const adaptor = scope.track(new oc.BRepAdaptor_Curve_2(edge))
  return [readPoint(adaptor.Value(adaptor.FirstParameter())), readPoint(adaptor.Value(adaptor.LastParameter()))]
}

const SURFACE_TYPE: Record<WrapMap['kind'], 'GeomAbs_Cylinder' | 'GeomAbs_Cone' | 'GeomAbs_Sphere' | 'GeomAbs_Torus'> = {
  cylinder: 'GeomAbs_Cylinder',
  cone: 'GeomAbs_Cone',
  sphere: 'GeomAbs_Sphere',
  torus: 'GeomAbs_Torus',
}

/** The cap as it sits in `solid` (its in-shell orientation), by IsSame. */
function inSolid(oc: OccModule, scope: DisposeScope, solid: OccShape, cap: OccShape): OccShape | null {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const face = scope.track(oc.TopoDS.Face_1(scope.track(exp.Current())))
    if ((face as OccSubShape).IsSame(cap)) return face
  }
  return null
}

/**
 * Put each cap back on its analytic surface. The loft finds a cap's surface
 * from its wire, and a wire that happens to be planar (any circle on a sphere,
 * a parallel on a cone or torus) comes back capped by a PLANE, which is the
 * wrong solid (spiked: a disk on a sphere lost 11% of its volume). The repair
 * bounds a face on the true surface with the cap's own wire, so it shares the
 * walls' edges, orients it as the cap faced, and swaps it in.
 */
function repairCaps(
  oc: OccModule,
  scope: DisposeScope,
  solid: OccShape,
  kind: WrapMap['kind'],
  caps: { cap: OccShape | null; surface: unknown }[],
): { solid: OccShape; caps: (OccShape | null)[] } {
  const want = oc.GeomAbs_SurfaceType[SURFACE_TYPE[kind]].value
  let out = solid
  const result: (OccShape | null)[] = []
  for (const { cap, surface } of caps) {
    const placed = cap === null ? null : inSolid(oc, scope, out, cap)
    if (placed === null) {
      result.push(cap)
      continue
    }
    if (scope.track(new oc.BRepAdaptor_Surface_2(placed, true)).GetType().value === want) {
      result.push(placed)
      continue
    }
    const wire = scope.track(oc.BRepTools.OuterWire(placed))
    const maker = scope.track(new oc.BRepBuilderAPI_MakeFace_21(surface as never, wire, true))
    if (!maker.IsDone()) throw new WrapRefusal('wrap: a cap of the wrapped solid could not be rebuilt on the target')
    const fixer = scope.track(new oc.ShapeFix_Face_2(scope.track(maker.Face())))
    fixer.FixOrientation_1()
    fixer.Perform(noProgress(oc))
    let face = scope.track(fixer.Face())
    if (dot3(faceNormal(oc, scope, face), faceNormal(oc, scope, placed)) < 0) {
      face = scope.track(oc.TopoDS.Face_1(scope.track((face as ReversibleShape).Reversed())))
    }
    const reshape = scope.track(new oc.BRepTools_ReShape())
    reshape.Replace(placed, face)
    out = scope.track(reshape.Apply(out, oc.TopAbs_ShapeEnum.TopAbs_SHAPE))
    result.push(face)
  }
  return { solid: out, caps: result }
}

interface ReversibleShape extends OccDisposable {
  Reversed(): OccShape
}

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/**
 * The wrap builder for one planar profile face: the outer loop's loft minus
 * one loft per hole, with the history `buildPrismLineageMap` reads.
 * `offset` is the signed geometric offset of the top (wrapMath.geometricOffset).
 */
export function wrapBuilder(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  plane: PlaneLike,
  map: WrapMap,
  offset: number,
  tol: number,
): OccPrismBuilder {
  const baseSurface = surfaceHandle(oc, scope, map.surfaceAt(0))
  const topSurface = surfaceHandle(oc, scope, map.surfaceAt(offset))
  const { outer, holes } = faceWires(oc, scope, face)
  const lofts = [outer, ...holes].map((w) => loftLoop(oc, scope, w, plane, map, offset, baseSurface, topSurface, tol))

  // Every loft face the names are read from, each with the faces it has become
  // so far. One cut per hole, and each cut's history is applied to the CURRENT
  // images: chaining the raw per-cut maps would stop one cut short and name a
  // face the final solid no longer holds (two or more holes, any text "B").
  const tracked: { source: OccShape; images: OccShape[] }[] = []
  for (const loft of lofts) {
    for (const f of loft.walls) tracked.push({ source: f, images: [f] })
  }
  for (const cap of [lofts[0].first, lofts[0].last]) {
    if (cap !== null) tracked.push({ source: cap, images: [cap] })
  }
  // The hole lofts span the same two surfaces as the outer one, so the cut
  // leaves annular caps on them without a seam (the twist loft's argument).
  let solid = lofts[0].solid
  for (let i = 1; i < lofts.length; i++) {
    const cut = booleanWithHistory(oc, scope, solid, lofts[i].solid, 'cut')
    const next = scope.track(cut.shape)
    const step = new SubShapeMultiIndex<OccShape>()
    for (const origin of cut.faceOrigin) step.add(origin.source as OccSubShape, origin.output as OccShape)
    for (const entry of tracked) {
      entry.images = entry.images.flatMap((f) => {
        const out = step.get(f as OccSubShape)
        return out.length > 0 ? [...out] : [f]
      })
    }
    // Both inputs are consumed: the running solid and this hole's loft.
    scope.release(solid)
    scope.release(lofts[i].solid)
    solid = next
  }
  if (!shapeIsValid(oc, scope, solid)) {
    throw new WrapRefusal('wrap: the wrapped solid is not valid; check the profile for a self-intersection or reduce the height')
  }
  const carried = (f: OccShape): readonly OccShape[] =>
    tracked.find((entry) => (entry.source as OccSubShape).IsSame(f))?.images ?? [f]
  const generatedFor = (edge: OccShape): OccShape[] => {
    const out: OccShape[] = []
    for (const loft of lofts) {
      for (const f of loft.generated.get(edge as OccSubShape)) {
        for (const image of carried(f)) {
          if (!out.some((seen) => (seen as OccSubShape).IsSame(image))) out.push(image)
        }
      }
    }
    return out
  }
  const capOf = (f: OccShape | null): OccShape | null => (f === null ? null : (carried(f)[0] ?? null))
  const first = capOf(lofts[0].first)
  const last = capOf(lofts[0].last)
  const builder: OccPrismBuilder & { delete(): void } = {
    IsDone: () => true,
    Shape: () => shapeProxy(oc, solid),
    Generated: (edge: OccShape): OccListOfShape => {
      const list = new oc.TopTools_ListOfShape_1()
      for (const g of generatedFor(edge)) list.Append_1(g)
      return list
    },
    delete: () => {},
    ...(first !== null && { FirstShape: () => first }),
    ...(last !== null && { LastShape: () => last }),
  }
  return scope.track(builder)
}
