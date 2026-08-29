// `sketch_loops_to_face`, `_entity_to_occ_edge_map`, `_build_prism_lineage_map`,
// `extrude_profile_with_lineage`. This is the OCC adapter the extrude leaf
// (features/extrude.ts) calls to turn 2D profile loops into a solid plus the per-face /
// per-edge lineage keyed by copy-stable geometry hash.
//
// Lineage keying mirrors lineage-stable-keying.md: faces/edges are keyed by their geometry
// hash, not the copy-fragile OCC subshape hash, so the tokens survive the shape copies the
// build pipeline does. The profile-edge -> lateral face association comes from
// BRepPrimAPI_MakePrism.Generated() (the lineage sharp edge), drained via
// Size/First_1/RemoveFirst like every other list in this build (no iterator binding).

import { drainList, type DisposeScope } from './disposeScope'
import { extractErrorMessage, extractOccErrorMessage } from '../errors'
import { isDevBuild } from '../isDevBuild'
import {
  ANCHORED_KINDS,
  describeProfile,
  formatGap,
  formatProfileReport,
} from '../profileDiagnostics'
import type {
  OccModule,
  OccShape,
  OccSubShape,
  OccListOfShape,
  OccCircle,
  OccPrismBuilder,
  OccPipeShellBuilder,
  OccEnumValue,
} from './occTypes'
import type { PlaneLike } from '../features/shared'
import {
  edgeToGeom,
  faceArea,
  faceCentroid,
  faceNormal,
  faceSurfaceType,
  makeArcEdge,
  makeCircleEdge,
  makeLineEdge,
  makeBezierEdge,
  makeEllipseEdge,
  makeWire,
  makeFaceFromWire,
  healWire,
  wireEndpointGaps,
  type Vec3,
} from './primitives'
import { faceGh, edgeGh } from './lineageHash'
import { classifyLoops, type LoopEdge } from '../profileLoops'
import { booleanWithHistory, cleanWithHistory, countSolids } from './booleans'
import {
  nameFacesFromNeighbours,
  shapeNormalFrame,
  normalizedWorldKey,
  edgeMidpoint,
  type NormalFrame,
} from './constructionLineage'
import { failLoud } from '@/stores/stateInvariants'
import {
  mintFaceUuid,
  sideFacePath,
  capFacePath,
  deriveEdgeUuid,
  deriveSeamEdgeUuid,
  orderSplitChildren,
  type SplitChild,
} from '../constructionName'

const POINT_TOL = 1e-6

function uvTo3d(plane: PlaneLike, uv: number[]): Vec3 {
  const o = plane.origin
  const x = plane.x_axis
  const y = plane.y_axis
  return [
    o[0] + uv[0] * x[0] + uv[1] * y[0],
    o[1] + uv[0] * x[1] + uv[1] * y[1],
    o[2] + uv[0] * x[2] + uv[1] * y[2],
  ]
}

function pointsMatch(a: number[], b: number[]): boolean {
  return (
    Math.abs(a[0] - b[0]) < POINT_TOL &&
    Math.abs(a[1] - b[1]) < POINT_TOL &&
    Math.abs(a[2] - b[2]) < POINT_TOL
  )
}

// ─── sketch loops -> OCC face ───

function fullCircleOf(loop: LoopEdge[]): LoopEdge | null {
  if (loop.length < 2 || loop.some((e) => e['kind'] !== 'arc')) return null
  const c0 = loop[0]['center'] as number[] | undefined
  const r0 = loop[0]['radius'] as number | undefined
  if (c0 === undefined || r0 === undefined) return null
  for (const e of loop) {
    const c = e['center'] as number[] | undefined
    const r = e['radius'] as number | undefined
    if (c === undefined || r === undefined) return null
    if (Math.abs(r - r0) > 1e-9 || Math.abs(c[0] - c0[0]) > 1e-9 || Math.abs(c[1] - c0[1]) > 1e-9) {
      return null
    }
  }
  return {
    kind: 'arc',
    center: [...c0],
    radius: r0,
    angle_start_deg: 0.0,
    angle_end_deg: 360.0,
    ccw: true,
    start: [c0[0] + r0, c0[1]],
    end: [c0[0] + r0, c0[1]],
  }
}

function buildArcEdge(oc: OccModule, scope: DisposeScope, plane: PlaneLike, edge: LoopEdge): OccShape {
  const centerUv = (edge['center'] as number[] | undefined) ?? [0.0, 0.0]
  const radius = (edge['radius'] as number | undefined) ?? 1.0
  const a0Deg = (edge['angle_start_deg'] as number | undefined) ?? 0.0
  const a1Deg = (edge['angle_end_deg'] as number | undefined) ?? 360.0
  const ccw = (edge['ccw'] as boolean | undefined) ?? true
  const center3d = uvTo3d(plane, centerUv)
  const normal = plane.normal as Vec3
  const xAxis = plane.x_axis as Vec3

  const span = ccw ? ((a1Deg - a0Deg + 360) % 360) : -(((a0Deg - a1Deg + 360) % 360))
  if (Math.abs(Math.abs(span) - 360.0) < 1e-6) {
    return makeArcEdge(oc, scope, center3d, normal, xAxis, radius, 0.0, 2 * Math.PI)
  }
  let u0 = (a0Deg * Math.PI) / 180
  let u1 = (a1Deg * Math.PI) / 180
  if (ccw) {
    if (u1 <= u0) u1 += 2 * Math.PI
  } else {
    if (u0 <= u1) u0 += 2 * Math.PI
    const tmp = u0
    u0 = u1
    u1 = tmp
  }
  return makeArcEdge(oc, scope, center3d, normal, xAxis, radius, u0, u1)
}

/** A uv-plane direction lifted to 3D (no origin offset), for the ellipse axis. */
function uvDirTo3d(plane: PlaneLike, du: number, dv: number): Vec3 {
  const x = plane.x_axis
  const y = plane.y_axis
  return [du * x[0] + dv * y[0], du * x[1] + dv * y[1], du * x[2] + dv * y[2]]
}

function buildEllipseEdge(oc: OccModule, scope: DisposeScope, plane: PlaneLike, edge: LoopEdge): OccShape {
  const center3d = uvTo3d(plane, edge['center'] as number[])
  const theta = ((edge['theta'] as number | undefined) ?? 0) * (Math.PI / 180)
  const majorAxis = uvDirTo3d(plane, Math.cos(theta), Math.sin(theta))
  return makeEllipseEdge(oc, scope, center3d, plane.normal as Vec3, majorAxis, edge['a'] as number, edge['b'] as number)
}

/** A sliced ellipse boundary edge: a trimmed elliptical arc over its angle span. */
function buildEllipseArcEdge(oc: OccModule, scope: DisposeScope, plane: PlaneLike, edge: LoopEdge): OccShape {
  const center3d = uvTo3d(plane, edge['center'] as number[])
  const theta = ((edge['theta'] as number | undefined) ?? 0) * (Math.PI / 180)
  const majorAxis = uvDirTo3d(plane, Math.cos(theta), Math.sin(theta))
  const a = edge['a'] as number
  const b = edge['b'] as number
  let u0 = ((edge['angle_start_deg'] as number | undefined) ?? 0) * (Math.PI / 180)
  let u1 = ((edge['angle_end_deg'] as number | undefined) ?? 0) * (Math.PI / 180)
  // GC_MakeArcOfEllipse needs an increasing CCW span; flip a CW edge.
  if (!((edge['ccw'] as boolean | undefined) ?? true)) {
    const t = u0
    u0 = u1
    u1 = t
  }
  if (u1 <= u0) u1 += 2 * Math.PI
  return makeEllipseEdge(oc, scope, center3d, plane.normal as Vec3, majorAxis, a, b, u0, u1)
}

