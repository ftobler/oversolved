// The draft-prism builder behind `extrude.taper`.
//
// The shipped path is a `BRepOffsetAPI_ThruSections` loft between the profile
// wire and the same wire offset in its own plane by `distance * tan(taper)` and
// moved to the far end. The direct `LocOpe_DPrism` binding was tried first (the
// spike test pins what it does), but it cannot take a face with holes and its
// output leaves unsewn lateral edges, so the loft is the one every tapered
// extrude goes through.
//
// Lineage needs the same builder surface `buildPrismLineageMap` reads from
// `BRepPrimAPI_MakePrism`: `Shape()`, `Generated(profileEdge)` and the two cap
// faces. `Generated` is precomputed from each section's `GeneratedFace` and then
// carried through the boolean that subtracts the hole frustums, so the lateral
// faces keep their `@sketch/entity` names and the caps their start/end roles.
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
import { booleanWithHistory } from './booleans'
import { makeTranslationTrsf, transformCopy } from './transforms'

/** Below this the offset is treated as no offset at all (0 is the straight
 *  prism and never reaches this builder). */
const OFFSET_EPS = 1e-9
/** Bisection depth for the collapse height; 24 halvings of a 10 mm offset put
 *  the named height well inside the 3-decimal message. */
const COLLAPSE_STEPS = 24

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
  if (isNullShape(out) || countEdges(oc, scope, out) === 0) {
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
  return { builder, solid, generated }
}

/** The two caps of the finished solid: the planar faces parallel to the
 *  profile, one on the profile plane and one `distance` along the sweep. A
 *  boolean-trimmed washer cap is an annulus, so the pair is found by plane, not
 *  by a congruent wire. */
function findCaps(
  oc: OccModule,
  scope: DisposeScope,
  solid: OccShape,
  profileFace: OccShape,
  direction: Vec3,
  distance: number,
): { start: OccSubShape; end: OccSubShape } | null {
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
  return start !== null && end !== null ? { start: start.face, end: end.face } : null
}

/** The inward offset at which `wire` stops being offsettable, by bisection on
 *  the offset distance. Used only on the refusal path, so the repeated offsets
 *  never touch a working build. */
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
    const offset = offsetWire(oc, scope, wire, -mid)
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
  return Number.isInteger(n) ? String(n) : n.toFixed(3)
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

/** The draft prism of `face`: one frustum for the profile, minus one widening
 *  (or narrowing) frustum per hole. `taperRad` is positive when the material
 *  narrows along `direction`. */
export function draftPrismBuilder(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  direction: Vec3,
  distance: number,
  taperRad: number,
): OccPrismBuilder {
  const { outer, holes } = faceWires(oc, scope, face)
  const amount = distance * Math.tan(taperRad)
  const tan = Math.abs(Math.tan(taperRad))
  // A positive taper moves the outer wire inward and every hole wire outward;
  // reversing the hole wire keeps that one sign rule. The plan's
  // material-consistent draft: the wall thins toward the top, so the hole grows
  // when the outside shrinks.
  const plans: { wire: OccShape; signedOffset: number }[] = [
    { wire: outer, signedOffset: -amount },
    ...holes.map((hole) => ({ wire: reversedWire(oc, scope, hole), signedOffset: amount })),
  ]

  // An inward offset that passes the profile's inradius collapses it. Name the
  // height, not the offset: the user authored a distance and a taper.
  let collapseHeight = Infinity
  for (const plan of plans) {
    if (plan.signedOffset >= 0) continue
    const inward = -plan.signedOffset
    const probe = offsetWire(oc, scope, plan.wire, -inward)
    if (probe !== null) {
      scope.release(probe)
      continue
    }
    const limit = inwardLimit(oc, scope, plan.wire, inward)
    if (limit < OFFSET_EPS) {
      throw new Error(
        `extrude: taper ${compact((taperRad * 180) / Math.PI)} could not offset the profile; ` +
          'check the profile for a self-intersection',
      )
    }
    collapseHeight = Math.min(collapseHeight, limit / tan)
  }
  if (Number.isFinite(collapseHeight)) {
    const deg = compact((taperRad * 180) / Math.PI)
    throw new Error(
      `extrude: taper ${deg} collapses the profile after ${collapseHeight.toFixed(3)} of ` +
        `${compact(distance)}; shorten the distance or reduce the taper`,
    )
  }

  const sections: SectionBuild[] = plans.map((plan) => {
    const offset = offsetWire(oc, scope, plan.wire, plan.signedOffset)
    if (offset === null) {
      throw new Error(
        `extrude: taper ${compact((taperRad * 180) / Math.PI)} could not offset the profile`,
      )
    }
    const top = moveToTop(oc, scope, offset, direction, distance)
    const built = buildFrustum(oc, scope, plan.wire, top)
    scope.release(offset)
    return built
  })

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

  const builder: OccPrismBuilder = {
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
    ...(caps !== null && {
      FirstShape: () => caps.start as OccShape,
      LastShape: () => caps.end as OccShape,
    }),
  }
  // The builder stays scope-owned; Shape() hands the caller a fresh untracked
  // handle to the final solid, and the section frustums and boolean outputs are
  // intermediate scope-owned shapes.
  return scope.track(builder)
}
