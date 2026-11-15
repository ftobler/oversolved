/**
 * Rung 2 of delete-face on an edge-modifier face: rebuild the material wedge
 * the fillet or chamfer left behind, instead of asking OCCT to re-close the
 * topology.
 *
 * A modifier face is a band between two SUPPORT faces (the rolling-ball contact
 * lines of a fillet, the sharp contact edges of a chamfer) with the END CAPS
 * across its short boundaries (the 2026-11-15 fixture runs out onto the slot
 * floor at both ends). The material the modifier removed (a convex corner) or
 * added (a concave one) is exactly the region bounded by the supports extended
 * until they meet, the end caps, and the modifier face itself. So, per ring
 * face, build the half-space the wedge lives in:
 *
 *   - a SUPPORT contributes its MATERIAL side (behind the face's outward
 *     normal) for a convex corner, and its VOID side for a concave one;
 *   - an END CAP contributes the side the modifier lies on.
 *
 * Their common region is the corner prism; the wedge is that prism minus the
 * body for a convex corner (fused back) and that prism intersected with the
 * body for a concave one (cut away). The supports are extended with
 * move-face's own rung-1 machinery (a large plane face swept into a slab, the
 * analytic ball/cylinder/torus, and its solid replacement), so a freeform
 * support refuses with that ladder's rungs instead of guessing a half-space.
 *
 * The plan sketched the wedge as a box split by the extended supports and the
 * modifier; measured on the 2026-11-15 fixture, `BRepAlgoAPI_Splitter` leaves
 * the wedge merged with the body across the sphere support (the band's free
 * boundary lies on the other tools, and a solid argument split by a dangling
 * band face gives no cell on the wedge side), so the half-space form of the
 * same construction is the one that ships. The corner prism and the two
 * booleans are still "the supports extended until they meet"; nothing about
 * the gate or the naming changes.
 *
 * Convexity is measured, not assumed. A fillet's two contact edges are TANGENT
 * (BRepOffset_Analyse cannot tell a convex from a concave fillet), so the sign
 * comes from the band's own cross-curvature: a convex fillet bends away from
 * its outward normal, a concave one toward it. A chamfer's band is ruled, its
 * cross-curvature vanishes, and its contact edges are sharp: there the edge
 * kind is the sign. The two sources are cross-checked; a disagreement refuses
 * instead of shipping the wrong side.
 *
 * This module builds and checks the wedge; naming and the deciding boolean stay
 * in defeature.ts, on the shared `booleanWithDiff` + `transferBooleanNames`
 * path.
 */

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccOrientedShape, OccShape, OccSubShape, OccXYZ } from './occTypes'
import { canonicalEdges } from './bodyNames'
import {
  bboxDiagonal,
  faceCentroid,
  faceNormal,
  makeBoxAt,
  shapeBndBox,
} from './primitives'
import { extendNeighbourFace } from './moveFace'
import { extensionKind, type ExtensionKind } from './moveFaceExtend'
import {
  extendedNeighbourSolid,
  faceSurfaceName,
  MOVE_FACE_MESH_TOL,
  representativePoints,
  sameAnalyticSurface,
} from './moveFaceSurfaces'
import { classifyFaceEdges } from './moveFace'
import { exploreSolids } from './booleans'
import { volumeOf } from './volume'
import { OCC_CONFUSION, TOL_SURFACE_IDENTITY } from '../solverConstants'
import {
  FACE_CLASSIFIER_GAP_CHECK_TOL,
  FACE_CLASSIFIER_USE_BND_BOX,
  noProgress,
} from './defaultArgs'
import type { EdgeKind } from '@/types/cad'
import type { Vec3 } from '@/utils/vec3'
import { rungCatalog } from './moveFaceRungs'

/** A rung-2 refusal. The adapter turns the message into a failed group's reason,
 *  so it names the geometry that blocked the wedge, never a bare "failed". */
export class WedgeRefusal extends Error {}

/** Rung 2's label for the refusal ladder (rung 1 is OCCT defeaturing, rung 1b
 *  the pre-conditioned retry the plan leaves conditional on Step 0). */
export const RUNG_WEDGE = 'rung 2 (support half-spaces: the corner prism, fused back or cut away)'