// Endpoint snapping (gap < this) bridges solver-precision joint mismatches; a
// genuinely open loop sits far above it and still fails loudly in makeWire.
const JOINT_SNAP_TOL = 1e-3

// ANCHORED_KINDS lives in kernel/profileDiagnostics so the snapper below and
// the pure profile dump cannot drift apart about which edges can be moved.

function jointDist(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

/**
 * Reconcile each loop joint so adjacent edges share an exact endpoint before they
 * become OCC edges. The solver can leave a circle whose radius/center misses a
 * shared vertex by ~1e-7 (just over OCC's confusion tolerance), so the arc's
 * on-curve endpoint and the line's vertex endpoint disagree and makeWire silently
 * drops the arc. We snap the FREE side (line/spline, whose endpoint follows its
 * stored coords) onto the ANCHORED side (arc/ellipse, pinned to its curve); when
 * both sides are free we collapse them together. Joints already wider than
 * JOINT_SNAP_TOL are left for makeWire to reject. Returns cloned edges; the
 * caller's loop dicts (shared with the stored topology) are never mutated.
 */
function snapLoopJoints(loop: LoopEdge[]): LoopEdge[] {
  const out: LoopEdge[] = loop.map((e) => {
    const c: LoopEdge = { ...e }
    if (Array.isArray(e['start'])) c['start'] = [...(e['start'] as number[])]
    if (Array.isArray(e['end'])) c['end'] = [...(e['end'] as number[])]
    return c
  })
  if (out.length < 2) return out
  const isAnchored = (e: LoopEdge): boolean => ANCHORED_KINDS.has(e['kind'] as string)
  for (let i = 0; i < out.length; i++) {
    const a = out[i]
    const b = out[(i + 1) % out.length]
    const aEnd = a['end'] as number[] | undefined
    const bStart = b['start'] as number[] | undefined
    if (!Array.isArray(aEnd) || !Array.isArray(bStart)) continue
    if (jointDist(aEnd, bStart) > JOINT_SNAP_TOL) continue
    const aAnchored = isAnchored(a)
    const bAnchored = isAnchored(b)
    if (aAnchored && bAnchored) continue  // both pinned to a curve: nothing we can move
    if (aAnchored) {
      b['start'] = [...aEnd]
    } else if (bAnchored) {
      a['end'] = [...bStart]
    } else {
      b['start'] = [...aEnd]  // free/free: collapse b's start onto a's end
    }
  }
  return out
}

/**
 * The joint gaps as OCC realized them, for a failure message. Best effort: this
 * runs only on a path that is already throwing, so it must never be the reason
 * anything fails, and it must never mask the real error.
 */
function realizedGapsLine(oc: OccModule, scope: DisposeScope, edges: OccShape[]): string {
  try {
    const gaps = wireEndpointGaps(oc, scope, edges)
    return `\n  gaps OCC realized at each joint: ${gaps.map(formatGap).join(', ')}`
  } catch {
    return ''
  }
}

/**
 * Build one loop's OCC wire. `loop` must ALREADY be snapped (see
 * `sketchLoopsToFace`): the wire this makes and the report the caller dumps have
 * to describe the same geometry, or the dump accuses joints the kernel repaired
 * and never saw.
 */
function buildWire(oc: OccModule, scope: DisposeScope, plane: PlaneLike, loop: LoopEdge[]): OccShape {
  const circle = fullCircleOf(loop)
  // Every edge below is tracked at creation and released once makeWire has
  // copied it into the wire, so a dirty feature's repeated rebuilds do not
  // stack dead boundary edges on the heap. A throw from makeWire leaves them
  // tracked: the caller's dispose() is then their owner.
  const singleEdge = (edge: OccShape): OccShape => {
    const tracked = scope.track(edge)
    let wire: OccShape
    try {
      wire = scope.track(makeWire(oc, scope, [tracked], { requireClosed: true }))
    } catch (e) {
      throw new Error(`${extractOccErrorMessage(oc, e)}${realizedGapsLine(oc, scope, [tracked])}`)
    }
    scope.release(tracked)
    return wire
  }
  if (circle !== null) return singleEdge(buildArcEdge(oc, scope, plane, circle))
  // A full ellipse is a single closed boundary edge -> one ellipse-edge wire.
  if (loop.length === 1 && (loop[0]['kind'] as string) === 'ellipse') {
    return singleEdge(buildEllipseEdge(oc, scope, plane, loop[0]))
  }
  const edges: OccShape[] = []
  for (const edge of loop) {
    const kind = edge['kind'] as string
    if (kind === 'arc') {
      edges.push(scope.track(buildArcEdge(oc, scope, plane, edge)))
    } else if (kind === 'ellipse') {
      edges.push(scope.track(buildEllipseEdge(oc, scope, plane, edge)))
    } else if (kind === 'ellipse_arc') {
      edges.push(scope.track(buildEllipseArcEdge(oc, scope, plane, edge)))
    } else if (kind === 'spline') {
      // Cubic Bezier boundary: lift the 4-point control polygon to 3D.
      const poles = [
        uvTo3d(plane, edge['start'] as number[]),
        uvTo3d(plane, edge['c1'] as number[]),
        uvTo3d(plane, edge['c2'] as number[]),
        uvTo3d(plane, edge['end'] as number[]),
      ]
      edges.push(scope.track(makeBezierEdge(oc, scope, poles)))
    } else {
      const p1 = uvTo3d(plane, edge['start'] as number[])
      const p2 = uvTo3d(plane, edge['end'] as number[])
      edges.push(scope.track(makeLineEdge(oc, scope, p1, p2)))
    }
  }
  // A profile boundary that does not close is not a profile: without this the
  // face builder takes an open chain and the extrude reports ok. The uv-space
  // dump the caller attaches says what the SKETCH asked for; these gaps say what
  // the kernel actually built, which is the pair that identifies an arc whose
  // endpoint was forced onto its ideal circle.
  let wire: OccShape
  try {
    wire = scope.track(makeWire(oc, scope, edges, { requireClosed: true }))
  } catch (e) {
    throw new Error(`${extractOccErrorMessage(oc, e)}${realizedGapsLine(oc, scope, edges)}`)
  }
  for (const e of edges) scope.release(e)
  return wire
}

/**
 * The profile dump, or '' if producing it fails. A diagnostic must never become
 * the failure: on the success path a throw in here would turn a working extrude
 * into a red feature, and in the catch it would replace the real OCC error with
 * its own. `when: 'suspect'` returns '' for a clean profile, so the dev-gated
 * log stays quiet.
 */
function safeProfileReport(loops: LoopEdge[][], when: 'suspect' | 'always'): string {
  try {
    const report = describeProfile(loops)
    if (when === 'suspect' && report.verdict !== 'suspect') return ''
    return formatProfileReport(report)
  } catch (e) {
    return when === 'always' ? `(profile dump unavailable: ${extractErrorMessage(e)})` : ''
  }
}

/**
 * Convert 2D profile boundary-edge loops to a planar OCC face with holes
 * (mirrors `sketch_loops_to_face`). loops[0] is the outer boundary; loops[1:]
 * are holes. A loop made entirely of arcs on one shared circle is emitted as a
 * single closed circle edge so OCC builds one cylindrical face on extrude.
 */
export function sketchLoopsToFace(
  oc: OccModule,
  scope: DisposeScope,
  loops: LoopEdge[][],
  plane: PlaneLike,
): OccShape {
  // Snap ONCE, here, so the wires below and the dump attached to a failure are
  // the same geometry. Snapping inside buildWire meant the report described the
  // pre-snap loops: it accused joints snapLoopJoints had already repaired and
  // OCC never saw, and it fired `suspect` on profiles that built perfectly.
  const snapped = loops.map(snapLoopJoints)
  try {
    const outerWire = buildWire(oc, scope, plane, snapped[0])
    const holeWires = snapped.slice(1).map((hole) => buildWire(oc, scope, plane, hole))
    // The wires live only until makeFaceFromWire copies them into the face; the
    // face keeps their curves alive via shared TShapes.
    let face: OccShape
    try {
      face = makeFaceFromWire(oc, scope, outerWire, holeWires)
    } finally {
      scope.release(outerWire)
      for (const w of holeWires) scope.release(w)
    }
    // A profile can build into a wrong-but-valid solid with no error anywhere
    // (a duplicated hole wire, a nesting decision that only holds on the coarse
    // polygon). Leave a trace when that happens, gated like every other hot-path
    // diagnostic so production solves stay silent.
    if (isDevBuild()) {
      const suspect = safeProfileReport(snapped, 'suspect')
      if (suspect !== '') console.warn(`sketchLoopsToFace: the profile built but looks suspect\n${suspect}`)
    }
    return face
  } catch (e) {
    // Without this the user sees an emscripten pointer, or a bare "only 3 of 4
    // edges connected", with nothing to say WHICH joint or how wide. The dump is
    // the reproduction: it is what turns "OCCT is not recognizing the shape"
    // into a paste-able bug report.
    throw new Error(`${extractOccErrorMessage(oc, e)}\n${safeProfileReport(snapped, 'always')}`)
  }
}

// ─── entity map + prism lineage ───

/**
 * Map each profile-face OCC edge (explorer order) to a sketch entity id, by
 * matching 3D endpoints (mirrors `_entity_to_occ_edge_map`). Each OCC edge maps
 * to at most one entity, and entities claim the first matching unclaimed edge,
 * iterating entities in loop order (so the assignment matches Python).
 */
function entityForEdges(
  oc: OccModule,
  scope: DisposeScope,
  occEdges: OccShape[],
  loops: LoopEdge[][],
  plane: PlaneLike,
): (string | null)[] {
  const result: (string | null)[] = new Array(occEdges.length).fill(null)

  // Pre-read each OCC edge's endpoints + (for circles) center/radius.
  const endpoints = occEdges.map((e) => {
    const ad = scope.track(new oc.BRepAdaptor_Curve_2(e))
    // The gp_Pnt proxies are by-value returns; only their coordinates
    // survive this block, so delete them before anything can throw.
    const sp = ad.Value(ad.FirstParameter())
    const ep = ad.Value(ad.LastParameter())
    const start: number[] = [sp.X(), sp.Y(), sp.Z()]
    const end: number[] = [ep.X(), ep.Y(), ep.Z()]
    sp.delete()
    ep.delete()
    const { ed } = edgeToGeom(oc, scope, e)
    return {
      sp: start,
      ep: end,
      kind: ed.kind,
      center: (ed as { center?: number[] }).center,
      radius: (ed as { radius?: number }).radius,
    }
  })

  const closedCircleMatch = (entity: LoopEdge, i: number): boolean => {
    const kind = entity['kind'] as string | undefined
    const ecenter = entity['center'] as number[] | undefined
    if ((kind !== 'circle' && kind !== 'arc') || ecenter === undefined) return false
    const ep = endpoints[i]
    if (ep.kind !== 'circle') return false
    if (!pointsMatch(ep.sp, ep.ep)) return false  // not a closed circle
    if (ep.center === undefined || ep.radius === undefined) return false
    const center3d = uvTo3d(plane, ecenter)
    return (
      pointsMatch(center3d, ep.center) &&
      Math.abs(((entity['radius'] as number) ?? 0.0) - ep.radius) < POINT_TOL
    )
  }

  for (const loop of loops) {
    for (const entity of loop) {
      const eid = (entity['id'] as string | undefined) ?? ''
      if (!eid) continue
      const start3d = uvTo3d(plane, (entity['start'] as number[] | undefined) ?? [0.0, 0.0])
      const end3d = uvTo3d(plane, (entity['end'] as number[] | undefined) ?? [0.0, 0.0])
      for (let i = 0; i < occEdges.length; i++) {
        if (result[i] !== null) continue
        const ep = endpoints[i]
        if (
          (pointsMatch(start3d, ep.sp) && pointsMatch(end3d, ep.ep)) ||
          (pointsMatch(start3d, ep.ep) && pointsMatch(end3d, ep.sp)) ||
          closedCircleMatch(entity, i)
        ) {
          result[i] = eid
          break
        }
      }
    }
  }
  return result
}

/** The construction-name maps for a built solid (see LineageResult). */
export interface LineageMaps {
  faceNames: Record<string, string>  // faceGh -> face uuid
  edgeNames: Record<string, string>  // edgeGh -> edge uuid
  faceAncestry: Record<string, string[]>  // face uuid -> ancestral tokens
  edgeAncestry: Record<string, string[]>  // edge uuid -> ancestral tokens
}

function emptyLineageMaps(): LineageMaps {
  return { faceNames: {}, edgeNames: {}, faceAncestry: {}, edgeAncestry: {} }
}

/** A built solid plus its construction-name maps. */
export type LineageResult = LineageMaps & { solid: OccShape }

/** Faces of the builder's FirstShape()/LastShape(), the sweep caps, by IsSame. */
function capGeneratedFaces(
  oc: OccModule,
  scope: DisposeScope,
  builder: { FirstShape?(): OccShape; LastShape?(): OccShape },
): { face: OccSubShape; which: 'start' | 'end' }[] {
  const E = oc.TopAbs_ShapeEnum
  const out: { face: OccSubShape; which: 'start' | 'end' }[] = []
  const collect = (getter: (() => OccShape) | undefined, which: 'start' | 'end'): void => {
    if (!getter) return
    let shape: OccShape
    try {
      shape = getter.call(builder)
    } catch {
      return
    }
    const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
    for (; exp.More(); exp.Next()) {
      out.push({ face: scope.track(oc.TopoDS.Face_1(exp.Current())) as OccSubShape, which })
    }
  }
  collect(builder.FirstShape, 'start')
  collect(builder.LastShape, 'end')
  return out
}

/**
 * Find the two caps of a prism/sweep solid when the builder does not report
 * FirstShape()/LastShape(). A cap is a face congruent to the profile face: a
 * rigid translation of it (planar, normal parallel to the profile normal, equal
 * area, centroid offset along the normal -- the sweep direction). The nearer
 * face is the start cap and the farther is the end cap, matching
 * `capFacePath`'s roles so a cap gets the SAME identity whether the builder
 * reported it or not.
 *
 * `caps` is [] unless exactly two such faces are found (a rotated cap, e.g. an
 * arc sweep, is deliberately not matched -- those builders still report their
 * caps). `capRoleGhs` is the face-gh set of EVERY planar face with the profile
 * face's area, named or not: the faces whose only legitimate names come from
 * the cap path. The caller passes it to the neighbour pass as a skip set, so a
 * cap the cap path could not reach (its builder omitted FirstShape/LastShape
 * and the probe found no translation pair) stays exactly as the old wire output
 * left it -- unnamed -- instead of being reclassified as a corner face.
 */
function geometricCapFaces(
  oc: OccModule,
  scope: DisposeScope,
  solid: OccShape,
  occFace: OccShape,
): { caps: { face: OccSubShape; which: 'start' | 'end' }[]; capRoleGhs: ReadonlySet<string> } {
  let pc: Vec3
  let pn: Vec3
  let pa: number
  try {
    pc = faceCentroid(oc, scope, occFace)
    pn = faceNormal(oc, scope, occFace)
    pa = faceArea(oc, scope, occFace)
  } catch {
    return { caps: [], capRoleGhs: new Set() }
  }
  const E = oc.TopAbs_ShapeEnum
  const candidates: { face: OccSubShape; d: number }[] = []
  const capRoleGhs = new Set<string>()
  const fexp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; fexp.More(); fexp.Next()) {
    const f = scope.track(oc.TopoDS.Face_1(fexp.Current()))
    let n: Vec3
    let a: number
    let c: Vec3
    try {
      if (faceSurfaceType(oc, scope, f) !== 'flatface') continue
      n = faceNormal(oc, scope, f)
      a = faceArea(oc, scope, f)
      c = faceCentroid(oc, scope, f)
    } catch {
      continue
    }
    if (Math.abs(a - pa) > 1e-6 * Math.max(1, pa)) continue
    capRoleGhs.add(faceGh(oc, scope, f))
    // Parallel (or anti-parallel): the face is a translation, not a rotation.
    const cross = [
      n[1] * pn[2] - n[2] * pn[1],
      n[2] * pn[0] - n[0] * pn[2],
      n[0] * pn[1] - n[1] * pn[0],
    ]
    if (Math.hypot(cross[0], cross[1], cross[2]) > 1e-6) continue
    // The centroid offset is along the profile normal only (the sweep leaves no
    // in-plane shift), so (c - pc) - d*pn is zero.
    const d = (c[0] - pc[0]) * pn[0] + (c[1] - pc[1]) * pn[1] + (c[2] - pc[2]) * pn[2]
    const inPlane = Math.hypot(
      (c[0] - pc[0]) - d * pn[0],
      (c[1] - pc[1]) - d * pn[1],
      (c[2] - pc[2]) - d * pn[2],
    )
    if (inPlane > 1e-6) continue
    candidates.push({ face: f as OccSubShape, d })
  }
  if (candidates.length !== 2) return { caps: [], capRoleGhs }
  candidates.sort((x, y) => x.d - y.d)
  return {
    caps: [
      { face: candidates[0].face, which: 'start' },
      { face: candidates[1].face, which: 'end' },
    ],
    capRoleGhs,
  }
}

