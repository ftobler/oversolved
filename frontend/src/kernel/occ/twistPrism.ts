// The twisted-prism builder behind `extrude.twist`.
//
// A twisted extrude is a sweep whose section rotates rigidly about the sketch
// plane origin as it travels. CadQuery builds it with a straight spine and an
// auxiliary helix on `BRepOffsetAPI_MakePipeShell`; the pinned OCC build binds
// four `SetMode` overloads and none of them takes the auxiliary wire (the spike
// in `kernel/occ/__tests__/twistPrismReal.test.ts` pins which one each suffix
// is), so this module lofts the section at successive rotations instead, the
// same `BRepOffsetAPI_ThruSections` pass the taper uses.
//
// A rotation preserves the section area exactly, and the non-ruled loft keeps
// the intermediate sections on the rigid rotation well inside the 1e-4 volume
// oracle, so `area * distance` stays the volume. One face per profile edge
// survives: `GeneratedFace` of the first section's edge names the whole wall
// across all sections, which is what keeps the `@sketch/entity` names on a
// twisted body.
//
// OWNERSHIP: the same contract as `draftPrism.ts`. Every proxy is scope-owned
// and `Shape()` hands back a fresh untracked handle the caller owns.

import type { DisposeScope } from './disposeScope'
import type {
  OccAxisDir,
  OccListOfShape,
  OccModule,
  OccPrismBuilder,
  OccShape,
  OccSubShape,
} from './occTypes'
import type { DraftPrismBuilder } from './draftPrism'
import { draftPrismBuilder, faceWires, findCaps, generatedFaces, reversedWire, shapeProxy } from './draftPrism'
import { makeCircleEdge, makeEllipseEdge, makeWire, SubShapeMultiIndex, type Vec3 } from './primitives'
import { booleanWithHistory } from './booleans'
import { noProgress } from './defaultArgs'
import { makeRotationTrsf, makeTranslationTrsf, transformCopy } from './transforms'

/** Degrees of twist one loft section carries. The sections interpolate a
 *  rotation, so this bounds the piecewise-linearity of the seam path and the
 *  section count at once; the spike measured the volume error at 1e-9 relative
 *  for the profiles it pins at this step. */
export const TWIST_STEP_DEG = 10

/** The work bound on an authored angle. A twist is not itself limited to one
 *  turn (a screw twists many), but a hand-typed million degrees must not ask the
 *  loft for an unbounded number of sections. */
export const MAX_TWIST_SECTIONS = 720

/** The largest angle the builder accepts, in degrees. */
export const MAX_TWIST_DEG = TWIST_STEP_DEG * MAX_TWIST_SECTIONS

/** How many loft segments an authored twist takes. At least two: a single
 *  section has no rotation to interpolate and would be the straight prism. */
export function twistSectionCount(twistDeg: number): number {
  return Math.max(2, Math.ceil(Math.abs(twistDeg) / TWIST_STEP_DEG))
}

interface TwistSection {
  solid: OccShape
  // Base-wire edge -> the lateral face this loft generated for it.
  generated: SubShapeMultiIndex<OccShape>
}

/** A wire that is one full closed conic. Its seam point is arbitrary: it does
 *  not change the point set. */
interface ClosedConic {
  center: Vec3
  // The same conic with its centre moved, seam kept at the base conic's.
  edgeAt(center: Vec3): OccShape
}

/**
 * The section's own conic, when the wire is one full closed circle or ellipse.
 * Rotating such a wire moves its seam with it, and `ThruSections` builds a
 * self-intersecting surface from sections whose closed seam wanders (spiked: a
 * washer's circular bore came back invalid and the cut read larger than the
 * plate). Keeping the base conic's own x direction and moving only its centre
 * is the same point set and stays a clean tube.
 */
