// PURE -- no doc mutation. Which way a sketch offset goes for each selected
// entity, so a positive distance means one side of a closed loop whatever the
// loop's winding or provenance, and one side of the WALK along an open chain.
//
// The seed rule alone (offsetSeed: a line moves along the left normal of its
// start->end direction, a circle or arc grows its radius) is winding-dependent:
// +2 went inward on a CCW triangle (birdhouse F3) and outward on a projected rim
// whose edges ran the other way (Case_Seam_Lip F6). When the selection closes
// into loops, each entity's seed sign is corrected so a positive distance moves
// it OUT of the region the loops bound (even-odd, so a selected inner loop is a
// hole and its positive offset shrinks the hole), matching OpenSCAD's
// `offset(r>0)` and CadQuery's positive `offset2D`.
//
// An open chain bounds no region, but it still has a walk, and +d is the LEFT
// of that walk for every entity. Trying to keep the per-entity rule failed on a
// left-turning bend: the lines moved inside the turn while the CCW arc copy grew
// outside it, the tangent joints between the copies were unsatisfiable, and the
// solver dragged the authored sources to compromise. The walk starts at the
// chain end of the first listed source that is an end and runs to the other
// end; an arc walked with its stored CCW sweep has the centre on its left, so
// its copy shrinks for +d, while an arc walked against it grows. A selection
// that branches (a vertex of degree three or more) keeps the per-entity rule,
// and a component that is a closed loop or a lone entity does the same: there
// is no unambiguous walk to follow.

import { endpointVertices, offsetCorners } from './offsetProfile'
import { inside, probeExtent, segmentsOf, type ProfileSource } from './profileProbe'
import { TOL_TOPOLOGY_MERGE } from '@/kernel/solverConstants'

type Point = [number, number]

// The offset rule's sources are the shared profile probe's sources. The alias
// keeps this module's callers unchanged while the even-odd soup lives in one
// place.
export type OffsetSource = ProfileSource

/** The constraint shape the chain graph reads: only coincident vertex refs
 *  matter, so any document constraint row qualifies. */
export interface OffsetSideConstraint {
  kind?: string
  a?: unknown
  b?: unknown
}

export interface OffsetSidePlan {
  /** The factor each source's seed distance takes, empty when the per-entity
   *  seed rule applies. */
  factors: Map<string, number>
  /** The open selection branches at a vertex, so the per-entity seed rule is in
   *  use; the caller tells the user the side is per entity. */
  branches: boolean
}

type VertexKey = 'start' | 'end'

interface ChainEndpoint {
  entityIndex: number
  entityId: string
  vertexKey: VertexKey
  point: Point
}

interface ChainEdge {
  // Endpoint indices, in the entity's own start -> end order.
  a: number
  b: number
}

// Arcs and circles are polygonized for the inside test by the shared probe; an
// even count puts a vertex on the arc's mid angle, the point the side probe
// starts from, so the probe sits on the true curve rather than on a chord.
function arcSweepDeg(a0: number, a1: number): number {
  const sweep = (((a1 - a0) % 360) + 360) % 360
  return sweep === 0 ? 360 : sweep
}

function arcPoint(cx: number, cy: number, r: number, deg: number): Point {
  const t = (deg * Math.PI) / 180
  return [cx + r * Math.cos(t), cy + r * Math.sin(t)]
}

/** Every line/arc endpoint meets an endpoint of another selected entity. */
function closesIntoLoops(sources: readonly OffsetSource[]): boolean {
  const vertices: Array<{ id: string; point: Point }> = []
  for (const s of sources) {
    if (s.kind !== 'line' && s.kind !== 'arc') continue
    for (const v of endpointVertices(s.kind, s.params)) vertices.push({ id: s.id, point: v.point })
  }
  return vertices.every((v, i) => vertices.some((w, j) =>
    j !== i && w.id !== v.id
      && Math.hypot(w.point[0] - v.point[0], w.point[1] - v.point[1]) <= TOL_TOPOLOGY_MERGE))
}

/** Union-find over endpoint records, so a coincident chain and a coordinate-
 *  welded one produce the same joint graph. */
function unionFind(size: number) {
  const parent = Array.from({ length: size }, (_, i) => i)
  const find = (i: number): number => {
    let root = i
    while (parent[root] !== root) root = parent[root]
    while (parent[i] !== root) {
      const next = parent[i]
      parent[i] = root
      i = next
    }
    return root
  }
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  return { find, union }
}