/**
 * The construction-name maps for an extruded solid
 * (query-naming-by-construction.md). Internally builds a geom-hash-keyed
 * face/edge lineage (mirrors `_build_prism_lineage_map`) from the raw profile
 * entity ids, used only to seed each UUID's ancestral tokens (the caller
 * prepends `@sketch_id/`). When `createdBy` is non-empty, each side/cap face is
 * minted a construction UUID (side = the generating profile entity, cap = the
 * FirstShape/LastShape role, or the profile-derived fallback when the builder
 * omits them), a face neither match reached is named off its named neighbours,
 * and each edge derives its UUID from its two adjacent face UUIDs; multiplicity
 * (a face pair sharing >1 edge) is ordered by `orderSplitChildren` and refuses
 * on a near-tie.
 */
export function buildPrismLineageMap(
  oc: OccModule,
  scope: DisposeScope,
  occFace: OccShape,
  prismBuilder: {
    Shape(): OccShape
    Generated(s: OccShape): OccListOfShape
    FirstShape?(): OccShape
    LastShape?(): OccShape
  },
  loops: LoopEdge[][],
  plane: PlaneLike,
  createdBy = '',
  sketchId = '',
): LineageMaps {
  const E = oc.TopAbs_ShapeEnum
  const solid = prismBuilder.Shape()

  // Profile edges in explorer order, with their entity ids.
  const profEdges: OccShape[] = []
  const fexp = scope.track(new oc.TopExp_Explorer_2(occFace, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  for (; fexp.More(); fexp.Next()) profEdges.push(scope.track(oc.TopoDS.Edge_1(fexp.Current())))
  const edgeEids = entityForEdges(oc, scope, profEdges, loops, plane)

  // profile edge -> generated lateral face(s) via Generated(). Match these to
  // solid faces by subshape identity (IsSame), NOT by geom hash: Generated()
  // can return a face whose orientation -- and therefore normal-sign-dependent
  // geom hash -- differs from the same face as it sits in the solid shell.
  const genFaces: { face: OccSubShape; eid: string }[] = []
  for (let i = 0; i < profEdges.length; i++) {
    const eid = edgeEids[i]
    if (!eid) continue
    let generated: OccShape[]
    try {
      generated = drainList(scope, prismBuilder.Generated(profEdges[i]))
    } catch {
      continue
    }
    for (const g of generated) {
      const gexp = scope.track(new oc.TopExp_Explorer_2(g, E.TopAbs_FACE, E.TopAbs_SHAPE))
      for (; gexp.More(); gexp.Next()) {
        genFaces.push({ face: scope.track(oc.TopoDS.Face_1(gexp.Current())) as OccSubShape, eid })
      }
    }
  }

  // Caps named from the builder's FirstShape/LastShape; when the builder omits
  // them (or they throw), the geometric fallback derives the two caps from the
  // profile face itself so a cap's identity never depends on builder reporting.
  const capCandidates = createdBy ? capGeneratedFaces(oc, scope, prismBuilder) : []
  let capRoleGhs: ReadonlySet<string> | undefined
  if (createdBy && capCandidates.length < 2) {
    const geo = geometricCapFaces(oc, scope, solid, occFace)
    for (const g of geo.caps) {
      if (!capCandidates.some((c) => c.face.IsSame(g.face))) capCandidates.push(g)
    }
    // A cap-role face the cap path could not reach must stay exactly as the old
    // wire output left it (unnamed): the neighbour pass must not reclassify a
    // cap as a corner face, which would change every fixture's ancestry.
    capRoleGhs = geo.capRoleGhs
  }

  // solid face -> tokens + construction uuid, keyed by geometry hash. Also track
  // each face's uuid and, per edge, its geom hash + the adjacent face ghs.
  const faceLineage: Record<string, string[]> = {}
  const faceNames: Record<string, string> = {}
  const faceAncestry: Record<string, string[]> = {}
  const adjacency: Record<string, Set<string>> = {}  // edge gh -> set of adjacent face gh
  const edgeShapes: Record<string, OccShape> = {}  // edge gh -> a representative edge
  const faceExp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; faceExp.More(); faceExp.Next()) {
    const sf = scope.track(oc.TopoDS.Face_1(faceExp.Current()))
    const gh = faceGh(oc, scope, sf)
    const match = genFaces.find((gf) => (sf as OccSubShape).IsSame(gf.face))
    faceLineage[gh] = match !== undefined ? [match.eid] : []
    if (createdBy) {
      let uuid: string | null = null
      if (match !== undefined) {
        const slot = sketchId ? `${sketchId}/${match.eid}` : match.eid
        uuid = mintFaceUuid(sideFacePath(createdBy, slot))
      } else {
        const cap = capCandidates.find((c) => (sf as OccSubShape).IsSame(c.face))
        if (cap) uuid = mintFaceUuid(capFacePath(createdBy, cap.which))
      }
      if (uuid !== null) {
        faceNames[gh] = uuid
        faceAncestry[uuid] = [...faceLineage[gh]]
      }
    }
    const eExp = scope.track(new oc.TopExp_Explorer_2(sf, E.TopAbs_EDGE, E.TopAbs_SHAPE))
    for (; eExp.More(); eExp.Next()) {
      const edge = scope.track(oc.TopoDS.Edge_1(eExp.Current()))
      const egh = edgeGh(oc, scope, edge)
      if (egh === null) continue
      ;(adjacency[egh] ??= new Set()).add(gh)
      edgeShapes[egh] ??= edge
    }
  }

  // A face the generated/cap match missed (e.g. a merged-profile side face the
  // profile union trimmed off its source entity) is named off its named
  // neighbours, so its edges do not all fall back to the body-wide ancestral
  // query. Must run BEFORE the edge derivation, which needs both faces of an
  // edge named. Cap-role faces are skipped: their only legitimate name comes
  // from the cap path, and a cap the path could not reach stays unnamed so the
  // output stays byte-identical to the pre-neighbour-pass wire.
  nameFacesFromNeighbours(oc, scope, solid, faceNames, faceAncestry, capRoleGhs)

  // solid edge -> tokens, gathered from adjacent faces' ancestry.
  const edgeLineage: Record<string, string[]> = {}
  for (const [egh, faceGhs] of Object.entries(adjacency)) {
    const tokens: string[] = []
    for (const fgh of faceGhs) {
      const fu = faceNames[fgh]
      if (!fu) continue
      for (const t of faceAncestry[fu] ?? []) {
        if (!tokens.includes(t)) tokens.push(t)
      }
    }
    edgeLineage[egh] = tokens
  }

  // solid edge -> construction uuid, derived from its two adjacent face uuids.
  // Group edges by their face-pair so a pair sharing >1 edge (multiplicity) is
  // ordered deterministically and each edge gets a stable multiplicity index.
  const edgeNames: Record<string, string> = {}
  const edgeAncestry: Record<string, string[]> = {}
  if (createdBy) {
    const byPair: Record<string, string[]> = {}  // "uuidA|uuidB" -> [edge gh...]
    const bySingle: Record<string, string[]> = {}  // "uuidA" -> [seam edge gh...]
    for (const [egh, faceGhs] of Object.entries(adjacency)) {
      const uuids = [...faceGhs].map((fgh) => faceNames[fgh]).filter((u): u is string => Boolean(u))
      const distinct = [...new Set(uuids)]
      // Two named faces -> normal edge; one named face -> seam edge (e.g. a
      // circle-extrude cylinder's lateral seam). Both get a UUID so no pickable
      // edge falls back to the ambiguous createdBy+classifiers query.
      if (distinct.length === 2) {
        (byPair[[...distinct].sort().join('|')] ??= []).push(egh)
      } else if (distinct.length === 1) {
        (bySingle[distinct[0]] ??= []).push(egh)
      } else {
        // Neither an edge between two named faces nor a single-face seam: a
        // non-manifold junction (>2) or an edge every adjacent face stayed
        // unnamed on (0) after the neighbour pass. Both would collapse onto the
        // identical body-wide ancestral query, so flag them instead of silently
        // leaving the edge unnameable.
        failLoud(
          `[prismLineage] edge has ${distinct.length} distinct named adjacent faces ` +
            `(expected 1 or 2): non-manifold or unrescued topology (${createdBy})`,
        )
      }
    }
    // Edge midpoints are world coordinates: normalize them by the parent
    // solid's span so a uniform resize cancels and the refusal is relative.
    let frame: NormalFrame | null = null
    for (const [pairKey, eghs] of Object.entries(byPair)) {
      const [a, b] = pairKey.split('|')
      let ordered: string[] | null = eghs
      if (eghs.length > 1) {
        frame ??= shapeNormalFrame(oc, scope, solid)
        const f = frame
        const children: SplitChild<string>[] = eghs.map((egh) => ({
          item: egh,
          key: normalizedWorldKey(f, edgeMidpoint(oc, scope, edgeShapes[egh])),
        }))
        ordered = orderSplitChildren(children)  // null on a near-tie -> leave unnamed
      }
      if (ordered === null) continue
      ordered.forEach((egh, i) => {
        const uuid = deriveEdgeUuid(a, b, eghs.length > 1 ? i : 0)
        edgeNames[egh] = uuid
        edgeAncestry[uuid] = [...(edgeLineage[egh] ?? [])]
      })
    }
    for (const [faceUuid, eghs] of Object.entries(bySingle)) {
      let ordered: string[] | null = eghs
      if (eghs.length > 1) {
        frame ??= shapeNormalFrame(oc, scope, solid)
        const f = frame
        const children: SplitChild<string>[] = eghs.map((egh) => ({
          item: egh,
          key: normalizedWorldKey(f, edgeMidpoint(oc, scope, edgeShapes[egh])),
        }))
        ordered = orderSplitChildren(children)  // null on a near-tie -> leave unnamed
      }
      if (ordered === null) continue
      ordered.forEach((egh, i) => {
        const uuid = deriveSeamEdgeUuid(faceUuid, eghs.length > 1 ? i : 0)
        edgeNames[egh] = uuid
        edgeAncestry[uuid] = [...(edgeLineage[egh] ?? [])]
      })
    }
  }

  return { faceNames, edgeNames, faceAncestry, edgeAncestry }
}

/** Prefix bare (non-@) tokens in every value list of a token map, in place. */
function prefixTokens(lineage: Record<string, string[]>, prefix: string): void {
  for (const key of Object.keys(lineage)) {
    lineage[key] = lineage[key].map((t) => (t.startsWith('@') ? t : prefix + t))
  }
}

/** Prefix the two ancestry maps of a LineageMaps in place. */
function prefixLineageMaps(maps: LineageMaps, prefix: string): void {
  prefixTokens(maps.faceAncestry, prefix)
  prefixTokens(maps.edgeAncestry, prefix)
}

// ─── pre-prism profile union (multi-group extrude) ───

/**
 * If `wire` is a closed chain of arcs (or full circles) all on the same circle,
 * rebuild it as ONE closed-circle edge on that circle's own frame; else return
 * null (the caller keeps the original wire). This collapses the emergent hole
 * boundary that is split between two adjacent source regions into a single
 * canonical closed-circle edge before the prism is built, so the prism emits ONE
 * cylinder face with a deterministic seam (the circle's own X axis). A later
 * add-fuse onto this body -- which prisms the body's top face -- then inherits
 * the same seam by construction, and the fuse+clean merges cleanly (the
 * original "extrude adds a hole-bearing face back onto its own body" defect
 * that left every wall, hole included, doubled at the profile-plane seam).
 *
 * The first contributing arc's `gp_Circ` supplies the frame so the rebuilt
 * edge's seam is the underlying circle's own X axis -- independent of where the
 * partial arcs split it, hence the same for every body and every future tool.
 */
function collapseCircleWire(oc: OccModule, scope: DisposeScope, wire: OccShape): OccShape | null {
  const E = oc.TopAbs_ShapeEnum
  const edges: OccShape[] = []
  const exp = scope.track(new oc.TopExp_Explorer_2(wire, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) edges.push(scope.track(oc.TopoDS.Edge_1(exp.Current())))
  if (edges.length < 2) return null

  let center: Vec3 | null = null
  let radius = 0.0
  let frameCirc: OccCircle | null = null
  const tol = 1e-6
  for (const e of edges) {
    const { ed } = edgeToGeom(oc, scope, e)
    if (ed.kind !== 'arc' && ed.kind !== 'circle') return null
    const c = ed.center as Vec3
    const r = ed.radius as number
    if (center === null) {
      center = [c[0], c[1], c[2]]
      radius = r
      const ad = scope.track(new oc.BRepAdaptor_Curve_2(e))
      frameCirc = scope.track(ad.Circle())
    } else if (
      Math.abs(c[0] - center[0]) > tol ||
      Math.abs(c[1] - center[1]) > tol ||
      Math.abs(c[2] - center[2]) > tol ||
      Math.abs(r - radius) > tol
    ) {
      return null  // mixed circles / not co-circular
    }
  }
  const circ = frameCirc as OccCircle
  // Five by-value proxies chain out of the circle here; read their
  // coordinates first and delete before makeCircleEdge can throw.
  const loc = circ.Location()
  const axis = circ.Axis()
  const axDir = axis.Direction()
  const xax1 = circ.XAxis()
  const xDir = xax1.Direction()
  const edge = scope.track(makeCircleEdge(
    oc, scope,
    [loc.X(), loc.Y(), loc.Z()],
    [axDir.X(), axDir.Y(), axDir.Z()],
    [xDir.X(), xDir.Y(), xDir.Z()],
    radius,
  ))
  loc.delete()
  axis.delete()
  axDir.delete()
  xax1.delete()
  xDir.delete()
  const canonical = scope.track(makeWire(oc, scope, [edge]))
  scope.release(edge)
  return canonical
}

/**
 * Rebuild `face` so every inner (hole) wire that is a closed chain of arcs on
 * the same circle is replaced by a single closed-circle edge. The outer wire is
 * left intact (it stays a chain of partial arcs -- the peanut's outer boundary
 * uses two distinct circles and must not collapse). Returns the original face
 * unchanged when no hole needed canonicalizing, so callers can skip a redundant
 * face rebuild. Planar geometry is identical (same outer wire, same hole
 * curves), so the face's centroid/normal -- and therefore its geom hash -- is
 * preserved.
 */
function canonicalizeFaceCircles(oc: OccModule, scope: DisposeScope, face: OccShape): OccShape {
  const E = oc.TopAbs_ShapeEnum
  const outerWire = scope.track(oc.BRepTools.OuterWire(face))
  const holes: OccShape[] = []
  const wexp = scope.track(new oc.TopExp_Explorer_2(face, E.TopAbs_WIRE, E.TopAbs_SHAPE))
  for (; wexp.More(); wexp.Next()) {
    const w = scope.track(oc.TopoDS.Wire_1(wexp.Current()))
    if (!(w as OccSubShape).IsSame(outerWire)) holes.push(w)
  }
  const rebuilt = canonicalizeFaceCirclesWith(oc, scope, outerWire, holes)
  return rebuilt ?? face
}

/**
 * Exported core of [[canonicalizeFaceCircles]]: rebuild a planar face from
 * `outerWire` + `holes` so that any hole wire that is a closed chain of arcs on
 * the same circle is replaced by a single closed-circle edge. Returns the
 * original outer+holes wrapped in `makeFaceFromWire` when at least one hole was
 * canonicalized (else returns null, so the caller can skip a redundant rebuild).
 * Exposed for the unit test that drives it with synthetic wires.
 */
export function canonicalizeFaceCirclesWith(
  oc: OccModule,
  scope: DisposeScope,
  outerWire: OccShape,
  holes: OccShape[],
): OccShape | null {
  let changed = false
  const canonicalHoles: OccShape[] = []
  for (const w of holes) {
    const canon = collapseCircleWire(oc, scope, w)
    if (canon !== null) {
      changed = true
      canonicalHoles.push(canon)
    } else {
      canonicalHoles.push(w)
    }
  }
  if (!changed) return null
  // The rebuilt canonical wires are folded into the face; the caller's
  // outer+holes are not ours to free.
  try {
    return makeFaceFromWire(oc, scope, outerWire, canonicalHoles)
  } finally {
    for (const cw of canonicalHoles) scope.release(cw)
  }
}

/**
 * Pre-prism profile union via a legacy-solid round-trip.  Build the multi-group
 * extrude the legacy way (per-group prisms fused + UnifySameDomain-cleaned),
 * which yields a sound body whose every wall is already one face -- but whose
 * emergent hole cylinder carries the merged-arc (non-canonical) seam (the
 * "8-face defect" when this body is later the target of an add).  The cleaned
 * solid's ENTRANCE cap face nonetheless has a canonical closed-circle hole
 * edge (UnifySameDomain canonicalizes the cap edge as a side effect of merging
 * the two cocylindrical half-cylinder faces), so we extract that cap and
 * re-prism it ONCE.  The re-prism's hole cylinder inherits that canonical
 * seam (and the outer walls keep their arc-endpoint-pinned seams, identical to
 * the legacy build), so a downstream add-fuse that prisms this body's swept
 * top face merges cleanly -- the original defect repaired at the body's source.
 * Returns the canonical profile face, or null when the round-trip cannot
 * produce one safely (the caller then keeps the legacy multi-face body).
 */
function tryCanonicalMergedProfile(
  oc: OccModule,
  scope: DisposeScope,
  groups: [LoopEdge[], LoopEdge[][]][],
  plane: PlaneLike,
  directionVec: Vec3,
  distance: number,
): OccShape | null {
  try {
    const faces = groups.map(([outer, holes]) =>
      scope.track(sketchLoopsToFace(oc, scope, [outer, ...holes], plane)),
    )
    const vec = scope.track(
      new oc.gp_Vec_4(
        directionVec[0] * distance,
        directionVec[1] * distance,
        directionVec[2] * distance,
      ),
    )
    // Every solid here is an intermediate (the function returns a face off
    // the final one), so each stays scope-owned: the prism results, the parts
    // fused away, and every fuse output the next iteration replaces. Each
    // group face is released once its prism has copied it.
    const prismOf = (face: OccShape): OccShape =>
      (scope.track(new oc.BRepPrimAPI_MakePrism_1(face, vec, true, true)) as OccPrismBuilder).Shape()
    let solid: OccShape = scope.track(prismOf(faces[0]))
    scope.release(faces[0])
    for (let i = 1; i < faces.length; i++) {
      const part = scope.track(prismOf(faces[i]))
      const fused: OccShape = booleanWithHistory(oc, scope, solid, part, 'fuse').shape
      scope.track(fused)
      solid = fused
      scope.release(part)
      scope.release(faces[i])
    }
    // The pre-prism-union path only makes sense when the groups tile ONE
    // connected region (their prism-fuse collapses to a single solid). For
    // disjoint groups (e.g. two non-adjacent rects) the fuse stays a
    // compound of N solids -- the legacy path must keep them as the
    // multi-body output the caller splits apart; bailing here preserves it.
    if (countSolids(oc, scope, solid) !== 1) return null
    try {
      const cleaned = cleanWithHistory(oc, scope, solid).shape
      scope.track(cleaned)
      solid = cleaned
    } catch {
      // The prism-fuse-clean is the legacy path -- the only throw the
      // diagnostics pinned was the periodic-cylinder face merge (now avoided
      // here because this solid is the build target, never the add tool). Any
      // other throw means we cannot get a canonical cap cleanly -> bail.
      return null
    }
    // Find the ENTRANCE cap: a planar face whose normal is anti-parallel to
    // `directionVec` and whose centroid lies on the resolved profile plane
    // through `plane.origin`.  That is the sketch-side cap; priming it back
    // along `directionVec` rebuilds the same span (so symmetric/reverse keep
    // their resolved effective plane).
    const E = oc.TopAbs_ShapeEnum
    const fexp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_FACE, E.TopAbs_SHAPE))
    // Project the centroid onto the resolved profile-plane normal (not the
    // prism direction) so the entrance cap is identified regardless of the
    // resolved direction's relation to the sketch normal (symmetric/reverse
    // here today; a future skew extrude would still find the cap correctly).
    const op =
      plane.origin[0] * plane.normal[0] +
      plane.origin[1] * plane.normal[1] +
      plane.origin[2] * plane.normal[2]
    let entrance: OccShape | null = null
    for (; fexp.More(); fexp.Next()) {
      const f = scope.track(oc.TopoDS.Face_1(fexp.Current()))
      if (faceSurfaceType(oc, scope, f) !== 'flatface') continue
      const n = faceNormal(oc, scope, f)
      const dot = n[0] * directionVec[0] + n[1] * directionVec[1] + n[2] * directionVec[2]
      if (dot > -0.9) continue  // not anti-parallel -- not the entrance cap
      const c = faceCentroid(oc, scope, f)
      const cp =
        c[0] * plane.normal[0] +
        c[1] * plane.normal[1] +
        c[2] * plane.normal[2]
      if (Math.abs(cp - op) > 1e-3) continue  // not on the resolved profile plane
      entrance = f
      break
    }
    if (entrance === null) return null
    return canonicalizeFaceCircles(oc, scope, entrance)
  } catch {
    return null
  }
}

