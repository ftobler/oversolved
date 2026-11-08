// @vitest-environment node
//
// Edge overlay density on a swept helix, against the real OCC mesher.
//
// The edge overlay used to come from a fixed 32-parameter sampler in
// `edgeToGeom`, whatever the edge's shape: a swept helix edge (4 BSpline
// knots per turn, see occ/helixEdge.ts) therefore drew about 5 straight
// segments per turn while the faces around it rendered smooth. The fix draws a
// spline edge from the polygon BRepMesh already stored for it on an adjacent
// face's triangulation, so the edge and the face share their vertices.
//
// These tests pin the two halves of the symptom: the density relative to the
// face triangulation, and the chord error against the true curve. Both fail on
// the old fixed-count sampler. They also pin that line/circle edges keep their
// analytic form (no new polyline payload).
//
// Skips when opencascade.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { HandleTable } from '../handleTable'
import { sweepProfileWithLineage } from '../prismLineage'
import { buildCurveEdge } from '../helixEdge'
import { descriptorFromRepo } from '../../features/helix'
import { Repository } from '../../query'
import { makeBox, makeCylinder, readSolidEdges, type Vec3 } from '../primitives'
import { solidToMesh } from '../tessellation'
import { extractProfileLoops } from '../../features/shared/profileLoops'
import { extractBrepMetadata, tessellateBodies } from '../../solveLocally'
import type { PlaneLike } from '../../features/shared/planes'
import type { EdgeData } from '@/types/cad'
import type { Body } from '../../types3d'
import type { OccHandle } from '../handleTable'
import type { OccModule, OccShape, OccSubShape } from '../occTypes'

const oc = await loadOcc()

// The Ex025 thread: r 0.5, pitch 0.4, a small trapezoid profile swept with the
// binormal mode a helix path uses.
const THREAD = { radius: 0.5, pitch: 0.4 }

function helixDescriptor(turns: number, radius: number, pitch: number) {
  return {
    kind: 'helix', origin: [0, 0, 0], axis: [0, 0, 1], ref_axis: [0, 0, 1], x_axis: [0, 1, 0],
    radius, pitch, turns, start_angle: -90, hand: 'right' as const,
  }
}

/** The profile plane through (radius, 0, 0): radial x, axial y. */
function profilePlane(radius: number): PlaneLike {
  return { origin: [radius, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 0, 1], normal: [0, 1, 0] }
}

/** A trapezoid in the profile plane, scaled about the helix start point. */
function trapezoidProfile(scale: number) {
  const s = scale
  return [{
    boundary: [
      { kind: 'line', id: 'l1', start: [-0.04 * s, -0.05 * s], end: [0.04 * s, -0.05 * s] },
      { kind: 'line', id: 'l2', start: [0.04 * s, -0.05 * s], end: [0.02 * s, 0.05 * s] },
      { kind: 'line', id: 'l3', start: [0.02 * s, 0.05 * s], end: [-0.02 * s, 0.05 * s] },
      { kind: 'line', id: 'l4', start: [-0.02 * s, 0.05 * s], end: [-0.04 * s, -0.05 * s] },
    ],
  }]
}

interface ThreadBody {
  handle: OccHandle
  solid: OccShape
}

/** Sweep the trapezoid along the helix, then (by default) mesh it in the render
 *  order: `tessellateBodies` meshes faces before it reads edges. */
function buildThread(
  occ: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  turns: number,
  radius: number,
  pitch: number,
  scale: number,
  mesh = true,
): ThreadBody {
  const loops = extractProfileLoops(trapezoidProfile(scale))
  const repo = new Repository()
  repo.register('_curve_hx1', helixDescriptor(turns, radius, pitch))
  const desc = descriptorFromRepo(repo, 'hx1')
  if (desc === null) throw new Error('test setup: no helix descriptor')
  const spine = scope.track(buildCurveEdge(occ, scope, desc))
  const { solid } = sweepProfileWithLineage(
    occ, scope, loops, profilePlane(radius), [spine], '', '', desc.axis,
  )
  const handle = table.register(solid)
  if (mesh) solidToMesh(occ, table, handle)
  return { handle, solid: table.get<OccShape>(handle) }
}

interface MeshedEdge {
  edge: OccSubShape
  // Node index chain on the face triangulation, as BRepMesh stored it.
  points: Vec3[]
}

