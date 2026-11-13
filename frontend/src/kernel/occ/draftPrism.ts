// The draft-prism builder behind `extrude.taper`.
//
// The shipped path is a `BRepOffsetAPI_ThruSections` loft between the profile
// wire and the same wire offset in its own plane by `distance * tan(taper)` and
// moved to the far end. The direct `LocOpe_DPrism` binding was tried first (the
// spike test pins what it does), but it cannot take a face with holes and its
// output leaves unsewn lateral edges, so the loft is the one every tapered
// extrude goes through.
//
// A taper whose collapse height is the sweep length itself (the apex angle) is
// the third case: the same loft, to a single vertex on the end plane instead of
// a wire. The profile must close to a point; a profile that closes to a segment
// (a non-square rectangle) is refused by name, because a loft cannot run a wire
// to an edge. Two section offsets just inside the authored amount locate the
// collapse by linear extrapolation, so a hand-typed angle snaps to the apex and
// no offset is ever asked for at or past the collapse (which a closed curve
// answers badly in this build).
//
// Lineage needs the same builder surface `buildPrismLineageMap` reads from
// `BRepPrimAPI_MakePrism`: `Shape()`, `Generated(profileEdge)` and the two cap
// faces. `Generated` is precomputed from each section's `GeneratedFace` and then
// carried through the boolean that subtracts the hole frustums, so the lateral
// faces keep their `@sketch/entity` names and the caps their start/end roles. An
// apex loft has no end cap, so only `FirstShape` is exposed there and the
// adapter reports the apex point (`DraftPrismBuilder.apex`) for the caller that
// must not register a top face.
//
// OWNERSHIP: every proxy this module creates is tracked by `scope`; the returned
// builder is a plain object whose `delete()` is a no-op. `Shape()` hands back the
// UNTRACKED solid the caller owns, matching `occ/primitives.ts` producers.

import type { DisposeScope } from './disposeScope'
import type {
  OccModule,
  OccShape,
  OccSubShape,
  OccDisposable,
  OccListOfShape,
  OccPrismBuilder,
  OccThruSectionsBuilder,
} from './occTypes'
import {
  faceArea,
  faceCentroid,
  faceNormal,
  faceSurfaceType,
  SubShapeMultiIndex,
  type Vec3,
} from './primitives'
import { booleanWithHistory, countSolids, shapeIsValid } from './booleans'
import { shapeBbox } from './faceBounds'
import { makeTranslationTrsf, transformCopy } from './transforms'

/** Below this the offset is treated as no offset at all (0 is the straight
 *  prism and never reaches this builder). */
const OFFSET_EPS = 1e-9
/** Bisection depth for the collapse height; 24 halvings of a 10 mm offset put
 *  the named height well inside the 3-decimal message. */
const COLLAPSE_STEPS = 24
/** Relative snap window of an exact closure. Wide enough that a hand-typed
 *  apex angle snaps (`35.2644` for `35.264389682754654` moves the closing
 *  height by about `4e-6` on a 10 mm sweep), narrow enough that a taper
 *  collapsing visibly before the distance is still refused. Relative because
 *  the kernel length may be mm or inch. */
const APEX_SNAP = 1e-5
/** Fraction of the authored offset the two classification samples stop short
 *  of. Well inside the collapse even for a taper a hair over the apex angle, so
 *  both sections are valid wires. */
const APEX_SAMPLE = 1e-3

function countEdges(oc: OccModule, scope: DisposeScope, shape: OccShape): number {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  let n = 0
  for (; exp.More(); exp.Next()) n++
  return n
}

function isNullShape(shape: OccShape): boolean {
  return (shape as NullShape).IsNull?.() ?? false
}

interface NullShape extends OccDisposable {
  IsNull?(): boolean
}

interface ReversibleShape extends OccDisposable {
  Reversed(): OccShape
}

interface TypedShape extends OccDisposable {
  ShapeType(): { value: number }
}