/**
 * Prism a single profile face, then attach the per-profile-edge lineage keyed
 * by geometry hash. `lineageLoops` is the set of profile loops whose entity ids
 * the merged face's edges will be matched against (flat across groups for the
 * pre-prism-union path, the per-group loops for the single-group path).
 */
function prismFaceWithLineage(
  oc: OccModule,
  scope: DisposeScope,
  profileFace: OccShape,
  lineageLoops: LoopEdge[][],
  plane: PlaneLike,
  directionVec: Vec3,
  distance: number,
  tokenPrefix: string,
  createdBy: string,
  sketchId: string,
): LineageResult {
  const builder = scope.track(
    new oc.BRepPrimAPI_MakePrism_1(
      profileFace,
      scope.track(
        new oc.gp_Vec_4(
          directionVec[0] * distance,
          directionVec[1] * distance,
          directionVec[2] * distance,
        ),
      ),
      true,
      true,
    ),
  ) as OccPrismBuilder
  const solid = builder.Shape()
  // The profile face is read one last time here; afterwards the solid keeps
  // the shared TShapes alive, so the proxy itself can go.
  const face = scope.track(profileFace)
  const lineage = buildPrismLineageMap(oc, scope, face, builder, lineageLoops, plane, createdBy, sketchId)
  prefixLineageMaps(lineage, tokenPrefix)
  scope.release(face)
  return { solid, ...lineage }
}

