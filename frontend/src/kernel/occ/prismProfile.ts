// `sketch_loops_to_face` and the hole-circle canonicalization the multi-group
// extrude path leans on. This module turns 2D profile boundary-edge loops into
// a planar OCC face, and rebuilds a hole wire that is a closed chain of arcs on
// one circle as a single canonical closed-circle edge.
//
// It is split out of prismLineage.ts so the lineage/brep producer reads as
// orchestration over a small profile builder instead of carrying the whole
// loop -> wire -> face construction inline.

import type { DisposeScope } from './disposeScope'
import { extractErrorMessage, extractOccErrorMessage } from '../errors'
import { isDevBuild } from '../isDevBuild'
import {
  ANCHORED_KINDS,
  describeProfile,
  formatGap,
  formatProfileReport,
} from '../profileDiagnostics'
import type { OccModule, OccShape, OccSubShape, OccCircle } from './occTypes'
import type { PlaneLike } from '../features/shared/planes'
import {
  edgeToGeom,
  makeArcEdge,
  makeCircleEdge,
  makeLineEdge,
  makeBezierEdge,
  makeEllipseEdge,
  makeWire,
  makeFaceFromWire,
  wireEndpointGaps,
  type Vec3,
} from './primitives'
import { uvTo3d } from './prismGeometry'
import type { LoopEdge } from '../profileLoops'
import { copyShape } from './transforms'

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

// ─── hole-circle canonicalization ───

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
  for (; exp.More(); exp.Next()) {
    const raw = scope.track(exp.Current())
    edges.push(scope.track(oc.TopoDS.Edge_1(raw)))
  }
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
  // coordinates into plain arrays and delete the proxies BEFORE makeCircleEdge
  // runs, so a throw from makeCircleEdge cannot strand the proxies (the
  // previous delete-after call left them leaking on the throw path).
  const loc = circ.Location()
  const axis = circ.Axis()
  const axDir = axis.Direction()
  const xax1 = circ.XAxis()
  const xDir = xax1.Direction()
  const locCoords: Vec3 = [loc.X(), loc.Y(), loc.Z()]
  const axDirCoords: Vec3 = [axDir.X(), axDir.Y(), axDir.Z()]
  const xDirCoords: Vec3 = [xDir.X(), xDir.Y(), xDir.Z()]
  loc.delete()
  axis.delete()
  axDir.delete()
  xax1.delete()
  xDir.delete()
  const edge = scope.track(makeCircleEdge(oc, scope, locCoords, axDirCoords, xDirCoords, radius))
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
export function canonicalizeFaceCircles(oc: OccModule, scope: DisposeScope, face: OccShape): OccShape {
  const E = oc.TopAbs_ShapeEnum
  const outerWire = scope.track(oc.BRepTools.OuterWire(face))
  const holes: OccShape[] = []
  const wexp = scope.track(new oc.TopExp_Explorer_2(face, E.TopAbs_WIRE, E.TopAbs_SHAPE))
  for (; wexp.More(); wexp.Next()) {
    const raw = scope.track(wexp.Current())
    const w = scope.track(oc.TopoDS.Wire_1(raw))
    if (!(w as OccSubShape).IsSame(outerWire)) holes.push(w)
  }
  const rebuilt = canonicalizeFaceCirclesWith(oc, scope, outerWire, holes)
  // Both branches return an UNTRACKED face the caller owns: the rebuilt one from
  // makeFaceFromWire, and, when nothing needed canonicalizing, a copy of the
  // entrance face rather than the entrance face itself, so the caller never has
  // to ask which branch it took.
  return rebuilt ?? copyShape(oc, scope, face)
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
  const canonicalHoles: { wire: OccShape; owned: boolean }[] = []
  for (const w of holes) {
    const canon = collapseCircleWire(oc, scope, w)
    if (canon !== null) {
      changed = true
      canonicalHoles.push({ wire: canon, owned: true })
    } else {
      canonicalHoles.push({ wire: w, owned: false })
    }
  }
  if (!changed) return null
  // The rebuilt canonical wires are folded into the face; only the wires we
  // built (owned) are released here. The caller's wires are not ours to free.
  try {
    return makeFaceFromWire(oc, scope, outerWire, canonicalHoles.map((h) => h.wire))
  } finally {
    for (const h of canonicalHoles) if (h.owned) scope.release(h.wire)
  }
}