/** The outer wire of `face` and its hole wires, as the face itself holds them. */
function faceWires(oc: OccModule, scope: DisposeScope, face: OccShape): { outer: OccShape; holes: OccShape[] } {
  const E = oc.TopAbs_ShapeEnum
  const outer = scope.track(oc.BRepTools.OuterWire(face))
  const holes: OccShape[] = []
  const exp = scope.track(new oc.TopExp_Explorer_2(face, E.TopAbs_WIRE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const raw = scope.track(exp.Current())
    const wire = scope.track(oc.TopoDS.Wire_1(raw))
    if (!(wire as OccSubShape).IsSame(outer as OccSubShape)) holes.push(wire)
  }
  return { outer, holes }
}

/**
 * The same wire with the opposite orientation. A hole wire comes off the face
 * clockwise, so a positive offset would move it into the material; reversing it
 * makes every section CCW and lets the outer and hole offsets use one sign rule.
 */
function reversedWire(oc: OccModule, scope: DisposeScope, wire: OccShape): OccShape {
  const reversed = scope.track((wire as ReversibleShape).Reversed())
  return scope.track(oc.TopoDS.Wire_1(reversed))
}

/** Whether an offset wire still bounds a valid planar face. A self-intersecting
 *  inward offset can keep its edges while no longer enclosing a face, which is
 *  exactly the collapse the named refusal must catch. */
function offsetWireMakesFace(oc: OccModule, scope: DisposeScope, wire: OccShape): boolean {
  try {
    const typed = scope.track(oc.TopoDS.Wire_1(wire))
    const builder = scope.track(new oc.BRepBuilderAPI_MakeFace_15(typed, true))
    if (!builder.IsDone()) return false
    const face = scope.track(builder.Face())
    return scope.track(new oc.BRepCheck_Analyzer(face, true)).IsValid_2()
  } catch {
    return false
  }
}

/** Offset a planar wire in its own plane, or null when it collapsed. OCC's
 *  collapsed result is a wire with no edges rather than an exception. */
function offsetWire(
  oc: OccModule,
  scope: DisposeScope,
  wire: OccShape,
  amount: number,
): OccShape | null {
  // A taper smaller than the offset resolution is the straight prism; a fresh
  // handle keeps the caller's release semantics uniform.
  if (Math.abs(amount) < OFFSET_EPS) return scope.track(oc.TopoDS.Wire_1(wire))
  let maker
  try {
    maker = scope.track(new oc.BRepOffsetAPI_MakeOffset_3(
      wire,
      oc.GeomAbs_JoinType.GeomAbs_Intersection,
      false,
    ))
    maker.Perform(amount, 0)
  } catch {
    return null
  }
  if (maker.IsDone !== undefined && !maker.IsDone()) return null
  let out: OccShape
  try {
    out = scope.track(maker.Shape())
  } catch {
    return null
  }
  if (isNullShape(out)) {
    scope.release(out)
    return null
  }
  // The face test runs BEFORE the edge count on purpose: an inward offset past
  // the collapse can come back as a wire whose exploration traps the kernel
  // (a closed curve offset beyond its radius returns an empty degenerate wire
  // rather than failing). A wire that cannot bound a face is collapsed, and
  // `MakeFace` answers that on the raw shape safely.
  if (!offsetWireMakesFace(oc, scope, out) || countEdges(oc, scope, out) === 0) {
    scope.release(out)
    return null
  }
  return out
}

/** Move a section wire to the far end of the extrude. */
function moveToTop(
  oc: OccModule,
  scope: DisposeScope,
  wire: OccShape,
  direction: Vec3,
  distance: number,
): OccShape {
  const trsf = makeTranslationTrsf(
    oc,
    scope,
    direction[0] * distance,
    direction[1] * distance,
    direction[2] * distance,
  )
  return scope.track(transformCopy(oc, scope, wire, trsf))
}

interface SectionBuild {
  builder: OccThruSectionsBuilder
  solid: OccShape
  // Base-wire edge -> the lateral face this builder generated for it.
  generated: SubShapeMultiIndex<OccShape>
}

/** Base-wire edge -> the lateral face the loft generated for it. */
function generatedFaces(
  oc: OccModule,
  scope: DisposeScope,
  builder: OccThruSectionsBuilder,
  baseWire: OccShape,
): SubShapeMultiIndex<OccShape> {
  const E = oc.TopAbs_ShapeEnum
  const generated = new SubShapeMultiIndex<OccShape>()
  const exp = scope.track(new oc.TopExp_Explorer_2(baseWire, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const raw = scope.track(exp.Current())
    const edge = scope.track(oc.TopoDS.Edge_1(raw))
    let face: OccShape
    try {
      face = builder.GeneratedFace(edge)
    } catch {
      continue
    }
    if (face === null || face === undefined || isNullShape(face)) continue
    scope.track(face)
    generated.add(edge as OccSubShape, face)
  }
  return generated
}

/** Build the solid loft between a base wire and its top section. */
function buildFrustum(
  oc: OccModule,
  scope: DisposeScope,
  baseWire: OccShape,
  topWire: OccShape,
): SectionBuild {
  const builder = scope.track(new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6))
  builder.CheckCompatibility(true)
  // The builder keeps a handle to both sections; keep the wire proxies alive
  // until the scope drains.
  const base = scope.track(oc.TopoDS.Wire_1(baseWire))
  const top = scope.track(oc.TopoDS.Wire_1(topWire))
  builder.AddWire(base)
  builder.AddWire(top)
  builder.Build()
  if (!builder.IsDone()) {
    throw new Error(
      'extrude: the draft prism did not build; the taper is too large or the profile is not planar',
    )
  }
  const solid = scope.track(builder.Shape())
  return { builder, solid, generated: generatedFaces(oc, scope, builder, baseWire) }
}

/**
 * Build the apex solid: the base wire lofted to one vertex on the end plane.
 * Ruled, so every lateral face of a polygon is a planar triangle and a circle
 * gives a single cone face. The vertex is added as a TopoDS_Vertex because this
 * build binds only that overload of `AddVertex`.
 */
function buildApexSection(
  oc: OccModule,
  scope: DisposeScope,
  baseWire: OccShape,
  apex: Vec3,
): SectionBuild {
  const builder = scope.track(new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6))
  builder.CheckCompatibility(true)
  // The builder keeps a handle to the base wire; keep the proxy alive until the
  // scope drains.
  const base = scope.track(oc.TopoDS.Wire_1(baseWire))
  builder.AddWire(base)
  const point = scope.track(new oc.gp_Pnt_3(apex[0], apex[1], apex[2]))
  const maker = scope.track(new oc.BRepBuilderAPI_MakeVertex(point))
  builder.AddVertex(scope.track(maker.Vertex()))
  builder.Build()
  if (!builder.IsDone()) {
    throw new Error(
      'extrude: the draft prism did not build; the taper is too large or the profile is not planar',
    )
  }
  const solid = scope.track(builder.Shape())
  return { builder, solid, generated: generatedFaces(oc, scope, builder, baseWire) }
}