/**
 * Legacy per-group prism + fuse path (the fallback for a multi-group extrude
 * whose planar profile union cannot be safely reconstructed). Each group's
 * loops become one prism, prisms are fused, and the fused solid is cleaned
 * when more than one group survived -- producing a sound body whose every wall
 * nonetheless carries the internal seam at the source-region boundaries
 * (the documented 8-face defect on the peanut-with-hole add case).
 */
function perGroupPrismWithLineage(
  oc: OccModule,
  scope: DisposeScope,
  groups: [LoopEdge[], LoopEdge[][]][],
  plane: PlaneLike,
  directionVec: Vec3,
  distance: number,
  tokenPrefix: string,
  createdBy: string,
  sketchId: string,
): LineageResult {
  let solid: OccShape | null = null
  const merged = emptyLineageMaps()

  for (const [outer, holes] of groups) {
    const face = scope.track(sketchLoopsToFace(oc, scope, [outer, ...holes], plane))
    const builder = scope.track(
      new oc.BRepPrimAPI_MakePrism_1(
        face,
        scope.track(
          new oc.gp_Vec_4(
            directionVec[0] * distance,
            directionVec[1] * distance,
            directionVec[2] * distance,
          ),
        ),
        true,
        true,
      ),
    ) as OccPrismBuilder
    const part = builder.Shape()
    // Each group's prism and each fuse output is consumed by the next fuse
    // except the survivor returned at the end; scope-own them all here and
    // detach only that survivor, which the caller takes over.
    scope.track(part)
    const lineage = buildPrismLineageMap(oc, scope, face, builder, [outer, ...holes], plane, createdBy, sketchId)
    prefixLineageMaps(lineage, tokenPrefix)
    // The profile face is dead once the lineage has been read off it.
    scope.release(face)
    Object.assign(merged.faceNames, lineage.faceNames)
    Object.assign(merged.edgeNames, lineage.edgeNames)
    Object.assign(merged.faceAncestry, lineage.faceAncestry)
    Object.assign(merged.edgeAncestry, lineage.edgeAncestry)

    if (solid === null) {
      solid = part
    } else {
      const fused: OccShape = booleanWithHistory(oc, scope, solid, part, 'fuse').shape
      scope.track(fused)
      solid = fused
    }
  }

  if (solid === null) throw new Error('no loops to extrude')
  if (groups.length > 1) {
    // cleanWithHistory collapses the per-region coplanar caps into one each
    // and the cocylindrical walls into one.  On a disjoint multi-solid
    // compound (the fallback path here) UnifySameDomain can occasionally
    // reject the compound; keep the un-merged raw_solid in that rare case
    // rather than crash the feature -- the caller side splits multi-solids.
    try {
      const cleaned = cleanWithHistory(oc, scope, solid).shape
      scope.track(cleaned)
      solid = cleaned
    } catch {
      // kept raw solid -- segmentation faces survive but the volume is intact.
    }
  }
  return { solid: scope.detach(solid), ...merged }
}