/** Every edge polygon the mesher stored on the body's faces, one per edge. */
function meshedEdgePolygons(occ: OccModule, scope: DisposeScope, solid: OccShape): MeshedEdge[] {
  const out: MeshedEdge[] = []
  const E = occ.TopAbs_ShapeEnum
  const fexp = scope.track(new occ.TopExp_Explorer_2(solid, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; fexp.More(); fexp.Next()) {
    const face = scope.track(occ.TopoDS.Face_1(fexp.Current()))
    const loc = scope.track(new occ.TopLoc_Location_1())
    const triHandle = scope.track(occ.BRep_Tool.Triangulation(face, loc))
    if (triHandle.IsNull()) continue
    const tri = triHandle.get()
    if (!tri) continue
    const trsf = scope.track(loc.Transformation())
    const eexp = scope.track(new occ.TopExp_Explorer_2(face, E.TopAbs_EDGE, E.TopAbs_SHAPE))
    for (; eexp.More(); eexp.Next()) {
      const edge = scope.track(occ.TopoDS.Edge_1(eexp.Current())) as OccSubShape
      const polyHandle = scope.track(occ.BRep_Tool.PolygonOnTriangulation_1(edge, triHandle, loc))
      if (polyHandle.IsNull()) continue
      const poly = polyHandle.get()
      if (!poly) continue
      const indices = scope.track(poly.Nodes())
      const points: Vec3[] = []
      for (let i = indices.Lower(); i <= indices.Upper(); i++) {
        const node = tri.Node(indices.Value(i))
        node.Transform(trsf)
        points.push([node.X(), node.Y(), node.Z()])
        node.delete()
      }
      out.push({ edge, points })
    }
  }
  return out
}

function splineLengths(edges: EdgeData[]): number[] {
  return edges.flatMap((ed) => (ed.kind === 'spline' ? [ed.points.length] : []))
}

function longestSpline(edges: EdgeData[]): number {
  return Math.max(0, ...splineLengths(edges))
}

function samePoint(a: Vec3, b: Vec3): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9
}

/** The face polygon for the same edge `points` was published from, matched by
 *  its endpoints so the test can measure the same edge's true curve (the node
 *  counts differ from the old sampler, which is what these tests pin). */
function polygonFor(polygons: MeshedEdge[], points: Vec3[]): MeshedEdge {
  const first = points[0]
  const last = points[points.length - 1]
  const hit = polygons.find((p) =>
    p.points.length >= 2 &&
    ((samePoint(p.points[0], first) && samePoint(p.points[p.points.length - 1], last)) ||
     (samePoint(p.points[0], last) && samePoint(p.points[p.points.length - 1], first))))
  if (!hit) throw new Error('test setup: no face polygon matches the published edge polyline')
  return hit
}

/** Largest distance from a polyline segment's midpoint to the edge curve. The
 *  curve is densely sampled in parameter, so the nearest-sample distance is a
 *  tight lower bound on the true point-curve distance. */
function midpointDeviation(occ: OccModule, scope: DisposeScope, edge: OccShape, points: Vec3[]): number {
  const adaptor = scope.track(new occ.BRepAdaptor_Curve_2(edge))
  const u0 = adaptor.FirstParameter()
  const u1 = adaptor.LastParameter()
  const truth: Vec3[] = []
  const SAMPLES = 4000
  for (let i = 0; i <= SAMPLES; i++) {
    const p = adaptor.Value(u0 + ((u1 - u0) * i) / SAMPLES)
    truth.push([p.X(), p.Y(), p.Z()])
    p.delete()
  }
  let worst = 0
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]
    const b = points[i + 1]
    const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
    let nearest = Infinity
    for (const t of truth) {
      const d = Math.hypot(t[0] - mid[0], t[1] - mid[1], t[2] - mid[2])
      if (d < nearest) nearest = d
    }
    worst = Math.max(worst, nearest)
  }
  return worst
}