const norm = (v: Vec3): number => Math.hypot(v[0], v[1], v[2])
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** One boundary edge of the picked band, with the ring face across it. */
interface BandEdge {
  edge: OccShape
  // The ring face adjacent across the edge, or null for a free boundary.
  neighbour: OccShape | null
  length: number
  kind: EdgeKind
  // Shared with another picked face of the group: normally the ring excludes
  // picked faces, so the split edge of a band that comes in two pieces reads as
  // a free boundary and is filtered out below. Kept for a ring that does carry
  // a sibling, so the split is never mistaken for a support or an end cap.
  internal: boolean
}

/** The two contact lines of a band: the supports (long boundaries) and the
 *  end caps (short ones). */
interface BandSides {
  edges: BandEdge[]
  supports: BandEdge[]
  ends: BandEdge[]
  // The two support surfaces with their contact midpoints; null when the long
  // boundaries do not resolve to two distinct ring faces.
  contact: { face: OccShape; mid: Vec3 }[] | null
}

export interface WedgePlan {
  // The wedge solid that goes to the deciding boolean.
  shape: OccShape
  // How the wedge joins the body: a convex corner's removed material is fused
  // back, a concave corner's added material is cut away.
  action: 'fuse' | 'cut'
  corner: 'convex' | 'concave'
  // The two supports whose extended faces meet again when the modifier goes:
  // their images bound the restored sharp edge, whose UUID the adapter derives
  // from the pair (the same face-pair rule the pre-modifier naming used).
  restoredPairs: [OccShape, OccShape][]
  // The wedge's own volume and the geometric bound the volume gate reads.
  volume: number
  bound: { lo: number; hi: number }
  // Human-readable evidence for the probe/refusal ("convex via cross-curvature").
  evidence: string
}

function edgeLength(oc: OccModule, scope: DisposeScope, edge: OccShape): number {
  const curve = scope.track(new oc.BRepAdaptor_Curve_2(edge))
  const a = curve.FirstParameter()
  const b = curve.LastParameter()
  let length = 0
  let prev = scope.track(curve.Value(a))
  for (let i = 1; i <= 16; i++) {
    const next = scope.track(curve.Value(a + ((b - a) * i) / 16))
    length += Math.hypot(next.X() - prev.X(), next.Y() - prev.Y(), next.Z() - prev.Z())
    prev = next
  }
  return length
}

/** The midpoint of an edge, by its own curve parameter. */
function edgeMidpoint(oc: OccModule, scope: DisposeScope, edge: OccShape): Vec3 {
  const curve = scope.track(new oc.BRepAdaptor_Curve_2(edge))
  const p = scope.track(curve.Value((curve.FirstParameter() + curve.LastParameter()) / 2))
  return [p.X(), p.Y(), p.Z()]
}

/** A support contact is a seam or a point edge: not a rolling-ball contact. */
function isSeamOrDegenerate(oc: OccModule, face: OccShape, edge: OccShape): boolean {
  if (oc.BRep_Tool.Degenerated?.(edge)) return true
  return oc.BRep_Tool.IsClosed_2(edge, face)
}

/** The band's outer boundary, split into supports (the long contact lines) and
 *  end caps (the short boundaries), with the two support contact midpoints. */