/**
 * Extrude profile loops to a solid and return (solid + construction-name maps)
 * (mirrors `extrude_profile_with_lineage`). Disjoint loop groups are extruded
 * and fused; nested loops become holes. The returned solid is raw and lives in
 * `scope` -- the caller registers/disposes it (typically via applyBodyOperation).
 * Lineage tokens are `@sketch_id/entity`.
 *
 * Multi-group extrudes take the "pre-prism profile union" path: the groups'
 * loops are extruded the legacy way (per-group prisms fused + cleaned), which
 * already yields ONE body whose every wall is a single face, but whose emergent
 * hole cylinder carries a non-canonical seam (the documented "8-face defect"
 * when this body is later the target of an add).  We then extract that body's
 * ENTRANCE cap face (which carries a canonical closed-circle hole edge -- a
 * side effect of the clean fusion of the cocylindrical half-cylinder walls),
 * canonicalize any remaining split-hole boundary, and re-prism the resulting
 * single face ONCE.  This rebuilds the same body with a canonical hole seam so a
 * downstream add-fuse that prisms this body's top face merges cleanly.  The
 * legacy per-prism fuse path survives as a fallback for the rare case that the
 * round-trip cannot recover a single canonical face.
 */
export function extrudeProfileWithLineage(
  oc: OccModule,
  scope: DisposeScope,
  loops: LoopEdge[][],
  plane: PlaneLike,
  directionVec: Vec3,
  distance: number,
  sketchId = '',
  createdBy = '',
): LineageResult {
  const groups = classifyLoops(loops)
  if (groups.length === 0) throw new Error('no loops to extrude')
  const tokenPrefix = sketchId ? `@${sketchId}/` : '@'

  if (groups.length === 1) {
    const [outer, holes] = groups[0]
    const face = sketchLoopsToFace(oc, scope, [outer, ...holes], plane)
    return prismFaceWithLineage(oc, scope, face, [outer, ...holes], plane, directionVec, distance, tokenPrefix, createdBy, sketchId)
  }

  const merged = tryCanonicalMergedProfile(oc, scope, groups, plane, directionVec, distance)
  if (merged !== null) {
    const lineageLoops = groups.flatMap(([outer, holes]) => [outer, ...holes])
    return prismFaceWithLineage(oc, scope, merged, lineageLoops, plane, directionVec, distance, tokenPrefix, createdBy, sketchId)
  }

  return perGroupPrismWithLineage(oc, scope, groups, plane, directionVec, distance, tokenPrefix, createdBy, sketchId)
}