function closedConicOf(
  oc: OccModule,
  scope: DisposeScope,
  wire: OccShape,
): ClosedConic | null {
  const E = oc.TopAbs_ShapeEnum
  const edges: OccShape[] = []
  const exp = scope.track(new oc.TopExp_Explorer_2(wire, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) edges.push(scope.track(oc.TopoDS.Edge_1(exp.Current())))
  if (edges.length !== 1) return null
  const adaptor = scope.track(new oc.BRepAdaptor_Curve_2(edges[0]))
  const type = adaptor.GetType().value
  const C = oc.GeomAbs_CurveType
  const circle = type === C.GeomAbs_Circle.value
  const ellipse = type === C.GeomAbs_Ellipse.value
  if (!circle && !ellipse) return null
  // A full curve closes on itself; an arc's seam is a real endpoint and rotates
  // with the section like every other edge.
  const span = adaptor.LastParameter() - adaptor.FirstParameter()
  if (Math.abs(span - 2 * Math.PI) > 1e-9) return null
  const readDir = (dir: OccAxisDir): Vec3 => {
    const raw = scope.track(dir)
    const d = scope.track(raw.Direction())
    return [d.X(), d.Y(), d.Z()]
  }
  if (circle) {
    const circ = scope.track(adaptor.Circle())
    const loc = scope.track(circ.Location())
    const normal = readDir(circ.Axis())
    const xAxis = readDir(circ.XAxis())
    const radius = circ.Radius()
    return {
      center: [loc.X(), loc.Y(), loc.Z()],
      edgeAt: (center) => scope.track(makeCircleEdge(oc, scope, center, normal, xAxis, radius)),
    }
  }
  const ell = scope.track(adaptor.Ellipse())
  const loc = scope.track(ell.Location())
  const normal = readDir(ell.Axis())
  const xAxis = readDir(ell.XAxis())
  const a = ell.MajorRadius()
  const b = ell.MinorRadius()
  return {
    center: [loc.X(), loc.Y(), loc.Z()],
    edgeAt: (center) => scope.track(makeEllipseEdge(oc, scope, center, normal, xAxis, a, b)),
  }
}

/** Rotate `point` about the line through `origin` along the unit `axis`. */
function rotateAbout(point: Vec3, origin: Vec3, axis: Vec3, angle: number): Vec3 {
  const v: Vec3 = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]]
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dot = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2]
  const cross: Vec3 = [
    axis[1] * v[2] - axis[2] * v[1],
    axis[2] * v[0] - axis[0] * v[2],
    axis[0] * v[1] - axis[1] * v[0],
  ]
  return [
    origin[0] + v[0] * cos + cross[0] * sin + axis[0] * dot * (1 - cos),
    origin[1] + v[1] * cos + cross[1] * sin + axis[1] * dot * (1 - cos),
    origin[2] + v[2] * cos + cross[2] * sin + axis[2] * dot * (1 - cos),
  ]
}

/**
 * The section wire `t` of the way along the sweep: the profile rotated by
 * `angleRad * t` about the axis through `axisOrigin` and moved to `t` of the
 * distance. A rotation about the axis and a slide along it commute, so the two
 * go into one transform. Section 0 is the profile wire itself, not a copy:
 * `GeneratedFace` must be asked about the exact edges the builder received.
 */
function placedSection(
  oc: OccModule,
  scope: DisposeScope,
  wire: OccShape,
  conic: ClosedConic | null,
  axisOrigin: Vec3,
  direction: Vec3,
  distance: number,
  angleRad: number,
  t: number,
): OccShape {
  if (t === 0) return wire
  if (conic !== null) {
    const turned = rotateAbout(conic.center, axisOrigin, direction, angleRad * t)
    const center: Vec3 = [
      turned[0] + direction[0] * distance * t,
      turned[1] + direction[1] * distance * t,
      turned[2] + direction[2] * distance * t,
    ]
    const edge = conic.edgeAt(center)
    return scope.track(makeWire(oc, scope, [edge], { requireClosed: true }))
  }
  const trsf = makeTranslationTrsf(
    oc,
    scope,
    direction[0] * distance * t,
    direction[1] * distance * t,
    direction[2] * distance * t,
  )
  trsf.Multiply(makeRotationTrsf(oc, scope, axisOrigin, direction, angleRad * t))
  return scope.track(transformCopy(oc, scope, wire, trsf))
}

/** Loft one wire through every rotation section of the sweep. */
function loftSections(
  oc: OccModule,
  scope: DisposeScope,
  baseWire: OccShape,
  axisOrigin: Vec3,
  direction: Vec3,
  distance: number,
  angleRad: number,
  sections: number,
): TwistSection {
  const conic = closedConicOf(oc, scope, baseWire)
  const builder = scope.track(new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6))
  builder.CheckCompatibility(true)
  // The builder keeps a handle to every section; keep the proxies alive until
  // the scope drains. Section 0 is the base wire whose edges seed the lineage.
  builder.AddWire(scope.track(oc.TopoDS.Wire_1(baseWire)))
  for (let k = 1; k <= sections; k++) {
    const wire = placedSection(
      oc, scope, baseWire, conic, axisOrigin, direction, distance, angleRad, k / sections,
    )
    builder.AddWire(scope.track(oc.TopoDS.Wire_1(wire)))
    scope.release(wire)
  }
  builder.Build(noProgress(oc))
  if (!builder.IsDone()) {
    throw new Error(
      'extrude: the twist prism did not build; check the profile for a self-intersection',
    )
  }
  const solid = scope.track(builder.Shape())
  return { solid, generated: generatedFaces(oc, scope, builder, baseWire) }
}