/** The factors of a simple open chain, or an empty plan when this selection has
 *  no single walk to follow. */
function openChainPlan(
  sources: readonly OffsetSource[],
  constraints: readonly OffsetSideConstraint[],
): OffsetSidePlan {
  const empty: OffsetSidePlan = { factors: new Map(), branches: false }
  const endpoints: ChainEndpoint[] = []
  const edges = new Map<number, ChainEdge>()
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index]
    if (source.kind !== 'line' && source.kind !== 'arc') continue
    const vertices = endpointVertices(source.kind, source.params)
    if (vertices.length !== 2) continue
    const first = endpoints.length
    for (const vertex of vertices) {
      endpoints.push({
        entityIndex: index,
        entityId: source.id,
        vertexKey: vertex.vertexKey as VertexKey,
        point: vertex.point,
      })
    }
    edges.set(index, { a: first, b: first + 1 })
  }
  if (edges.size === 0) return empty

  // The chain graph's joints are exactly the ones the corner reconnection
  // rebuilds: coordinate-welded endpoints and explicit vertex coincidents.
  const { find, union } = unionFind(endpoints.length)
  for (let i = 0; i < endpoints.length; i++) {
    for (let j = i + 1; j < endpoints.length; j++) {
      if (endpoints[i].entityId === endpoints[j].entityId) continue
      if (Math.hypot(
        endpoints[i].point[0] - endpoints[j].point[0],
        endpoints[i].point[1] - endpoints[j].point[1],
      ) > TOL_TOPOLOGY_MERGE) continue
      union(i, j)
    }
  }
  const endpointAt = new Map<string, number>()
  endpoints.forEach((endpoint, index) => endpointAt.set(`${endpoint.entityId}:${endpoint.vertexKey}`, index))
  const selectedIds = [...new Set(endpoints.map(endpoint => endpoint.entityId))]
  for (const corner of offsetCorners(selectedIds, [...constraints])) {
    const a = endpointAt.get(`${corner.a.entityId}:${corner.a.vertexKey}`)
    const b = endpointAt.get(`${corner.b.entityId}:${corner.b.vertexKey}`)
    if (a !== undefined && b !== undefined) union(a, b)
  }

  // Degree is the number of entity ends meeting at a cluster. Three means a
  // branch: no single walk, and the caller keeps the per-entity rule.
  const degree = new Map<number, number>()
  for (let i = 0; i < endpoints.length; i++) {
    const root = find(i)
    degree.set(root, (degree.get(root) ?? 0) + 1)
  }
  if ([...degree.values()].some(d => d >= 3)) return { factors: new Map(), branches: true }

  const clusterEdges = new Map<number, number[]>()
  for (const [index, edge] of edges) {
    for (const endpointIndex of [edge.a, edge.b]) {
      const root = find(endpointIndex)
      const list = clusterEdges.get(root) ?? []
      list.push(index)
      clusterEdges.set(root, list)
    }
  }

  const factors = new Map<string, number>()

  // Each connected component is an independent chain. A component with one
  // entity, or with no degree-1 end (a closed loop), has no walk to follow and
  // falls back to the seed rule; `closesIntoLoops` already handled a selection
  // that is all loops.
  const seen = new Set<number>()
  for (const startEdge of edges.keys()) {
    if (seen.has(startEdge)) continue
    const componentEdges: number[] = []
    const componentClusters = new Set<number>()
    const queue = [startEdge]
    seen.add(startEdge)
    while (queue.length > 0) {
      const edgeIndex = queue.pop()!
      componentEdges.push(edgeIndex)
      const edge = edges.get(edgeIndex)!
      for (const endpointIndex of [edge.a, edge.b]) {
        const root = find(endpointIndex)
        componentClusters.add(root)
        for (const next of clusterEdges.get(root) ?? []) {
          if (seen.has(next)) continue
          seen.add(next)
          queue.push(next)
        }
      }
    }

    const ends = [...componentClusters].filter(root => degree.get(root) === 1)
    if (componentEdges.length < 2 || ends.length !== 2) continue

    // Rule 2: start at the chain end of the first listed source that is an end.
    let anchor: number | undefined
    for (let index = 0; index < sources.length; index++) {
      if (!componentEdges.includes(index)) continue
      const edge = edges.get(index)!
      if (degree.get(find(edge.a)) === 1) { anchor = find(edge.a); break }
      if (degree.get(find(edge.b)) === 1) { anchor = find(edge.b); break }
    }
    if (anchor === undefined) {
      // Unreachable for a path whose every edge is a listed source, but keep the
      // documented fallback deterministic: the end nearest the first listed
      // source's midpoint.
      const firstIndex = Math.min(...componentEdges)
      const own = endpoints.filter(endpoint => endpoint.entityIndex === firstIndex)
      const near: Point = [
        (own[0].point[0] + own[1].point[0]) / 2,
        (own[0].point[1] + own[1].point[1]) / 2,
      ]
      let bestD = Infinity
      for (const root of ends) {
        const point = clusterPoint(root, endpoints, find)
        if (point === null) continue
        const d = Math.hypot(point[0] - near[0], point[1] - near[1])
        if (d < bestD) { bestD = d; anchor = root }
      }
      anchor ??= ends[0]
    }

    const oriented = new Map<number, boolean>()
    let current = anchor
    let previous: number | undefined
    while (true) {
      const next = (clusterEdges.get(current) ?? []).find(edgeIndex => edgeIndex !== previous)
      if (next === undefined) break
      const edge = edges.get(next)!
      const forward = find(edge.a) === current
      oriented.set(next, forward)
      current = forward ? find(edge.b) : find(edge.a)
      previous = next
    }

    for (const [edgeIndex, forward] of oriented) {
      const source = sources[edgeIndex]
      const factor = source.kind === 'line'
        ? (forward ? 1 : -1)
        : (forward ? -1 : 1)
      factors.set(source.id, factor)
    }
  }

  return { factors, branches: false }
}