/** The caps of the finished solid: the planar faces parallel to the profile,
 *  one on the profile plane and one `distance` along the sweep. A
 *  boolean-trimmed washer cap is an annulus, so the pair is found by plane, not
 *  by a congruent wire. Each role is independent: an apex loft has a start cap
 *  and no end cap, and the caller exposes only the ones found. */
function findCaps(
  oc: OccModule,
  scope: DisposeScope,
  solid: OccShape,
  profileFace: OccShape,
  direction: Vec3,
  distance: number,
): { start: OccSubShape | null; end: OccSubShape | null } {
  const E = oc.TopAbs_ShapeEnum
  const pc = faceCentroid(oc, scope, profileFace)
  const pn = faceNormal(oc, scope, profileFace)
  const tol = Math.max(1e-6, Math.abs(distance) * 1e-6)
  let start: { face: OccSubShape; area: number } | null = null
  let end: { face: OccSubShape; area: number } | null = null
  const exp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const raw = scope.track(exp.Current())
    const face = scope.track(oc.TopoDS.Face_1(raw)) as OccSubShape
    try {
      if (faceSurfaceType(oc, scope, face) !== 'flatface') continue
      const n = faceNormal(oc, scope, face)
      const cross = [
        n[1] * pn[2] - n[2] * pn[1],
        n[2] * pn[0] - n[0] * pn[2],
        n[0] * pn[1] - n[1] * pn[0],
      ]
      if (Math.hypot(cross[0], cross[1], cross[2]) > 1e-6) continue
      const c = faceCentroid(oc, scope, face)
      const at = (c[0] - pc[0]) * direction[0] + (c[1] - pc[1]) * direction[1] + (c[2] - pc[2]) * direction[2]
      const area = faceArea(oc, scope, face)
      if (Math.abs(at) <= tol) {
        if (start === null || area > start.area) start = { face, area }
      } else if (Math.abs(at - distance) <= tol) {
        if (end === null || area > end.area) end = { face, area }
      }
    } catch {
      // A face whose UV-midpoint read is undefined is not a cap; skip it
      // exactly as the geometric cap pass in prismLineage does.
      continue
    }
  }
  return { start: start?.face ?? null, end: end?.face ?? null }
}