// ─── revolve (the revolve leaf's brep producer) ───

function makeAxis(oc: OccModule, scope: DisposeScope, origin: Vec3, direction: Vec3): OccShape {
  return scope.track(
    new oc.gp_Ax1_2(
      scope.track(new oc.gp_Pnt_3(origin[0], origin[1], origin[2])),
      scope.track(new oc.gp_Dir_4(direction[0], direction[1], direction[2])),
    ),
  ) as unknown as OccShape
}

/**
 * Revolve a single face around an axis (mirrors `revolve_face` / `ocp_revolve`).
 * Returns the raw solid living in `scope`; the caller owns its lifetime.
 */
export function revolveFace(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  axisOrigin: Vec3,
  axisDirection: Vec3,
  angleDeg: number,
): OccShape {
  if (angleDeg === 0) throw new Error('revolve angle must be non-zero')
  const ax = makeAxis(oc, scope, axisOrigin, axisDirection)
  const builder = scope.track(
    new oc.BRepPrimAPI_MakeRevol_1(face, ax as unknown as OccShape, (angleDeg * Math.PI) / 180, true),
  )
  return builder.Shape()
}

/**
 * Revolve profile loops around an axis and return (solid + construction-name
 * maps) (mirrors `revolve_profile_with_lineage`). Unlike extrude, revolve
 * treats `loops` as one face (loops[0] outer, the rest holes) -- no disjoint-group
 * fan-out -- and uses BRepPrimAPI_MakeRevol.Generated() for lineage. Tokens are
 * `@sketch_id/entity`.
 */
