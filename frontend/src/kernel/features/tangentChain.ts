// The tangent-continuous (G1) chain a fillet or chamfer pick belongs to.
//
// OCC's BRepFilletAPI_MakeFillet / MakeChamfer do not blend only the edges they
// are handed: they continue across a joint where two edges meet tangentially,
// the default every CAD tool uses. The document lists the picks alone, so one
// pick on a rounded loop silently edits the loop (Ex020: one top edge of a
// filleted plate took the whole 8-edge loop). The kernel behaviour is intended,
// so the leaf reports what it took instead of refusing it.
//
// The joint predicate is topology plus tangency: two edges continue each other
// when they share a vertex (the kernel's own statement that the joint is one
// point) and the tangents sampled at that vertex are collinear.

import { withTransientScope, type DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import { canonicalEdges, canonicalVertices } from '../occ/bodyNames'
import { SubShapeDedup, SubShapeMap, SubShapeMultiIndex } from '../occ/subshapeIdentity'
import { swallowUnlessTrap } from '../errors'
import { TOL_MOVE_FACE_TANGENT } from '../solverConstants'

type Vec3 = [number, number, number]

/** The point and unit tangent at one end of an edge, the tangent pointing into
 *  the edge. */
interface EdgeEnd {
  at: Vec3
  tangent: Vec3
}

/**
 * The point and unit tangent at each end of an edge, sampled along the curve
 * (the adaptor's D1 is not bound in this build). A closed edge yields two ends
 * at the same point with opposite tangents; a curve the adaptor cannot read
 * throws here, and `tangentChain` reads that as no joint.
 */
export function endTangents(oc: OccModule, scope: DisposeScope, edge: OccShape): EdgeEnd[] {
  const curve = scope.track(new oc.BRepAdaptor_Curve_2(edge))
  const u0 = curve.FirstParameter()
  const u1 = curve.LastParameter()
  const h = (u1 - u0) * 1e-4
  const point = (u: number): Vec3 => {
    const p = curve.Value(u)
    const out: Vec3 = [p.X(), p.Y(), p.Z()]
    p.delete()
    return out
  }
  const ends: EdgeEnd[] = []
  for (const [u, step] of [[u0, h], [u1, -h]] as const) {
    const at = point(u)
    const next = point(u + step)
    const d: Vec3 = [next[0] - at[0], next[1] - at[1], next[2] - at[2]]
    const len = Math.hypot(d[0], d[1], d[2])
    if (len > 1e-15) ends.push({ at, tangent: [d[0] / len, d[1] / len, d[2] / len] })
  }
  return ends
}

/** The picks' G1 chain on one shape, counted. */
export interface TangentChainCount {
  // Edges in the chain, the picks included.
  chain: number
  // How many distinct edges were handed in as picks.
  picked: number
}

const distance = (a: Vec3, b: Vec3): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/**
 * Whether the two unit tangents lie on one line. Each points into its own edge,
 * so a chain joint is the anti-parallel case; a closed edge carries both of its
 * own ends at one point and the pairing cannot tell which side attaches, so the
 * test stays sign-free. A kink is not a joint at any angle above the tolerance.
 */
function collinear(a: Vec3, b: Vec3): boolean {
  const cross: Vec3 = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
  return Math.hypot(cross[0], cross[1], cross[2]) <= TOL_MOVE_FACE_TANGENT
}

/**
 * The pair of ends closest to each other, one from each edge. The two edges are
 * already known to share a vertex, and a B-rep splits an edge at every vertex it
 * passes, so each meets that vertex at one of its own ends: the nearest pair IS
 * the joint. Null only when an edge has no readable end.
 */
function jointEnds(a: readonly EdgeEnd[], b: readonly EdgeEnd[]): [EdgeEnd, EdgeEnd] | null {
  let best: [EdgeEnd, EdgeEnd] | null = null
  let bestGap = Infinity
  for (const ea of a) {
    for (const eb of b) {
      const gap = distance(ea.at, eb.at)
      if (gap < bestGap) {
        bestGap = gap
        best = [ea, eb]
      }
    }
  }
  return best
}

/**
 * Count the tangent-continuous chain every pick drags into the blend.
 *
 * Walks outward from the picks over shared vertices: an edge joins the chain
 * when it shares a vertex with a chain member and its tangent there is collinear
 * with the member's. The walk is transitive (a line joins an arc, the arc joins
 * the next line), which is exactly how far OCC carries the blend. `picked` is
 * deduped, so the same edge named twice counts once; the caller reports
 * `chain - picked` as the edges the user never picked.
 *
 * The walk mints sub-shape proxies and one curve adaptor per edge it visits, and
 * the answer is plain numbers, so it runs in its own transient scope rather than
 * leaving those handles on the document's solve scope until the solve ends.
 */
export function tangentChain(
  oc: OccModule,
  shape: OccShape,
  picked: readonly OccShape[],
): TangentChainCount {
  if (picked.length === 0) return { chain: 0, picked: 0 }
  return withTransientScope((scope) => countChain(oc, scope, shape, picked))
}

function countChain(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  picked: readonly OccShape[],
): TangentChainCount {
  // Vertex -> the edges meeting there, built once: a pick on a large imported
  // body then costs a walk of that body's vertices, not a pairwise edge scan.
  const incident = new SubShapeMultiIndex<OccShape>()
  for (const edge of canonicalEdges(oc, scope, shape)) {
    for (const vertex of canonicalVertices(oc, scope, edge)) incident.add(vertex, edge as OccShape)
  }

  // Keyed by topological identity: the picked proxy and the canonical proxy of
  // the same edge are two handles to one TShape.
  const endsCache = new SubShapeMap<EdgeEnd[]>()
  const endsOf = (edge: OccShape): EdgeEnd[] => {
    const key = edge as OccSubShape
    const cached = endsCache.get(key)
    if (cached !== undefined) return cached
    let ends: EdgeEnd[] = []
    try {
      ends = endTangents(oc, scope, edge)
    } catch (e) {
      swallowUnlessTrap(e)
    }
    endsCache.set(key, ends)
    return ends
  }

  const inChain = new SubShapeDedup()
  const picks = new SubShapeDedup()
  const queue: OccShape[] = []
  let chainSize = 0
  let pickedSize = 0
  for (const pick of picked) {
    if (!picks.add(pick as OccSubShape)) continue
    pickedSize++
    if (inChain.add(pick as OccSubShape)) {
      chainSize++
      queue.push(pick)
    }
  }

  while (queue.length > 0) {
    const edge = queue.pop() as OccShape
    const own = endsOf(edge)
    if (own.length === 0) continue
    for (const vertex of canonicalVertices(oc, scope, edge)) {
      for (const next of incident.get(vertex)) {
        const key = next as OccSubShape
        if (inChain.has(key)) continue
        const joint = jointEnds(own, endsOf(next))
        if (joint === null || !collinear(joint[0].tangent, joint[1].tangent)) continue
        inChain.add(key)
        chainSize++
        queue.push(next)
      }
    }
  }
  return { chain: chainSize, picked: pickedSize }
}