function classifyBand(
  oc: OccModule,
  scope: DisposeScope,
  body: OccShape,
  groupFaces: readonly OccShape[],
  ring: readonly OccShape[],
): BandSides {
  const kindOf = classifyFaceEdges(oc, scope, body)
  const edges: BandEdge[] = []
  const isGroupFace = (other: OccShape): boolean =>
    groupFaces.some((f) => (f as OccSubShape).IsSame(other as OccSubShape))
  for (const face of groupFaces) {
    for (const edge of canonicalEdges(oc, scope, face) as OccShape[]) {
      if (isSeamOrDegenerate(oc, face, edge)) continue
      // The same topological edge can bound two picked faces; one row is enough.
      if (edges.some((row) => (row.edge as OccSubShape).IsSame(edge as OccSubShape))) continue
      let neighbour: OccShape | null = null
      for (const candidate of ring) {
        const shared = (canonicalEdges(oc, scope, candidate) as OccShape[]).some(
          (e) => (e as OccSubShape).IsSame(edge as OccSubShape),
        )
        if (shared) {
          neighbour = candidate
          break
        }
      }
      const internal = neighbour !== null && isGroupFace(neighbour)
      edges.push({
        edge,
        neighbour: internal ? null : neighbour,
        length: edgeLength(oc, scope, edge),
        kind: kindOf(edge),
        internal,
      })
    }
  }
  const outer = edges.filter((e) => !e.internal && e.neighbour !== null)
  const longest = outer.reduce((m, e) => Math.max(m, e.length), 0)
  // The fixture measured supports of 17 to 23 mm against 3 to 7 mm ends; a band
  // whose ends are not clearly shorter is not a modifier band this rung can
  // bound safely. A closed band (a fillet round a full rim) has no ends at all:
  // only its supports bound the wedge, and a leak is caught by the boundary
  // check after the prism is built.
  const cutoff = 0.5 * longest
  const supports = outer.filter((e) => e.length >= cutoff)
  const ends = outer.filter((e) => e.length < cutoff)
  if (supports.length === 0) {
    throw new WedgeRefusal(
      `${RUNG_WEDGE}: the picked faces have no long boundary edges (a modifier band needs two support contacts)`,
    )
  }
  const contact: { face: OccShape; mid: Vec3 }[] = []
  for (const row of supports) {
    const mid = edgeMidpoint(oc, scope, row.edge)
    const known = contact.find((c) => (c.face as OccSubShape).IsSame(row.neighbour as OccSubShape))
    if (known === undefined) contact.push({ face: row.neighbour as OccShape, mid })
  }
  return { edges, supports, ends, contact: contact.length === 2 ? contact : null }
}

/** The surface point and outward normal of `face` at `uv`. */
function pointNormalAtUv(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  u: number,
  v: number,
): { point: Vec3; normal: Vec3 } | null {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const props = scope.track(new oc.BRepLProp_SLProps_1(adaptor, u, v, 1, 1e-9))
  if (!props.IsNormalDefined()) return null
  const p = scope.track(new oc.gp_Pnt_1())
  adaptor.D1(u, v, p, scope.track(new oc.gp_Vec_1()), scope.track(new oc.gp_Vec_1()))
  const n = props.Normal()
  const reversed =
    (face as OccOrientedShape).Orientation_1().value ===
    oc.TopAbs_Orientation.TopAbs_REVERSED.value
  const sign = reversed ? -1 : 1
  const out = {
    point: [p.X(), p.Y(), p.Z()] as Vec3,
    normal: [n.X() * sign, n.Y() * sign, n.Z() * sign] as Vec3,
  }
  n.delete()
  return out
}

/**
 * The cross-curvature sign of a band: the second difference of the surface
 * across the band, dotted with the outward normal. A convex fillet bends AWAY
 * from its outward normal (the removed material lies on the normal side), so
 * the dot is negative; a concave fillet bends TOWARD it (the added material
 * lies on the material side), so it is positive. Near zero for a ruled chamfer
 * band, where the contact-edge kind carries the sign instead.
 */
