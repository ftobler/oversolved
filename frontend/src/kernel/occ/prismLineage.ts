// Port of the extrude brep producer in geometry_tessellation.py:
// `sketch_loops_to_face`, `_entity_to_occ_edge_map`, `_build_prism_lineage_map`,
// `extrude_profile_with_lineage`. This is the OCC adapter the extrude leaf
// (features/extrude.ts) calls to turn 2D profile loops into a solid plus the
// per-face / per-edge lineage keyed by copy-stable geometry hash.
//
// Lineage keying mirrors lineage-stable-keying.md: faces/edges are keyed by
// their geometry hash, not the copy-fragile OCC subshape hash, so the tokens
// survive the shape copies the build pipeline does. The profile-edge -> lateral
// face association comes from BRepPrimAPI_MakePrism.Generated() (the lineage
// sharp edge), drained via Size/First_1/RemoveFirst like every other list in
// this build (no iterator binding).

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccSubShape, OccListOfShape } from './occTypes'
import type { PlaneLike } from '../features/shared'
import {
  faceCentroid,
  faceNormal,
  edgeToGeom,
  makeArcEdge,
  makeLineEdge,
  makeWire,
  makeFaceFromWire,
  type Vec3,
} from './primitives'
import { faceGeometryHash, edgeGeometryHash } from '../geomHash'
import { classifyLoops, type LoopEdge } from '../profileLoops'
import { booleanWithHistory } from './booleans'

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

/** Drain a TopTools_ListOfShape into an array (Size/First_1/RemoveFirst). */
function drainList(scope: DisposeScope, list: OccListOfShape): OccShape[] {
  const out: OccShape[] = []
  const n = list.Size()
  for (let i = 0; i < n; i++) {
    out.push(scope.track(list.First_1()))
    list.RemoveFirst()
  }
  return out
}

function faceGh(oc: OccModule, scope: DisposeScope, face: OccShape): string {
  return faceGeometryHash(faceCentroid(oc, scope, face), faceNormal(oc, scope, face))
}