/** The point of one cluster, the fallback anchor choice's reference geometry. */
function clusterPoint(
  root: number,
  endpoints: readonly ChainEndpoint[],
  find: (i: number) => number,
): Point | null {
  const endpoint = endpoints.find((_, index) => find(index) === root)
  return endpoint ? endpoint.point : null
}

/** The factor plan for the whole selection. */
export function offsetSidePlan(
  sources: readonly OffsetSource[],
  constraints: readonly OffsetSideConstraint[] = [],
): OffsetSidePlan {
  const factors = new Map<string, number>()
  const supported = sources.filter((s) => s.kind === 'line' || s.kind === 'arc' || s.kind === 'circle')
  if (supported.length !== sources.length || supported.length === 0) {
    return { factors, branches: false }
  }
  if (!closesIntoLoops(supported)) return openChainPlan(supported, constraints)

  // The supported filter above keeps every kind the probe samples, so a null
  // block here is unreachable; dropping it keeps the soup type non-nullable.
  const segments = supported.flatMap(s => segmentsOf(s) ?? [])
  const eps = 1e-6 * probeExtent(segments)
  for (const s of supported) {
    const p = s.params
    let from: Point
    let toward: Point  // the seed rule's positive direction at `from`, unit
    if (s.kind === 'line') {
      const dx = p[2] - p[0], dy = p[3] - p[1]
      const len = Math.hypot(dx, dy)
      if (len < 1e-9) continue
      from = [(p[0] + p[2]) / 2, (p[1] + p[3]) / 2]
      toward = [-dy / len, dx / len]
    } else {
      const mid = s.kind === 'arc' ? p[3] + arcSweepDeg(p[3], p[4]) / 2 : 0
      from = arcPoint(p[0], p[1], p[2], mid)
      const t = (mid * Math.PI) / 180
      toward = [Math.cos(t), Math.sin(t)]
    }
    const probe: Point = [from[0] + eps * toward[0], from[1] + eps * toward[1]]
    factors.set(s.id, inside(probe, segments) ? -1 : 1)
  }
  return { factors, branches: false }
}

/**
 * The factor each source's seed distance takes: -1 where the seed rule's
 * positive side points into the bounded region (closed loops) or against the
 * chain's walk (open chains), +1 elsewhere. Empty for a selection with a spline
 * or ellipse (no seed side), a branching open selection, a component with no
 * walk, or nothing that bounds a region; the caller then applies the seed rule.
 */
export function offsetSideFactors(
  sources: readonly OffsetSource[],
  constraints: readonly OffsetSideConstraint[] = [],
): Map<string, number> {
  return offsetSidePlan(sources, constraints).factors
}