/** The inward offset at which `wire` stops being offsettable, by bisection on
 *  the offset distance. Used only on the refusal and apex paths, so the
 *  repeated offsets never touch a working build.
 *
 *  Each probe stops a relative `1e-12` short of the midpoint it tests: a closed
 *  curve offset by exactly its radius (the collapse itself) makes OCCT throw an
 *  uncaught C++ exception, which in this build poisons the whole kernel. A
 *  nudge far below every threshold here keeps the search strictly inside the
 *  valid region. */
function inwardLimit(
  oc: OccModule,
  scope: DisposeScope,
  wire: OccShape,
  inwardAmount: number,
): number {
  let lo = 0
  let hi = inwardAmount
  for (let i = 0; i < COLLAPSE_STEPS; i++) {
    const mid = (lo + hi) / 2
    const offset = offsetWire(oc, scope, wire, -(mid * (1 - 1e-12)))
    if (offset === null) {
      hi = mid
    } else {
      lo = mid
      scope.release(offset)
    }
  }
  return lo
}

function compact(n: number): string {
  // Radians-to-degrees round trips are rarely exactly integral even when the
  // authored number was; round first so 15.000 prints as "15", not "15.000".
  return String(Number(n.toFixed(6)))
}

/** A section offset just short of the collapse, described by the numbers that
 *  are linear in the distance still left to go. */
interface OffsetSection {
  // Bbox diagonal of the section, in the profile plane.
  diagonal: number
  // The smaller in-plane bbox extent: the dimension that vanishes at the
  // collapse whether the section becomes a point or a ridge, so it is the gap
  // the extrapolation follows.
  gap: number
  // Area centroid of the section, in the profile plane.
  centroid: Vec3
}

/** The inward offset section `inward` short of the collapse, or null when the
 *  offset no longer bounds a valid face. */
function sampleSection(
  oc: OccModule,
  scope: DisposeScope,
  wire: OccShape,
  inward: number,
): OffsetSection | null {
  const offset = offsetWire(oc, scope, wire, -inward)
  if (offset === null) return null
  try {
    const box = shapeBbox(oc, scope, offset)
    const extents = [box[3] - box[0], box[4] - box[1], box[5] - box[2]].sort((a, b) => b - a)
    // A planar section has one extent across its plane; the middle extent is
    // the smaller of the two in-plane dimensions.
    const gap = extents[1]
    const diagonal = Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2])
    const builder = scope.track(new oc.BRepBuilderAPI_MakeFace_15(
      scope.track(oc.TopoDS.Wire_1(offset)),
      true,
    ))
    if (!builder.IsDone()) return null
    return { diagonal, gap, centroid: faceCentroid(oc, scope, scope.track(builder.Face())) }
  } catch {
    return null
  } finally {
    scope.release(offset)
  }
}

/** A linear model's value at zero distance left, from two samples `s1` and `s2`
 *  away from it. Both the section diagonal and its centroid run linearly in the
 *  distance left for a homothetic shrink, so this is exact for the families the
 *  apex path classifies. */
function atCollapse(v1: number, v2: number, s1: number, s2: number): number {
  return s2 === s1 ? v2 : v2 - ((v2 - v1) * s2) / (s2 - s1)
}