function edgeGh(oc: OccModule, scope: DisposeScope, edge: OccShape): string | null {
  try {
    const { ed } = edgeToGeom(oc, scope, edge)
    return edgeGeometryHash(ed as unknown as Record<string, unknown>)
  } catch {
    return null
  }
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

function buildWire(oc: OccModule, scope: DisposeScope, plane: PlaneLike, loop: LoopEdge[]): OccShape {
  const circle = fullCircleOf(loop)
  if (circle !== null) return makeWire(oc, scope, [buildArcEdge(oc, scope, plane, circle)])
  const edges: OccShape[] = []
  for (const edge of loop) {
    if ((edge['kind'] as string) === 'arc') {
      edges.push(buildArcEdge(oc, scope, plane, edge))
    } else {
      const p1 = uvTo3d(plane, edge['start'] as number[])
      const p2 = uvTo3d(plane, edge['end'] as number[])
      edges.push(makeLineEdge(oc, scope, p1, p2))
    }
  }
  return makeWire(oc, scope, edges)
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
  const outerWire = buildWire(oc, scope, plane, loops[0])
  const holeWires = loops.slice(1).map((hole) => buildWire(oc, scope, plane, hole))
  return makeFaceFromWire(oc, scope, outerWire, holeWires)
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
    const sp = ad.Value(ad.FirstParameter())
    const ep = ad.Value(ad.LastParameter())
    const { ed } = edgeToGeom(oc, scope, e)
    return {
      sp: [sp.X(), sp.Y(), sp.Z()] as number[],
      ep: [ep.X(), ep.Y(), ep.Z()] as number[],
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

/**
 * (face_lineage, edge_lineage) for an extruded solid, keyed by geometry hash
 * (mirrors `_build_prism_lineage_map`). Tokens are the raw profile entity ids
 * (the caller prepends `@sketch_id/`). Every solid face and edge gets an entry,
 * possibly with an empty token list (caps and their rims), matching Python.
 */
function buildPrismLineageMap(
  oc: OccModule,
  scope: DisposeScope,
  occFace: OccShape,
  prismBuilder: { Shape(): OccShape; Generated(s: OccShape): OccListOfShape },
  loops: LoopEdge[][],
  plane: PlaneLike,
): { faceLineage: Record<string, string[]>; edgeLineage: Record<string, string[]> } {
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

  // solid face -> tokens, keyed by geometry hash.
  const faceLineage: Record<string, string[]> = {}
  const adjacency: Record<string, Set<string>> = {}  // edge gh -> set of adjacent face gh
  const faceExp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; faceExp.More(); faceExp.Next()) {
    const sf = scope.track(oc.TopoDS.Face_1(faceExp.Current()))
    const gh = faceGh(oc, scope, sf)
    const match = genFaces.find((gf) => (sf as OccSubShape).IsSame(gf.face))
    faceLineage[gh] = match !== undefined ? [match.eid] : []
    const eExp = scope.track(new oc.TopExp_Explorer_2(sf, E.TopAbs_EDGE, E.TopAbs_SHAPE))
    for (; eExp.More(); eExp.Next()) {
      const egh = edgeGh(oc, scope, scope.track(oc.TopoDS.Edge_1(eExp.Current())))
      if (egh === null) continue
      ;(adjacency[egh] ??= new Set()).add(gh)
    }
  }

  // solid edge -> tokens, gathered from adjacent faces' tokens.
  const edgeLineage: Record<string, string[]> = {}
  for (const [egh, faceGhs] of Object.entries(adjacency)) {
    const tokens: string[] = []
    for (const fgh of faceGhs) {
      for (const eid of faceLineage[fgh] ?? []) {
        if (!tokens.includes(eid)) tokens.push(eid)
      }
    }
    edgeLineage[egh] = tokens
  }

  return { faceLineage, edgeLineage }
}

function prefixTokens(lineage: Record<string, string[]>, prefix: string): void {
  for (const key of Object.keys(lineage)) {
    lineage[key] = lineage[key].map((t) => (t.startsWith('@') ? t : prefix + t))
  }
}

/**
 * Extrude profile loops to a solid and return (solid, faceLineage, edgeLineage)
 * (mirrors `extrude_profile_with_lineage`). Disjoint loop groups are extruded
 * separately and fused; nested loops become holes. The returned solid is raw and
 * lives in `scope` -- the caller registers/disposes it (typically via
 * applyBodyOperation). Lineage tokens are `@sketch_id/entity`.
 */
export function extrudeProfileWithLineage(
  oc: OccModule,
  scope: DisposeScope,
  loops: LoopEdge[][],
  plane: PlaneLike,
  directionVec: Vec3,
  distance: number,
  sketchId = '',
): { solid: OccShape; faceLineage: Record<string, string[]>; edgeLineage: Record<string, string[]> } {
  const groups = classifyLoops(loops)
  if (groups.length === 0) throw new Error('no loops to extrude')

  const tokenPrefix = sketchId ? `@${sketchId}/` : '@'
  let solid: OccShape | null = null
  const faceLineage: Record<string, string[]> = {}
  const edgeLineage: Record<string, string[]> = {}

  for (const [outer, holes] of groups) {
    const face = sketchLoopsToFace(oc, scope, [outer, ...holes], plane)
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
    )
    const part = builder.Shape()
    const lineage = buildPrismLineageMap(oc, scope, face, builder, [outer, ...holes], plane)
    prefixTokens(lineage.faceLineage, tokenPrefix)
    prefixTokens(lineage.edgeLineage, tokenPrefix)
    Object.assign(faceLineage, lineage.faceLineage)
    Object.assign(edgeLineage, lineage.edgeLineage)

    solid = solid === null ? part : booleanWithHistory(oc, scope, solid, part, 'fuse').shape
  }

  if (solid === null) throw new Error('no loops to extrude')
  return { solid, faceLineage, edgeLineage }
}