function crossCurvatureSign(
  oc: OccModule,
  scope: DisposeScope,
  faces: readonly OccShape[],
  contact: { face: OccShape; mid: Vec3 }[],
): number | null {
  const cross = sub(contact[1].mid, contact[0].mid)
  const width = norm(cross)
  if (width < TOL_SURFACE_IDENTITY) return null
  const dir: Vec3 = [cross[0] / width, cross[1] / width, cross[2] / width]
  let best: number | null = null
  for (const face of faces) {
    const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
    const uM = (adaptor.FirstUParameter() + adaptor.LastUParameter()) / 2
    const vM = (adaptor.FirstVParameter() + adaptor.LastVParameter()) / 2
    const mid = pointNormalAtUv(oc, scope, face, uM, vM)
    if (mid === null) continue
    // Which parameter direction runs across the band? The one whose 3D
    // derivative is closest to the contact-to-contact direction.
    const p = scope.track(new oc.gp_Pnt_1())
    const du = scope.track(new oc.gp_Vec_1())
    const dv = scope.track(new oc.gp_Vec_1())
    adaptor.D1(uM, vM, p, du, dv)
    const alignU = Math.abs(dot([du.X(), du.Y(), du.Z()], dir))
    const alignV = Math.abs(dot([dv.X(), dv.Y(), dv.Z()], dir))
    const uCross = alignU >= alignV
    // A fraction of the parameter's own domain: the UV scale is unknown on a
    // B-spline band (and radians on a cylinder), so a 3D width is not a step.
    const step = uCross
      ? 0.25 * (adaptor.LastUParameter() - adaptor.FirstUParameter())
      : 0.25 * (adaptor.LastVParameter() - adaptor.FirstVParameter())
    const plus = uCross
      ? pointNormalAtUv(oc, scope, face, uM + step, vM)
      : pointNormalAtUv(oc, scope, face, uM, vM + step)
    const minus = uCross
      ? pointNormalAtUv(oc, scope, face, uM - step, vM)
      : pointNormalAtUv(oc, scope, face, uM, vM - step)
    if (plus === null || minus === null) continue
    const second: Vec3 = [
      plus.point[0] + minus.point[0] - 2 * mid.point[0],
      plus.point[1] + minus.point[1] - 2 * mid.point[1],
      plus.point[2] + minus.point[2] - 2 * mid.point[2],
    ]
    const value = dot(second, mid.normal)
    // A band is one radius; a face of a split band is the same arc, so the
    // largest magnitude is the most reliable sample.
    if (best === null || Math.abs(value) > Math.abs(best)) best = value
  }
  return best
}

/** The sign the contact-edge kinds give, or null when every contact is tangent
 *  (a fillet) or the kinds disagree. */
function contactEdgeSign(supports: BandEdge[]): 'convex' | 'concave' | null {
  let convex = false
  let concave = false
  for (const row of supports) {
    if (row.kind === 'convex') convex = true
    else if (row.kind === 'concave') concave = true
  }
  if (convex === concave) return null
  return convex ? 'convex' : 'concave'
}

/**
 * The corner sign and the evidence behind it. The cross-curvature is exact for
 * a fillet band; a ruled chamfer band has no cross-curvature, so its sharp
 * contact-edge kind decides. Both present and disagreeing is a refusal: there
 * is no safe side to pick.
 */
function cornerSign(
  oc: OccModule,
  scope: DisposeScope,
  sides: BandSides,
  faces: readonly OccShape[],
  scale: number,
): { corner: 'convex' | 'concave'; evidence: string } {
  const curvature = sides.contact === null ? null : crossCurvatureSign(oc, scope, faces, sides.contact)
  const fromCurve: 'convex' | 'concave' | null =
    curvature === null || Math.abs(curvature) <= 1e-6 * scale * scale
      ? null
      : curvature < 0 ? 'convex' : 'concave'
  const fromEdges = contactEdgeSign(sides.supports)
  if (fromCurve !== null && fromEdges !== null && fromCurve !== fromEdges) {
    throw new WedgeRefusal(
      `${RUNG_WEDGE}: the band's cross-curvature says ${fromCurve} but its contact edges say ${fromEdges}; refusing the ambiguous side`,
    )
  }
  if (fromCurve !== null) return { corner: fromCurve, evidence: `cross-curvature ${fromCurve}` }
  if (fromEdges !== null) return { corner: fromEdges, evidence: `contact edges ${fromEdges}` }
  throw new WedgeRefusal(
    `${RUNG_WEDGE}: cannot tell whether the corner is convex or concave (a tangent or mixed contact edge and a flat band); fusing the wrong side would move the wrong material`,
  )
}

/** Is `p` inside `solid`? */
function pointInSolid(oc: OccModule, scope: DisposeScope, solid: OccShape, p: Vec3): boolean {
  const pnt = scope.track(new oc.gp_Pnt_3(p[0], p[1], p[2])) as OccXYZ
  const classifier = scope.track(new oc.BRepClass3d_SolidClassifier_3(solid, pnt, OCC_CONFUSION))
  return classifier.State().value === oc.TopAbs_State.TopAbs_IN.value
}

/** A prism of `face` along `dir` for `distance` (a one-sided slab). */
function prism(oc: OccModule, scope: DisposeScope, face: OccShape, dir: Vec3, distance: number): OccShape {
  const vec = scope.track(new oc.gp_Vec_4(dir[0] * distance, dir[1] * distance, dir[2] * distance))
  const builder = scope.track(new oc.BRepPrimAPI_MakePrism_1(face, vec, true, false))
  return scope.track(builder.Shape())
}