/** The one refusal for a profile that closes to a segment: a hip roof is a
 *  straight-skeleton feature, not a loft. */
function ridgeRefusal(deg: string, distance: number): Error {
  return new Error(
    `extrude: taper ${deg} closes the profile to a ridge, not a point, at ` +
      `${compact(distance)}; a tapered extrude can end in a point or a face`,
  )
}

/** The one refusal for a profile that has collapsed before the end: the height
 *  it collapses at, named from the authored distance and taper. */
function collapseHeightRefusal(
  oc: OccModule,
  scope: DisposeScope,
  wire: OccShape,
  taperRad: number,
  distance: number,
  inward: number,
): Error {
  const deg = compact((taperRad * 180) / Math.PI)
  const limit = inwardLimit(oc, scope, wire, inward)
  if (limit < OFFSET_EPS) {
    return new Error(
      `extrude: taper ${deg} could not offset the profile; check the profile for a self-intersection`,
    )
  }
  const height = limit / Math.abs(Math.tan(taperRad))
  return new Error(
    `extrude: taper ${deg} collapses the profile after ${height.toFixed(3)} of ` +
      `${compact(Math.abs(distance))}; shorten the distance or reduce the taper`,
  )
}

/**
 * Whether the outer profile closes at the end of the sweep, and where. Returns
 * the apex point when the collapse is a point within the snap window of
 * `distance`; null when the section is still open there (the ordinary
 * frustum); and throws the two refusals otherwise: too steep, naming the height
 * it collapses at, and a ridge, which no loft can build.
 *
 * Every offset here stops short of the collapse on purpose. A closed curve
 * offset by exactly its radius (the collapse itself) raises an uncaught OCCT
 * exception in this build, and one offset past it returns a wire the kernel
 * cannot explore, so the two samples sit at 0.1% and 0.05% inside the authored
 * amount and only the linear extrapolation reaches the collapse.
 */
function collapseApex(
  oc: OccModule,
  scope: DisposeScope,
  wire: OccShape,
  direction: Vec3,
  distance: number,
  taperRad: number,
  inward: number,
): Vec3 | null {
  const d = Math.abs(distance)
  const deg = compact((taperRad * 180) / Math.PI)
  const tol = APEX_SNAP * d
  const pointTol = Math.max(1e-6, tol)
  const a1 = inward * (1 - APEX_SAMPLE)
  const a2 = inward * (1 - APEX_SAMPLE / 2)
  const near = sampleSection(oc, scope, wire, a1)
  const nearer = sampleSection(oc, scope, wire, a2)
  if (near === null || nearer === null) {
    // The profile has closed well before the end. Name the height, the one
    // refusal this path has always given.
    throw collapseHeightRefusal(oc, scope, wire, taperRad, distance, inward)
  }
  // The gap (the smaller in-plane extent) is linear in the distance left and
  // vanishes at the collapse, so two samples locate the collapse offset without
  // ever asking the kernel for one at or past it.
  const slope = (near.gap - nearer.gap) / (a2 - a1)
  if (!(slope > 0)) return null  // not closing at all on this sweep
  const limit = a1 + near.gap / slope
  const height = limit / Math.abs(Math.tan(taperRad))
  if (height < d - tol) {
    // The extrapolation says the profile closes before the end. Confirm it with
    // the authored offset, the same probe the refusal path has always used: a
    // profile that still offsets there is a frustum and the extrapolation read
    // a shrink that is not linear near the collapse.
    const probe = offsetWire(oc, scope, wire, -inward)
    if (probe !== null) {
      scope.release(probe)
      return null
    }
    throw new Error(
      `extrude: taper ${deg} collapses the profile after ${height.toFixed(3)} of ` +
        `${compact(d)}; shorten the distance or reduce the taper`,
    )
  }
  // A collapse past the snap window is a frustum with a tiny top cap, not an
  // apex: the authored distance is not the closure.
  if (height > d + tol) return null

  // Near its collapse the section shrinks either homothetically about one point
  // (every tangential polygon, any triangle, a regular n-gon, a circle) or
  // toward a segment, so the diagonal and the centroid are linear in the
  // distance left. Both samples extrapolate to the collapse itself: a diagonal
  // that closes is a point, a longer one is a ridge.
  const s1 = limit - a1
  const s2 = limit - a2
  if (!(s2 > 0)) return null  // a valid sample cannot sit past the collapse
  const closedDiagonal = atCollapse(near.diagonal, nearer.diagonal, s1, s2)
  // A NaN (an offset read that failed to compare) is a ridge too: refusing is
  // the only safe verdict when the classification has no answer.
  if (!(closedDiagonal <= pointTol)) throw ridgeRefusal(deg, d)
  // The centre of homothety, which the centroid reaches at zero distance left.
  // A plain centroid of a tiny section is not that point for a triangle, whose
  // incentre is the centre.
  const centre: Vec3 = [
    atCollapse(near.centroid[0], nearer.centroid[0], s1, s2),
    atCollapse(near.centroid[1], nearer.centroid[1], s1, s2),
    atCollapse(near.centroid[2], nearer.centroid[2], s1, s2),
  ]
  // The user authored `distance`, so the apex sits on the registered end plane
  // (and the bbox top is exactly `distance`), not at the collapse height a hair
  // off it.
  return [
    centre[0] + direction[0] * distance,
    centre[1] + direction[1] * distance,
    centre[2] + direction[2] * distance,
  ]
}