describe.skipIf(!oc)('swept helix edge tessellation (real OCC)', () => {
  it('draws a one-turn helix edge on the face triangulation boundary', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const { solid } = buildThread(oc!, scope, table, 1, THREAD.radius, THREAD.pitch, 1)
      const polygons = meshedEdgePolygons(oc!, scope, solid)
      const edges = readSolidEdges(oc!, scope, solid).map((r) => r.ed)
      const densest = edges.find((ed) => ed.kind === 'spline' && ed.points.length === longestSpline(edges))
      if (!densest || densest.kind !== 'spline') throw new Error('test setup: no spline edge')
      const polygon = polygonFor(polygons, densest.points)

      // The face is genuinely meshed: one turn of the helix covers many facets.
      expect(polygon.points.length).toBeGreaterThan(20)
      // The old fixed-32 sampler gave 33 points for the whole edge, whatever
      // its length; the edge overlay now carries the face's own polyline.
      expect(densest.points.length).toBeGreaterThanOrEqual(polygon.points.length)

      // Point for point (up to direction) the edge overlay is the polygon the
      // mesher stored on the face: the two share every vertex, so no gap can
      // open between the edge line and its face boundary.
      const forward = samePoint(densest.points[0], polygon.points[0])
      let worst = 0
      densest.points.forEach((p, i) => {
        const q = polygon.points[forward ? i : polygon.points.length - 1 - i]
        worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]))
      })
      expect(worst).toBeLessThan(1e-9)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  it('no longer draws about five segments per turn on a swept helix', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const turns = 6
      const { solid } = buildThread(oc!, scope, table, turns, THREAD.radius, THREAD.pitch, 1)
      const edges = readSolidEdges(oc!, scope, solid).map((r) => r.ed)
      const lengths = splineLengths(edges)
      // Before the fix every spline edge was 33 points (32 segments) regardless
      // of the six turns it spanned: 5.3 segments per turn, the reported symptom.
      expect(longestSpline(edges)).toBeGreaterThanOrEqual(20 * turns)
      // The trapezoid's straight swept joins are BSplines too, but geometrically
      // straight: they now publish the mesher's two-node polygon instead of 33
      // collinear points, so the reply shrinks where it used to be wasted.
      expect(lengths.filter((n) => n === 2).length).toBeGreaterThanOrEqual(8)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  it('keeps segment midpoints under the mesher deflection on a tight helix (r 0.5)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const { solid } = buildThread(oc!, scope, table, 1, THREAD.radius, THREAD.pitch, 1)
      const polygons = meshedEdgePolygons(oc!, scope, solid)
      const edges = readSolidEdges(oc!, scope, solid).map((r) => r.ed)
      const published = edges.find((ed) => ed.kind === 'spline' && ed.points.length === longestSpline(edges))
      if (!published || published.kind !== 'spline') throw new Error('test setup: no spline edge')
      const { edge } = polygonFor(polygons, published.points)
      // The render mesh deflects by 0.1 (relative), so an edge drawn on its
      // triangulation is at least that fine. The old fixed-32 chord error was
      // ~0.0024 units here (0.48% of r), so this bound also pins the fix.
      expect(midpointDeviation(oc!, scope, edge, published.points)).toBeLessThan(0.002 * THREAD.radius)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  it('keeps segment midpoints under the mesher deflection on a large helix (r 50)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const { solid } = buildThread(oc!, scope, table, 1, 50, 3, 10)
      const polygons = meshedEdgePolygons(oc!, scope, solid)
      const edges = readSolidEdges(oc!, scope, solid).map((r) => r.ed)
      const published = edges.find((ed) => ed.kind === 'spline' && ed.points.length === longestSpline(edges))
      if (!published || published.kind !== 'spline') throw new Error('test setup: no spline edge')
      const { edge } = polygonFor(polygons, published.points)
      // Old fixed-32: ~0.24 units of chord error at this radius.
      expect(midpointDeviation(oc!, scope, edge, published.points)).toBeLessThan(0.002 * 50)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  it('leaves straight and circular edges analytic (no polyline payload)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const boxHandle = table.register(scope.track(makeBox(oc!, scope, 2, 3, 4)))
      solidToMesh(oc!, table, boxHandle)
      const boxEdges = readSolidEdges(oc!, scope, table.get<OccShape>(boxHandle)).map((r) => r.ed)
      expect(boxEdges.map((ed) => ed.kind)).toEqual(Array(12).fill('line'))

      const cylHandle = table.register(scope.track(makeCylinder(oc!, scope, [0, 0, 0], [0, 0, 1], 3, 5)))
      solidToMesh(oc!, table, cylHandle)
      const cylKinds = readSolidEdges(oc!, scope, table.get<OccShape>(cylHandle)).map((r) => r.ed.kind)
      expect(cylKinds.filter((k) => k === 'circle').length).toBe(2)
      expect(cylKinds).not.toContain('spline')
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  it('names a spline edge the same off metadata and off the render mesh', () => {
    // The edge query carries a classifier of one representative point, which a
    // spline now reads from the mesher polyline instead of the old 32-sample.
    // The mesh-free metadata pass must still agree with the render pass, or a
    // pick would look for a query the bundle never carries.
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const { handle } = buildThread(oc!, scope, table, 2, THREAD.radius, THREAD.pitch, 1, false)
      const body: Body = {
        id: 'body_e1', created_by: 'e1', modified_by: [], shape: handle,
        sketch_id: '', brep_diff: null, profile_queries: [],
      }
      const meta = extractBrepMetadata(oc!, table, { body_e1: body }).body_e1 as { edge_queries: string[] }
      const render = tessellateBodies(oc!, table, { body_e1: body }).body_e1 as { edge_queries: string[] }
      expect(meta.edge_queries.length).toBe(12)
      expect(render.edge_queries).toEqual(meta.edge_queries)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })
})