function commonShapes(oc: OccModule, scope: DisposeScope, a: OccShape, b: OccShape): OccShape {
  const algo = scope.track(new oc.BRepAlgoAPI_Common_1())
  const args = scope.track(new oc.TopTools_ListOfShape_1())
  args.Append_1(a)
  const tools = scope.track(new oc.TopTools_ListOfShape_1())
  tools.Append_1(b)
  algo.SetArguments(args)
  algo.SetTools(tools)
  algo.Build(noProgress(oc))
  if (!algo.IsDone()) throw new WedgeRefusal(`${RUNG_WEDGE}: a corner-prism intersection did not complete`)
  return scope.track(algo.Shape())
}

function cutShape(oc: OccModule, scope: DisposeScope, a: OccShape, b: OccShape): OccShape {
  const algo = scope.track(new oc.BRepAlgoAPI_Cut_1())
  const args = scope.track(new oc.TopTools_ListOfShape_1())
  args.Append_1(a)
  const tools = scope.track(new oc.TopTools_ListOfShape_1())
  tools.Append_1(b)
  algo.SetArguments(args)
  algo.SetTools(tools)
  algo.Build(noProgress(oc))
  if (!algo.IsDone()) throw new WedgeRefusal(`${RUNG_WEDGE}: a corner-prism difference did not complete`)
  return scope.track(algo.Shape())
}

/** The closed analytic solid a support surface bounds: a ball, a cylinder or
 *  cone frustum, or a torus. Null for a freeform or unsupported kind. */
function surfaceSolid(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  kind: ExtensionKind,
  L: number,
): OccShape | null {
  if (kind === 'sphere' || kind === 'torus') {
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
    const torusBuilder = scope.track(new oc.BRepPrimAPI_MakeTorus_5(frame, tor.MajorRadius(), tor.MinorRadius()))
    return scope.track(torusBuilder.Shape())
  }
  if (kind === 'cylinder' || kind === 'cone') return extendedNeighbourSolid(oc, scope, face, L)
  return null
}

/**
 * The half-space of `face` on the requested side, as a bounded solid: +1 is the
 * face's outward-normal side, -1 the side behind it (the body's material). A
 * plane is its extended window swept into a slab; a closed surface is the
 * analytic solid on one side and the bounding box minus it on the other. The
 * big box makes both variants bounded, so the common below is a solid.
 */
function halfSpace(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  side: 1 | -1,
  box: OccShape,
  L: number,
  margin: number,
): OccShape {
  const kind = extensionKind(oc, scope, face)
  if (kind === null || kind === 'freeform') {
    throw new WedgeRefusal(
      `${RUNG_WEDGE}: support face ${faceSurfaceName(oc, scope, face)} is not an analytic surface, so no wedge half-space can be built; ${rungCatalog(oc)}`,
    )
  }
  const n = faceNormal(oc, scope, face)
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const at = pointNormalAtUv(
    oc,
    scope,
    face,
    (adaptor.FirstUParameter() + adaptor.LastUParameter()) / 2,
    (adaptor.FirstVParameter() + adaptor.LastVParameter()) / 2,
  )
  if (at === null) {
    throw new WedgeRefusal(`${RUNG_WEDGE}: the support's surface normal is undefined at its UV midpoint`)
  }
  if (kind === 'plane') {
    const window = extendNeighbourFace(oc, scope, face, L, margin)
    return prism(oc, scope, window, [n[0] * side, n[1] * side, n[2] * side], L)
  }
  const solid = surfaceSolid(oc, scope, face, kind, L)
  if (solid === null) {
    throw new WedgeRefusal(
      `${RUNG_WEDGE}: cannot build a bounded solid on the ${faceSurfaceName(oc, scope, face)} support; ${rungCatalog(oc)}`,
    )
  }
  // Which side of the surface is the solid? Probe just off the surface point (a
  // full cylinder's face centroid lies on its axis, not on the surface): the
  // same test serves a boss (outward normal away from the material) and a bore
  // (outward normal toward the void).
  const eps = Math.max(1e-3, 0.01 * margin)
  const probe: Vec3 = [
    at.point[0] + side * eps * at.normal[0],
    at.point[1] + side * eps * at.normal[1],
    at.point[2] + side * eps * at.normal[2],
  ]
  return pointInSolid(oc, scope, solid, probe) ? solid : cutShape(oc, scope, box, solid)
}