/**
 * A fresh handle to the same TShape, cast to the shape's own type. `Shape()` is
 * read more than once (the caller and the lineage map each hold a handle), and
 * embind must not have one holder delete the handle another still uses. A
 * boolean result can be a compound, so the cast follows ShapeType rather than
 * assuming a solid.
 */
function shapeProxy(oc: OccModule, shape: OccShape): OccShape {
  const E = oc.TopAbs_ShapeEnum
  const value = (v: object): number => (v as { value: number }).value
  const type = (shape as TypedShape).ShapeType().value
  if (type === value(E.TopAbs_COMPOUND)) return oc.TopoDS.Compound_1(shape)
  if (type === value(E.TopAbs_COMPSOLID)) return oc.TopoDS.CompSolid_1(shape)
  if (type === value(E.TopAbs_SHELL)) return oc.TopoDS.Shell_1(shape)
  if (type === value(E.TopAbs_SOLID)) return oc.TopoDS.Solid_1(shape)
  return oc.TopoDS.Solid_1(shape)
}

/** The draft prism's builder: the prism surface plus the point the profile
 *  closed to. */
export interface DraftPrismBuilder extends OccPrismBuilder {
  /** The apex on the end plane, in world coordinates; null when the solid ends
   *  in a face (a frustum, or a taper that widens). */
  apex: Vec3 | null
}

/** The draft prism of `face`: one frustum for the profile, minus one widening
 *  (or narrowing) frustum per hole, or the same loft run to a vertex when the
 *  profile closes exactly at the distance. `taperRad` is positive when the
 *  material narrows along `direction`. */
