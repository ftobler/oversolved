/**
 * Exact-as-available AABB of a shape, face by face.
 *
 * `BRepBndLib.AddOptimal` is exact for the surface over the face's *parameter
 * rectangle*, not over the face itself. A trim that removes part of the
 * rectangle without shrinking its bounds is invisible to it: a sphere sliced
 * into a slab keeps its parameter rectangle (the cuts are not latitude lines),
 * so the read includes the removed caps and reports the full radius. That is
 * the "bbox looser than the geometry" report.
 *
 * The face's own points are the ground truth: mesh nodes are on the surface and
 * boundary edges are exact, so a coordinate is 1-Lipschitz in 3D and any node
 * within one mesh edge of the optimal extreme could have been the extreme. An
 * optimal value farther away than that cannot lie on the face and is replaced
 * by the best point evidence. Faces without triangulation are meshed at the
 * render presets; the longest triangle edge is then the sampling scale.
 *
 * Planes, cylinders and cones are left exact by the same rule: their extremes
 * are on the boundary or sampled within one edge. Closed surfaces (sphere,
 * torus) keep their isolated interior extremes because the nodes sample them
 * within that scale.
 */

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'
import type { Bbox6 } from './measure'

type Axis = readonly [number, number]

// Render tessellation presets (solidToMesh defaults). A shape measured straight
// from a file arrives unmeshed; the evidence only needs the same sampling scale
// the viewport saw, so this is not a precision knob.
const EVIDENCE_DEFLECTION = 0.1
const EVIDENCE_ANGULAR_DEFLECTION = 0.1

interface MeshEvidence {
  min: [number, number, number]
  max: [number, number, number]
  // Longest triangle edge: how far a surface point can sit from its nearest
  // node along one coordinate.
  slack: number
}

function explore(oc: OccModule, scope: DisposeScope, shape: OccShape, kind: unknown): OccShape[] {
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, kind as never, oc.TopAbs_ShapeEnum.TopAbs_SHAPE))
  const out: OccShape[] = []
  for (; exp.More(); exp.Next()) out.push(scope.track(exp.Current()))
  return out
}

interface BoxReader {
  GetXmin(): number
  GetYmin(): number
  GetZmin(): number
  GetXmax(): number
  GetYmax(): number
  GetZmax(): number
}

function readBox(box: BoxReader): Bbox6 {
  return [
    box.GetXmin(), box.GetYmin(), box.GetZmin(),
    box.GetXmax(), box.GetYmax(), box.GetZmax(),
  ]
}

function union(a: Bbox6 | null, b: Bbox6): Bbox6 {
  if (a === null) return b
  return [
    Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]),
    Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5]),
  ]
}

function optimalBox(oc: OccModule, scope: DisposeScope, shape: OccShape): Bbox6 {
  const box = scope.track(new oc.Bnd_Box_1())
  oc.BRepBndLib.AddOptimal(shape, box, false, false)
  return readBox(box)
}

/** The union of the exact curve boxes of a face's boundary edges. */
function boundaryBox(oc: OccModule, scope: DisposeScope, face: OccShape): Bbox6 | null {
  let out: Bbox6 | null = null
  for (const edge of explore(oc, scope, face, oc.TopAbs_ShapeEnum.TopAbs_EDGE)) {
    const box = scope.track(new oc.Bnd_Box_1())
    oc.BRepBndLib.AddOptimal(edge, box, false, false)
    out = union(out, readBox(box))
  }
  return out
}

/** Node bounds and longest triangle edge of a face's triangulation. */
function meshEvidence(oc: OccModule, scope: DisposeScope, face: OccShape): MeshEvidence | null {
  const loc = scope.track(new oc.TopLoc_Location_1())
  let handle = scope.track(oc.BRep_Tool.Triangulation(face, loc))
  if (handle.IsNull()) {
    // Kept alive only for its side effect: the triangulation lives on the face.
    new oc.BRepMesh_IncrementalMesh_2(
      face, EVIDENCE_DEFLECTION, true, EVIDENCE_ANGULAR_DEFLECTION, false,
    ).delete()
    handle = scope.track(oc.BRep_Tool.Triangulation(face, loc))
  }
  const poly = handle.IsNull() ? null : handle.get()
  if (!poly) return null

  const trsf = scope.track(loc.Transformation())
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  const nodes: [number, number, number][] = []
  for (let i = 1; i <= poly.NbNodes(); i++) {
    const node = poly.Node(i)
    try {
      node.Transform(trsf)
      const point: [number, number, number] = [node.X(), node.Y(), node.Z()]
      nodes.push(point)
      for (let axis = 0; axis < 3; axis++) {
        if (point[axis] < min[axis]) min[axis] = point[axis]
        if (point[axis] > max[axis]) max[axis] = point[axis]
      }
    } finally {
      node.delete()
    }
  }
  if (nodes.length === 0) return null

  let slack = 0
  for (let i = 1; i <= poly.NbTriangles(); i++) {
    const tri = poly.Triangle(i)
    try {
      const corners = [tri.Value(1), tri.Value(2), tri.Value(3)]
      for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
        const p = nodes[corners[a] - 1]
        const q = nodes[corners[b] - 1]
        slack = Math.max(slack, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]))
      }
    } finally {
      tri.delete()
    }
  }
  return { min, max, slack }
}

/**
 * One axis of the face bbox. `optimal` is OCC's rectangle read and always an
 * outer bound; `sampled` and `boundary` are face points, so a value within one
 * `slack` of them is attainable and the optimal value is kept. A value farther
 * out belongs to the rectangle but not to the face; the largest face point on
 * that side is the tight answer.
 */
export function tightenAxis(
  optimal: Axis,
  sampled: Axis,
  boundary: Axis | null,
  slack: number,
): [number, number] {
  const evidence: Axis = [
    boundary === null ? sampled[0] : Math.min(sampled[0], boundary[0]),
    boundary === null ? sampled[1] : Math.max(sampled[1], boundary[1]),
  ]
  return [
    optimal[0] >= evidence[0] - slack ? optimal[0] : evidence[0],
    optimal[1] <= evidence[1] + slack ? optimal[1] : evidence[1],
  ]
}

/** A face's AABB, tightened to the trimmed region when OCC's read overshoots. */
export function faceBbox(oc: OccModule, scope: DisposeScope, face: OccShape): Bbox6 {
  const optimal = optimalBox(oc, scope, face)
  const mesh = meshEvidence(oc, scope, face)
  if (mesh === null) return optimal
  const boundary = boundaryBox(oc, scope, face)
  const tightened: Bbox6 = [0, 0, 0, 0, 0, 0]
  for (let axis = 0; axis < 3; axis++) {
    const [min, max] = tightenAxis(
      [optimal[axis], optimal[axis + 3]],
      [mesh.min[axis], mesh.max[axis]],
      boundary === null ? null : [boundary[axis], boundary[axis + 3]],
      mesh.slack,
    )
    tightened[axis] = min
    tightened[axis + 3] = max
  }
  return tightened
}

/**
 * A shape's AABB: the union of its faces' tightened boxes. Body shapes are
 * solids and shells, which their faces cover; a shape with no face (a wire, a
 * vertex) falls back to the plain optimal read.
 */
export function shapeBbox(oc: OccModule, scope: DisposeScope, shape: OccShape): Bbox6 {
  let out: Bbox6 | null = null
  for (const face of explore(oc, scope, shape, oc.TopAbs_ShapeEnum.TopAbs_FACE)) {
    out = union(out, faceBbox(oc, scope, scope.track(oc.TopoDS.Face_1(face))))
  }
  return out ?? optimalBox(oc, scope, shape)
}