/** The surface the twist builder shares with `draftPrismBuilder`: `Shape()`,
 *  `Generated(edge)` and the two caps. A twist never closes to a point, so the
 *  apex is always null. */
export interface TwistPrismBuilder extends DraftPrismBuilder {
  apex: null
}

/** The sweeps a profile edge generated, carried through the hole cuts. */
function intersectedOrigins(
  oc: OccModule,
  scope: DisposeScope,
  solid: OccShape,
  sections: TwistSection[],
): { solid: OccShape; originMap: SubShapeMultiIndex<OccShape> } {
  const originMap = new SubShapeMultiIndex<OccShape>()
  let out = solid
  // Outer first, then one cut per hole, exactly like the draft prism: the hole
  // lofts span the same distance and rotate with the outer wall, so their caps
  // are coincident and the cut leaves the annular caps without a seam.
  for (let i = 1; i < sections.length; i++) {
    const cut = booleanWithHistory(oc, scope, out, sections[i].solid, 'cut')
    const cutSolid = scope.track(cut.shape)
    for (const origin of cut.faceOrigin) {
      originMap.add(origin.source as OccSubShape, origin.output as OccShape)
    }
    scope.release(out)
    out = cutSolid
    scope.release(sections[i].solid)
  }
  return { solid: out, originMap }
}

/**
 * The twisted prism of `face`: the profile lofted through its successive
 * rotations, minus one loft per hole wire. `twistRad` is the signed TOTAL angle
 * over `distance`, right-handed about `direction`.
 */
export function twistPrismBuilder(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  axisOrigin: Vec3,
  direction: Vec3,
  distance: number,
  twistRad: number,
): TwistPrismBuilder {
  const { outer, holes } = faceWires(oc, scope, face)
  const twistDeg = (twistRad * 180) / Math.PI
  const sections = twistSectionCount(twistDeg)
  // A hole wire comes off the face clockwise; reversing it makes every loft run
  // the same way round and keeps the cut carrying the bore wall's lineage.
  const plans = [outer, ...holes.map((hole) => reversedWire(oc, scope, hole))]
  const lofts = plans.map((wire) =>
    loftSections(oc, scope, wire, axisOrigin, direction, distance, twistRad, sections),
  )
  const { solid, originMap } = intersectedOrigins(oc, scope, lofts[0].solid, lofts)
  const caps = findCaps(oc, scope, solid, face, direction, distance)

  const generatedFor = (edge: OccShape): OccShape[] => {
    const out: OccShape[] = []
    for (const loft of lofts) {
      for (const faceOfEdge of loft.generated.get(edge as OccSubShape)) {
        const mapped = originMap.get(faceOfEdge as OccSubShape)
        if (mapped.length > 0) out.push(...mapped)
        else out.push(faceOfEdge)
      }
    }
    return out
  }

  const builder: TwistPrismBuilder = {
    IsDone: () => true,
    // A fresh proxy per call, as the draft prism: the lineage map releases its
    // own Shape() while the caller still holds one.
    Shape: () => shapeProxy(oc, solid),
    Generated: (edge: OccShape): OccListOfShape => {
      const list = new oc.TopTools_ListOfShape_1()
      for (const generated of generatedFor(edge)) list.Append_1(generated)
      return list
    },
    delete: () => {},
    apex: null,
    ...(caps.start !== null && { FirstShape: () => caps.start as OccShape }),
    ...(caps.end !== null && { LastShape: () => caps.end as OccShape }),
  }
  return scope.track(builder)
}

/**
 * The builder an extrude's profile takes: the straight prism, the taper's draft
 * prism, or the twist's loft. One switch so the three call sites in
 * `extrude.ts` and `prismLineage.ts` cannot disagree about which authored
 * fields mean which sweep.
 */
export function sweepBuilderFor(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  axisOrigin: Vec3,
  direction: Vec3,
  distance: number,
  taperRad: number,
  twistRad: number,
): OccPrismBuilder {
  if (twistRad !== 0) {
    return twistPrismBuilder(oc, scope, face, axisOrigin, direction, distance, twistRad)
  }
  if (taperRad !== 0) {
    return draftPrismBuilder(oc, scope, face, direction, distance, taperRad)
  }
  const vec = scope.track(
    new oc.gp_Vec_4(direction[0] * distance, direction[1] * distance, direction[2] * distance),
  )
  return scope.track(new oc.BRepPrimAPI_MakePrism_1(face, vec, true, true)) as OccPrismBuilder
}