export function draftPrismBuilder(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  direction: Vec3,
  distance: number,
  taperRad: number,
): DraftPrismBuilder {
  const { outer, holes } = faceWires(oc, scope, face)
  const deg = compact((taperRad * 180) / Math.PI)
  // The offset is about the actual sweep length. A negative distance sweeps the
  // other way; the draft still narrows along that sweep, so the magnitude is
  // what the offset and the collapse probe use.
  const amount = Math.abs(distance) * Math.tan(taperRad)
  // A positive taper moves the outer wire inward and every hole wire outward;
  // reversing the hole wire keeps that one sign rule. The plan's
  // material-consistent draft: the wall thins toward the top, so the hole grows
  // when the outside shrinks.
  const plans: { wire: OccShape; signedOffset: number }[] = [
    { wire: outer, signedOffset: -amount },
    ...holes.map((hole) => ({ wire: reversedWire(oc, scope, hole), signedOffset: amount })),
  ]

  // Only the outer plan narrows, so only it can collapse. The classification
  // samples strictly inside its authored offset, so the working frustum and a
  // closure at the end are told apart without ever asking the kernel for a
  // collapsed offset.
  const inward = -plans[0].signedOffset
  let apex: Vec3 | null = null
  if (inward > 0) {
    apex = collapseApex(oc, scope, plans[0].wire, direction, distance, taperRad, inward)
  }

  const sections: SectionBuild[] = []
  if (apex !== null) {
    sections.push(buildApexSection(oc, scope, plans[0].wire, apex))
  } else {
    const offset = offsetWire(oc, scope, plans[0].wire, plans[0].signedOffset)
    if (offset === null) {
      throw new Error(`extrude: taper ${deg} could not offset the profile`)
    }
    const top = moveToTop(oc, scope, offset, direction, distance)
    sections.push(buildFrustum(oc, scope, plans[0].wire, top))
    scope.release(offset)
  }
  // Each hole widens while the outer closes, so its frustum runs the whole span
  // and the cut keeps whatever stays solid.
  for (const plan of plans.slice(1)) {
    const offset = offsetWire(oc, scope, plan.wire, plan.signedOffset)
    if (offset === null) {
      throw new Error(`extrude: taper ${deg} could not offset the profile`)
    }
    const top = moveToTop(oc, scope, offset, direction, distance)
    sections.push(buildFrustum(oc, scope, plan.wire, top))
    scope.release(offset)
  }

  // Outer first, then one cut per hole. The hole frustums run exactly the same
  // span, so their caps are coincident with the outer caps; OCC's cut trims the
  // caps to the annulus without a seam at the profile plane.
  let solid = sections[0].solid
  const originMap = new SubShapeMultiIndex<OccShape>()
  for (let i = 1; i < sections.length; i++) {
    const cut = booleanWithHistory(oc, scope, solid, sections[i].solid, 'cut')
    const out = scope.track(cut.shape)
    for (const origin of cut.faceOrigin) {
      originMap.add(origin.source as OccSubShape, origin.output as OccShape)
    }
    scope.release(solid)
    solid = out
    scope.release(sections[i].solid)
  }

  // A hole that reaches the outer wall before the apex can leave the cut
  // invalid or split the tip off. Never ship that as a body: name the wall
  // instead, the way the sweep names a hole it cannot carry.
  if (apex !== null && sections.length > 1) {
    const carried = shapeIsValid(oc, scope, solid) && countSolids(oc, scope, solid) === 1
    if (!carried) {
      throw new Error(
        `extrude: taper ${deg}: the hole meets the wall before the apex; ` +
          'reduce the taper or the hole size',
      )
    }
  }

  const caps = findCaps(oc, scope, solid, face, direction, distance)

  const generatedFor = (edge: OccShape): OccShape[] => {
    const out: OccShape[] = []
    for (const section of sections) {
      for (const faceOfEdge of section.generated.get(edge as OccSubShape)) {
        const mapped = originMap.get(faceOfEdge as OccSubShape)
        if (mapped.length > 0) out.push(...mapped)
        else out.push(faceOfEdge)
      }
    }
    return out
  }

  const builder: DraftPrismBuilder = {
    IsDone: () => true,
    // A fresh proxy per call: buildPrismLineageMap tracks and releases its own
    // Shape() result, and for MakePrism that is a different handle from the one
    // the caller holds. Returning the same proxy would let that release delete
    // the caller's solid. The underlying TShape is shared, so the extra handle
    // is cheap and keeps the existing ownership contract.
    Shape: () => shapeProxy(oc, solid),
    Generated: (edge: OccShape): OccListOfShape => {
      const list = new oc.TopTools_ListOfShape_1()
      for (const generated of generatedFor(edge)) list.Append_1(generated)
      return list
    },
    delete: () => {},
    apex,
    // Only the caps the solid actually has: an apex loft exposes the base cap
    // and no end cap, so a caller that reads LastShape finds the element
    // missing instead of a phantom face.
    ...(caps.start !== null && { FirstShape: () => caps.start as OccShape }),
    ...(caps.end !== null && { LastShape: () => caps.end as OccShape }),
  }
  // The builder stays scope-owned; Shape() hands the caller a fresh untracked
  // handle to the final solid, and the section frustums and boolean outputs are
  // intermediate scope-owned shapes.
  return scope.track(builder)
}