export function revolveProfileWithLineage(
  oc: OccModule,
  scope: DisposeScope,
  loops: LoopEdge[][],
  plane: PlaneLike,
  axisOrigin: Vec3,
  axisDirection: Vec3,
  angleDeg: number,
  sketchId = '',
  createdBy = '',
): LineageResult {
  const face = scope.track(sketchLoopsToFace(oc, scope, loops, plane))
  const ax = makeAxis(oc, scope, axisOrigin, axisDirection)
  const builder = scope.track(
    new oc.BRepPrimAPI_MakeRevol_1(face, ax as unknown as OccShape, (angleDeg * Math.PI) / 180, true),
  )
  const solid = builder.Shape()
  const lineage = buildPrismLineageMap(oc, scope, face, builder, loops, plane, createdBy, sketchId)
  prefixLineageMaps(lineage, sketchId ? `@${sketchId}/` : '@')
  // The profile face is dead once the lineage has been read off it.
  scope.release(face)
  return { solid, ...lineage }
}

// ─── sweep (the sweep leaf's brep producer) ───

/**
 * Try each transition mode's pipe shell in order and return the first one
 * that builds a solid cleanly. Pure loop, no face/profile dependency, so it
 * unit-tests with a stub `oc.BRepOffsetAPI_MakePipeShell` (no WASM needed).
 *
 * `lastError` is reset at the top of every attempt: a mode that throws sets
 * it, but the NEXT attempt clears it again before trying, so a mode that
 * fails silently (no exception, just `IsDone()`/`MakeSolid()` false) never
 * reports a stale exception message from an earlier, different mode.
 */
export function attemptPipeShellSweep(
  oc: OccModule,
  scope: DisposeScope,
  spineWire: OccShape,
  outerWire: OccShape,
  modes: OccEnumValue[],
): { result: { solid: OccShape; pipeBuilder: OccPipeShellBuilder } | null; lastError: unknown } {
  let lastError: unknown = null
  for (const mode of modes) {
    lastError = null
    const builder = scope.track(new oc.BRepOffsetAPI_MakePipeShell(spineWire))
    builder.SetTransitionMode(mode)
    builder.Add_1(outerWire, false, false)
    try {
      builder.Build()
      if (builder.IsDone() && builder.MakeSolid()) {
        return { result: { solid: builder.Shape(), pipeBuilder: builder }, lastError: null }
      }
    } catch (e) {
      lastError = e
    }
  }
  return { result: null, lastError }
}

/**
 * Sweep profile loops along a spine wire and return (solid + construction-name
 * maps) (mirrors `sweep_profile_with_lineage`). Only the profile's OUTER
 * boundary is swept (holes are not carried through the pipe shell, matching
 * Python); lineage still comes from MakePipeShell.Generated() over the face's
 * profile edges. The spine edges are pre-built world-space OCC edges. RightCorner
 * transition gives a clean mitre at sharp (C0) spine joints.
 */
export function sweepProfileWithLineage(
  oc: OccModule,
  scope: DisposeScope,
  loops: LoopEdge[][],
  plane: PlaneLike,
  spineEdges: OccShape[],
  sketchId = '',
  createdBy = '',
): LineageResult {
  if (loops.length === 0) throw new Error('sweep: no profile loops')
  if (spineEdges.length === 0) throw new Error('sweep: empty path')

  const face = scope.track(sketchLoopsToFace(oc, scope, loops, plane))
  // The raw wire inputs are consumed by their heal pass; the healed wires are
  // consumed by the pipe shell. All four would otherwise outlive the build.
  const rawSpineWire = scope.track(makeWire(oc, scope, spineEdges))
  const spineWire = scope.track(healWire(oc, scope, rawSpineWire))
  const rawOuterWire = scope.track(oc.BRepTools.OuterWire(face))
  const outerWire = scope.track(healWire(oc, scope, rawOuterWire))
  scope.release(rawSpineWire)
  scope.release(rawOuterWire)

  const modes = [
    oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner,
    oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_Transformed,
  ]
  const { result, lastError } = attemptPipeShellSweep(oc, scope, spineWire, outerWire, modes)
  if (lastError !== null) {
    const msg = extractErrorMessage(lastError)
    throw new Error(`sweep: BRepOffsetAPI_MakePipeShell failed: ${msg}`)
  }
  if (result === null) throw new Error('sweep: could not build a solid from the swept shell')
  const { solid, pipeBuilder } = result
  // The shell builder holds its own handles to both wires.
  scope.release(spineWire)
  scope.release(outerWire)

  const lineage = buildPrismLineageMap(oc, scope, face, pipeBuilder, loops, plane, createdBy, sketchId)
  prefixLineageMaps(lineage, sketchId ? `@${sketchId}/` : '@')
  scope.release(face)
  return { solid, ...lineage }
}