export interface WedgeInput {
  oc: OccModule
  scope: DisposeScope
  body: OccShape
  groupFaces: readonly OccShape[]
  ring: readonly OccShape[]
}

/**
 * Build the wedge for one connected group of picked modifier faces. Throws
 * WedgeRefusal with the reason when the band is not a modifier band, the
 * corner's side cannot be decided, a support cannot be extended, or the result
 * is not one bounded solid.
 */
export function modifierWedge(input: WedgeInput): WedgePlan {
  const { oc, scope, body, groupFaces, ring } = input
  if (groupFaces.length === 0) throw new WedgeRefusal(`${RUNG_WEDGE}: no picked faces`)
  const sides = classifyBand(oc, scope, body, groupFaces, ring)
  const contact = sides.contact
  if (contact === null) {
    throw new WedgeRefusal(
      `${RUNG_WEDGE}: the band's long boundaries do not meet two distinct support faces; cannot size the wedge`,
    )
  }
  const width = norm(sub(contact[1].mid, contact[0].mid))
  const length = Math.max(...sides.supports.map((row) => row.length))
  const scale = Math.max(length, width)
  const corner = cornerSign(oc, scope, sides, groupFaces, scale)
  const margin = Math.max(3 * width, 1e-3)
  const diagonal = bboxDiagonal(oc, scope, body)
  const L = 2 * (diagonal + margin)

  // The box the corner prism lives in: the band's own bounds grown by three
  // band widths (the plan's margin). Without it the support half-spaces run to
  // the body's whole extent and "prism minus body" would include material far
  // from the modifier; with it, a wedge that reaches the box wall means the
  // supports did not enclose the corner and is refused below.
  const bb = shapeBndBox(oc, scope, groupFaces[0])
  for (const face of groupFaces.slice(1)) {
    const other = shapeBndBox(oc, scope, face)
    for (let i = 0; i < 3; i++) {
      bb.min[i] = Math.min(bb.min[i], other.min[i])
      bb.max[i] = Math.max(bb.max[i], other.max[i])
    }
  }
  const box = makeBoxAt(
    oc,
    scope,
    [bb.min[0] - margin, bb.min[1] - margin, bb.min[2] - margin],
    bb.max[0] - bb.min[0] + 2 * margin,
    bb.max[1] - bb.min[1] + 2 * margin,
    bb.max[2] - bb.min[2] + 2 * margin,
  )

  // Every ring face's half-space: supports on the corner's side, end caps on
  // the side the modifier lies on.
  const modifierCentre = faceCentroid(oc, scope, groupFaces[0])
  const supportFaces = new Set(sides.supports.map((row) => row.neighbour))
  let cornerPrism = box
  for (const face of ring) {
    let side: 1 | -1
    if (supportFaces.has(face)) {
      // A support's outward normal points away from the material; the corner is
      // on the material side for a convex corner and the void side for a
      // concave one.
      side = corner.corner === 'convex' ? -1 : 1
    } else {
      const n = faceNormal(oc, scope, face)
      const c = faceCentroid(oc, scope, face)
      side = dot(sub(modifierCentre, c), n) >= 0 ? 1 : -1
    }
    cornerPrism = commonShapes(oc, scope, cornerPrism, halfSpace(oc, scope, face, side, box, L, margin))
  }
  const wedge = corner.corner === 'convex'
    ? cutShape(oc, scope, cornerPrism, body)
    : commonShapes(oc, scope, cornerPrism, body)
  const solids = exploreSolids(oc, scope, wedge)
  if (solids.length === 0) {
    throw new WedgeRefusal(
      `${RUNG_WEDGE}: the corner prism and the body leave no ${corner.corner} wedge (is the picked face a modifier band?)`,
    )
  }
  const volume = volumeOf(oc, scope, wedge)
  // The plan's wedge estimate, made loose for a non-90 degree corner: a fillet
  // of radius r along length l removes (1 - pi/4) r^2 l and a chamfer c^2 l / 2;
  // with the band's chord width w (w = r sqrt 2 or c sqrt 2 at 90 degrees) that
  // is 0.1 w^2 l and 0.25 w^2 l. The corner prism adds no second copy of the
  // body, so a whole-box result or the wrong side is far outside the bound.
  const bound = { lo: 0.005 * width * width * length, hi: 5 * width * width * length }
  if (volume < bound.lo || volume > bound.hi) {
    throw new WedgeRefusal(
      `${RUNG_WEDGE}: the ${corner.corner} wedge volume ${volume.toFixed(3)} mm3 is outside the band estimate ` +
      `[${bound.lo.toFixed(3)}, ${bound.hi.toFixed(3)}] (band width ${width.toFixed(3)}, length ${length.toFixed(3)})`,
    )
  }

  // A wedge face that is neither a picked modifier nor a ring surface means the
  // supports did not enclose the corner (a margin face, a third body surface,
  // or a support the extensions did not cross): refuse instead of shipping a
  // clipped wedge with a step.
  for (const face of canonicalFacesOf(oc, scope, wedge)) {
    if (onGroupFace(oc, scope, face, groupFaces)) continue
    if (ring.some((r) => sameAnalyticSurface(oc, scope, face, r))) continue
    throw new WedgeRefusal(
      `${RUNG_WEDGE}: the ${corner.corner} wedge has a face that is neither a picked modifier nor a support/end-cap piece; the corner is not enclosed (a margin face, a third body surface, or a support the extensions did not cross)`,
    )
  }
  return {
    shape: wedge,
    action: corner.corner === 'convex' ? 'fuse' : 'cut',
    corner: corner.corner,
    restoredPairs: [[contact[0].face, contact[1].face]],
    volume,
    bound,
    evidence: corner.evidence,
  }
}

// The two face readers the naming pass needs. They live here (not in the loop
// above) so a refusal never pays for a face walk.
function canonicalFacesOf(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const out: OccShape[] = []
  for (; exp.More(); exp.Next()) out.push(scope.track(oc.TopoDS.Face_1(scope.track(exp.Current()))))
  return out
}

/** Is `p` within `tol` of the trimmed face `face`? The 3D face classifier
 *  projects first and says IN for a point far off the surface that lands inside
 *  the trim, which would match a neighbour through a tangency. */
function withinFace(
  oc: OccModule,
  scope: DisposeScope,
  p: Vec3,
  face: OccShape,
  tol: number,
): boolean {
  const vertexBuilder = scope.track(new oc.BRepBuilderAPI_MakeVertex(
    scope.track(new oc.gp_Pnt_3(p[0], p[1], p[2])),
  ))
  const probe = scope.track(new oc.BRepExtrema_DistShapeShape_3(
    scope.track(vertexBuilder.Vertex()),
    face,
    OCC_CONFUSION,
    oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN,
    oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad,
    noProgress(oc),
  ))
  return probe.IsDone() && probe.Value() <= tol
}

/** Is the wedge face `piece` a piece of one of the picked modifier faces? The
 *  modifier's own pieces must stay unnamed (the operation deletes those faces);
 *  a tangency with a support makes a plain proximity test ambiguous, so the
 *  point must be strictly INSIDE the trimmed band, not on its boundary. */
function onGroupFace(
  oc: OccModule,
  scope: DisposeScope,
  piece: OccShape,
  groupFaces: readonly OccShape[],
): boolean {
  for (const face of groupFaces) {
    if (sameAnalyticSurface(oc, scope, piece, face)) return true
  }
  const pieceName = faceSurfaceName(oc, scope, piece)
  for (const p of representativePoints(oc, scope, piece)) {
    for (const face of groupFaces) {
      if (faceSurfaceName(oc, scope, face) !== pieceName) continue
      if (!withinFace(oc, scope, p, face, MOVE_FACE_MESH_TOL)) continue
      const pnt = scope.track(new oc.gp_Pnt_3(p[0], p[1], p[2]))
      const classifier = scope.track(new oc.BRepClass_FaceClassifier_1())
      classifier.Perform_2(face, pnt, MOVE_FACE_MESH_TOL, FACE_CLASSIFIER_USE_BND_BOX, FACE_CLASSIFIER_GAP_CHECK_TOL)
      if (classifier.State().value === oc.TopAbs_State.TopAbs_IN.value) return true
    }
  }
  return false
}
