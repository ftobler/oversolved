// Profile loops, TS half: the loop identity and classification helpers that
// decide what OCC builds, plus the collinear-run and cluster passes.
//
// The sampling, signed area, centroid, point-in-polygon and containment lives
// in Rust now (`geom-core/src/profile_loops.rs`) and is re-exported here under
// the names callers have always used, so the two languages no longer hold two
// implementations of the polygon reader. The golden fixture in
// `geom-core/tests/fixtures/profile_loops.json` froze the TS behaviour when the
// hand-off happened.

import { JOINT_SNAP_TOL, TOL_LOOP_CLOSURE, TOL_SELECT_DIRECTION } from "./solverConstants"
import { arcSamplePoints, ellipseArcSamplePoints, loopContainment } from "@/wasm-kernel/profileLoops"
import type { LoopEdge } from "@/wasm-kernel/profileLoops"

export {
  arcSamplePoints,
  ellipseArcSamplePoints,
  ellipseSamplePoints,
  fitSplineSamplePoints,
  loopCentroid,
  loopContainment,
  loopPts,
  loopSignedArea,
  pointInLoop,
  splineSamplePoints,
  subdivideLoops,
} from "@/wasm-kernel/profileLoops"

// The loop-edge dict type is declared once, with the wire codec; re-exported so
// every caller keeps importing it from `kernel/profileLoops`.
export type { LoopEdge } from "@/wasm-kernel/profileLoops"

// Sample count that makes a curved loop read as its true shape rather than as
// its chord polygon: the centroid uses it, the viewport tessellates boundaries
// at the same 64 (Geometry3D/constants ARC_SEGMENTS), and the profile dump
// re-runs containment at it to measure how far the coarse 1-sample polygon has
// drifted from what the user sees. Mirrors `CENTROID_ARC_SAMPLES` in
// `geom-core/src/profile_loops.rs`; a change is a decision on both sides.
export const CENTROID_ARC_SAMPLES = 64

/**
 * Edges whose OCC endpoints are pinned to a curve: an arc to its
 * center+radius+angle, an ellipse or elliptical arc to its eccentric-angle
 * frame, and a fit spline to the terminal poles it is built from. A
 * neighbouring joint cannot pull them off that curve, so at a joint they win
 * and the free edge moves. A fit spline's poles follow the joint through
 * `syncFitSplineEnds`, which is what keeps this rule true for it. Shared by the
 * pure profile dump, the loop assembler's merged-vertex snap and the OCC-side
 * snapper (`snapLoopJoints`).
 */
export const ANCHORED_KINDS = new Set(['arc', 'ellipse', 'ellipse_arc', 'fit_spline'])

/**
 * Move a fit spline's terminal poles onto its stored endpoints, and each moved
 * pole's inner neighbour with it.
 *
 * The loop dict's `start`/`end` are the merged joint positions, while the OCC
 * edge is built from `poles`; when the area builder merges a fit-spline end with
 * an anchored arc end, the dict says the joint is closed and the curve still
 * ends at its own pole. The chain is a C0 cubic Bezier chain, so translating a
 * terminal pole together with the next pole keeps the end tangent's direction
 * and magnitude exactly: the shape change is bounded by the joint delta and no
 * fillet or tangent constraint downstream sees a turned tangent.
 *
 * A delta at or under `JOINT_SNAP_TOL` is the rung the snapper repairs; a wider
 * one is a real gap and is left for makeWire to refuse. Returns a clone: the
 * stored topology dicts are never mutated.
 */
export function syncFitSplineEnds(edge: LoopEdge): LoopEdge {
  if (edge['kind'] !== 'fit_spline') return edge
  const polesRaw = edge['poles']
  // A fit spline chain is 3 (N - 1) + 1 poles, so one cubic is the shortest:
  // anything under four has no terminal-plus-neighbour pair to move.
  if (!Array.isArray(polesRaw) || polesRaw.length < 4) return edge
  const poles = polesRaw as number[][]
  const delta = (pole: number[] | undefined, target: unknown): [number, number] | null => {
    if (!Array.isArray(pole) || !Array.isArray(target) || (target as number[]).length < 2) return null
    const dx = (target as number[])[0] - pole[0]
    const dy = (target as number[])[1] - pole[1]
    const gap = Math.hypot(dx, dy)
    if (gap === 0 || gap > JOINT_SNAP_TOL) return null
    return [dx, dy]
  }
  const startDelta = delta(poles[0], edge['start'])
  const endDelta = delta(poles[poles.length - 1], edge['end'])
  const out: number[][] = poles.map((p) => [...p])
  const move = (i: number, d: [number, number]): void => {
    out[i] = [out[i][0] + d[0], out[i][1] + d[1]]
  }
  if (startDelta !== null) {
    move(0, startDelta)
    move(1, startDelta)
  }
  if (endDelta !== null) {
    move(out.length - 1, endDelta)
    move(out.length - 2, endDelta)
  }
  if (startDelta === null && endDelta === null) return { ...edge }
  return { ...edge, poles: out }
}

// The fields that carry a loop's geometry, so two loops with the same boundary
// compare equal whatever order their edges were chained in.
const LOOP_SHAPE_FIELDS = [
  'start', 'end', 'center', 'c1', 'c2',
  'radius', 'a', 'b', 'theta', 'angle_start_deg', 'angle_end_deg', 'ccw',
] as const

/**
 * Order-independent identity key for a closed loop, used both by the profile
 * assembler (one boundary published by two areas is one loop) and by the
 * profile dump (a repeated loop is flagged). One definition, so the two cannot
 * disagree about what "the same loop" means.
 *
 * The key is computed on `fuseCollinearRuns`, so a boundary that one area
 * publishes as one line and another as two collinear pieces still keys equal.
 * Every caller (the assembler, the dump, the area gate) therefore compares the
 * same canonical shape.
 *
 * Every geometry field that can tell two edges of the same kind apart is in the
 * key. The endpoint multiset alone is NOT enough: a full ellipse carries no
 * start/end and no radius, so two concentric ellipses of different size hashed
 * identically and the smaller was reported as a duplicate of the larger (the
 * elliptical donut). A false positive marks a good area unbuildable and now also
 * makes the assembler drop a real boundary, so the key errs wide.
 */
export function loopGeometryKey(loop: LoopEdge[]): string {
  const field = (v: unknown): string => {
    if (Array.isArray(v)) return (v as number[]).map((c) => c.toFixed(9)).join(',')
    if (typeof v === 'number') return v.toFixed(9)
    if (typeof v === 'boolean') return String(v)
    return ''
  }
  return fuseCollinearRuns(loop)
    .map((e) => [String(e['kind'] ?? ''), ...LOOP_SHAPE_FIELDS.map((k) => field(e[k]))].join('|'))
    .sort()
    .join(';')
}

/**
 * Group loops into (outer, holes) pairs for face construction by even/odd
 * containment depth: a loop enclosed by an even number of others is a filled
 * face, one enclosed by an odd number is a hole of its immediate (smallest
 * strictly larger) container. A solid island inside a hole (depth 2) is its own
 * face again -- so arbitrary nesting works, not just one level. This is the
 * extrude/solid model where two concentric circles fuse into one washer solid.
 *
 * Containment runs at `CENTROID_ARC_SAMPLES`, the same polygon the user sees
 * and `loopCentroid` measures. The 1-sample chord polygon is a shape neither
 * the user nor the centroid sees: a small circle sitting near a big circle's
 * chord lay outside it for the chord test but inside the real circle, so a
 * real bore was lost. A venn crescent also read smaller than the lens on the
 * old sampler and became its hole (the extrude built the lens, not the
 * union). The coarse pass stays available through `loopContainment`'s own
 * default for the profile dump, which reports where the two disagree.
 */
export function classifyLoops(loops: LoopEdge[][]): [LoopEdge[], LoopEdge[][]][] {
  if (loops.length === 0) return []
  if (loops.length === 1) return [[loops[0], []]]

  const { depth, container } = loopContainment(loops, CENTROID_ARC_SAMPLES)
  return fillGroups(loops, depth, container).map(({ outer, holes }) =>
    [loops[outer], dissolveAdjacentLoops(holes.map((i) => loops[i]))])
}

/**
 * The even/odd fill decision over a containment analysis, as loop indices:
 * every filled loop with the holes it carries. Shared by `classifyLoops` (what
 * OCC builds) and the profile dump (what it reports), so the two cannot drift.
 *
 * A loop `enclosedCurveLoops` reads as a hole its neighbours already carve
 * out is left out entirely, and its interior is a hole: every loop nested
 * inside it flips parity, so an island inside that disc is filled again (and
 * a hole in the island stays a hole of the island).
 */
export function fillGroups(
  loops: LoopEdge[][],
  depth: number[],
  container: number[],
): { outer: number; holes: number[] }[] {
  const n = loops.length
  const enclosed = enclosedCurveLoops(loops, depth)
  const odd = depth.map((d, i) => {
    let flips = 0
    // The container chain is a strict nesting, so it ends; the bound only
    // guards a malformed analysis.
    for (let c = container[i], k = 0; c >= 0 && k < n; c = container[c], k++) {
      if (enclosed.has(c)) flips += 1
    }
    return (d + flips) % 2 === 1
  })
  const groups: { outer: number; holes: number[] }[] = []
  for (let oi = 0; oi < n; oi++) {
    if (odd[oi] || enclosed.has(oi)) continue  // a hole, attached to its container below
    const holes: number[] = []
    for (let i = 0; i < n; i++) if (odd[i] && container[i] === oi) holes.push(i)
    groups.push({ outer: oi, holes })
  }
  return groups
}

/**
 * The loops that are a closed curve's interior with filled areas all around
 * it: a hole whose boundary touches its container, so the area builder cut it
 * into a traced subdivision instead of nesting it.
 *
 * An r2 circle in the corner of a square, tangent to both sides, splits the
 * square at the two tangent points. The builder then publishes three adjacent
 * areas (the corner pocket, the rest of the square, the disc) and no loop is
 * contained in another, so the containment depth reads the disc as a filled
 * outer and the extrude fused it back: the full square, no hole, no word. The
 * same circle clear of the sides, or touching one side at a single point, is
 * nested and cut. The disc is the same region in all three; what decides it
 * is that every side of it is shared with a filled area of the same level,
 * which is what a hole inside that material is.
 *
 * Conservative on purpose: the loop must be traced pieces of ONE entity (so
 * it is that closed curve's whole interior, nothing crosses it), and every
 * piece must be the reverse side of an edge of another filled loop at the
 * same depth. A disc with any side on the open plane (three mutually tangent
 * circles, a circle sitting in a notch) keeps its area, and a loop bounded by
 * two curves (a crossing, a venn lens) is a union region, not a hole.
 */
function enclosedCurveLoops(loops: LoopEdge[][], depth: number[]): Set<number> {
  const candidates = new Set<number>()
  loops.forEach((loop, i) => {
    if (depth[i] % 2 === 1 || loop.length < 2) return
    const owner = loop[0]['id']
    if (typeof owner !== 'string' || !loop.every((e) => e['id'] === owner)) return
    if (loop.some((e) => edgeMatch(e) === null)) return
    candidates.add(i)
  })
  const out = new Set<number>()
  for (const i of candidates) {
    const neighbourKeys = new Set<string>()
    loops.forEach((loop, j) => {
      if (j === i || candidates.has(j) || depth[j] !== depth[i]) return
      for (const e of loop) {
        const m = edgeMatch(e)
        if (m !== null) neighbourKeys.add(m.key)
      }
    })
    if (loops[i].every((e) => neighbourKeys.has((edgeMatch(e) as EdgeMatch).key))) out.add(i)
  }
  return out
}

/**
 * One loop edge's matchable geometry: a direction-free `key` (the same for an
 * edge and its reverse half-edge), its two endpoint keys, and the direction
 * sign relative to the key. `null` for an edge with no endpoints (a full
 * ellipse or a self-closed spline): those never border another region.
 *
 * The direction sign comes from the endpoint keys in stored traversal order, so
 * two copies of one shared edge carry opposite signs whatever the seam/angle
 * convention. Arc midpoint sampling is direction-free for the same reason: a
 * reversed arc swaps its angles and flips `ccw`, which samples the same points.
 */
interface EdgeMatch {
  key: string
  start: string
  end: string
  sign: number
}

function endpointKey(e: LoopEdge, which: 'start' | 'end'): string | null {
  const vertex = e[which + '_vertex']
  if (typeof vertex === 'string') return 'v:' + vertex
  const p = e[which] as number[] | undefined
  if (!Array.isArray(p) || p.length < 2) return null
  return `p:${p[0].toFixed(9)},${p[1].toFixed(9)}`
}

function edgeMatch(e: LoopEdge): EdgeMatch | null {
  const start = endpointKey(e, 'start')
  const end = endpointKey(e, 'end')
  if (start === null || end === null || start === end) return null
  const kind = String(e['kind'] ?? '')
  const pair = [start, end].sort().join('|')
  let key: string
  if (kind === 'line') {
    key = 'line|' + pair
  } else if (kind === 'arc') {
    const mid = arcSamplePoints(e, 1)[0]
    key = `arc|${JSON.stringify(e['center'])}|${String(e['radius'])}|${mid ? pointKey(mid) : ''}`
  } else if (kind === 'ellipse_arc') {
    const mid = ellipseArcSamplePoints(e, 1)[0]
    key = `ellipse_arc|${JSON.stringify(e['center'])}|${String(e['a'])}|${String(e['b'])}|` +
      `${String(e['theta'] ?? 0)}|${mid ? pointKey(mid) : ''}`
  } else if (kind === 'spline') {
    const c1 = e['c1'] as number[] | undefined
    const c2 = e['c2'] as number[] | undefined
    const controls = c1 && c2 ? [pointKey(c1), pointKey(c2)].sort().join('|') : ''
    key = 'spline|' + pair + '|' + controls
  } else if (kind === 'fit_spline') {
    // The pole chain identifies the run; reversing an edge reverses the chain,
    // so hash the lexicographically smaller spelling to keep the two faces
    // sharing it on one key.
    const poles = (e['poles'] as number[][] | undefined) ?? []
    const forward = poles.map(pointKey).join('|')
    const reverse = [...poles].reverse().map(pointKey).join('|')
    key = 'fit_spline|' + pair + '|' + (forward < reverse ? forward : reverse)
  } else {
    return null
  }
  return { key, start, end, sign: start < end ? 1 : -1 }
}

function pointKey(p: number[]): string {
  return `${p[0].toFixed(9)},${p[1].toFixed(9)}`
}

/**
 * Merge holes that share an edge into the boundary of their union.
 *
 * The area model publishes every region, so a plus-shaped void inside a
 * circle reaches the face builder as FIVE hole loops that share edges. OCC
 * gets a face whose hole wires touch along edges, and a boolean cut of its
 * prism fails BRepCheck_Analyzer ("the kernel returned an unsound result").
 * The void's real boundary is one plus-shaped wire, so cancel each shared
 * edge against its reverse half-edge and chain the survivors.
 *
 * Conservative on purpose: every edge must be matchable, every cancellation
 * must be an opposite pair, and the survivors must chain into closed cycles
 * with no ambiguous (more than one onward) vertex. Anything else returns the
 * holes untouched, so a shape this cannot prove is never silently rewritten.
 */
export function dissolveAdjacentLoops(loops: LoopEdge[][]): LoopEdge[][] {
  if (loops.length < 2) return loops
  const entries: { loop: number; edge: number; match: EdgeMatch }[] = []
  // A self-closed loop (full ellipse, closed spline) has no shareable edge, so
  // it cannot join a cancellation. Keep it verbatim and dissolve the rest; one
  // such hole must not disable the merge for a plus of touching line holes.
  const untouched: LoopEdge[][] = []
  for (let li = 0; li < loops.length; li++) {
    const matches = loops[li].map(edgeMatch)
    if (matches.some((match) => match === null)) {
      untouched.push(loops[li])
      continue
    }
    for (let ei = 0; ei < loops[li].length; ei++) {
      entries.push({ loop: li, edge: ei, match: matches[ei] as EdgeMatch })
    }
  }

  // Cancel each shared edge against its reverse. A key can hold several
  // candidates (a vertex with several borders); match the first live opposite.
  const alive = new Array<boolean>(entries.length).fill(true)
  const pending = new Map<string, number[]>()
  let cancelled = false
  for (let i = 0; i < entries.length; i++) {
    const { key, sign } = entries[i].match
    const candidates = pending.get(key) ?? []
    const opposite = candidates.find((j) => alive[j] && entries[j].match.sign === -sign)
    if (opposite !== undefined) {
      alive[opposite] = false
      alive[i] = false
      cancelled = true
      continue
    }
    candidates.push(i)
    pending.set(key, candidates)
  }
  if (!cancelled) return loops

  const survivors = entries.filter((_, i) => alive[i])
  if (survivors.length === 0) return loops
  // Start key -> survivor indices, for the head-to-tail walk.
  const at = new Map<string, number[]>()
  survivors.forEach((s, i) => {
    const list = at.get(s.match.start) ?? []
    list.push(i)
    at.set(s.match.start, list)
  })

  const used = new Array<boolean>(survivors.length).fill(false)
  const cycles: LoopEdge[][] = []
  for (let first = 0; first < survivors.length; first++) {
    if (used[first]) continue
    const cycle: LoopEdge[] = []
    let current = first
    for (;;) {
      if (used[current]) return loops  // revisited before closing: ambiguous walk
      used[current] = true
      const s = survivors[current]
      cycle.push(loops[s.loop][s.edge])
      const live = (at.get(s.match.end) ?? []).filter((i) => !used[i])
      if (s.match.end === survivors[first].match.start) {
        // The chain came back to its own start. Close only when nothing else
        // leaves that vertex (a figure-eight pinch would need an arbitrary
        // choice, and an arbitrary choice is not a wire this can prove).
        if (live.length === 0) break
        return loops
      }
      if (live.length !== 1) return loops  // open chain or a pinch point
      current = live[0]
    }
    cycles.push(cycle)
  }
  return untouched.length === 0 ? cycles : [...cycles, ...untouched]
}

// Two arc pieces meeting at a joint must name the same point of their shared
// circle. A degree-scale rung, far above f64 noise, still refuses a stored
// angle range that describes a different point than the shared endpoint.
const ARC_ANGLE_TOL_DEG = 1e-3

/**
 * Merge consecutive collinear (line) or co-circular (arc) edges of a closed
 * 2D loop into single edges. Construction-line splits and authored end-to-end
 * collinear lines both survive as one edge on the solid, so the prism emits one
 * lateral face per geometric run instead of one per piece.
 *
 * A merged edge keeps its primary `id` and carries `mergedIds`: every source
 * entity id in loop order, de-duplicated. When all pieces came from one entity
 * the `id` is that entity; when several entities fused, the `id` is the
 * smallest of them (deterministic across edits) and the others are aliases
 * through the ancestry list. Runs wrap around the loop start. A run of arcs
 * that closes the whole loop is stored as one arc spanning a full turn.
 *
 * Pure and OCC-free, so it unit-tests without WASM.
 */
export function fuseCollinearRuns(loop: LoopEdge[]): LoopEdge[] {
  const n = loop.length
  if (n === 0) return []
  const edges: LoopEdge[] = loop.map((e) => ({ ...e }))
  if (n === 1) return [withMergedIds(edges[0])]

  const closePt = (a: number[], b: number[]): boolean =>
    Math.hypot(a[0] - b[0], a[1] - b[1]) <= TOL_LOOP_CLOSURE

  // adj[i] is true when edge i continues into edge (i + 1) % n as one geometric
  // run: two lines straight through their shared vertex, or two arcs of the
  // same circle with the same sweep sense. A corner, a reversal or a different
  // circle breaks the run.
  const adj: boolean[] = new Array(n).fill(false)
  for (let i = 0; i < n; i++) {
    const a = edges[i]
    const b = edges[(i + 1) % n]
    const aEnd = a['end'] as number[] | undefined
    const bStart = b['start'] as number[] | undefined
    if (!Array.isArray(aEnd) || !Array.isArray(bStart) || !closePt(aEnd, bStart)) continue
    const ak = String(a['kind'] ?? 'line')
    const bk = String(b['kind'] ?? 'line')
    if (ak === 'line' && bk === 'line') {
      const aStart = a['start'] as number[] | undefined
      const bEnd = b['end'] as number[] | undefined
      if (!Array.isArray(aStart) || !Array.isArray(bEnd)) continue
      // Both directions are measured from the shared joint, so a joint the
      // assembler snapped by up to TOL_LOOP_CLOSURE cannot read as a kink.
      const joint = aEnd
      const da = [joint[0] - aStart[0], joint[1] - aStart[1]]
      const db = [bEnd[0] - joint[0], bEnd[1] - joint[1]]
      const la = Math.hypot(da[0], da[1])
      const lb = Math.hypot(db[0], db[1])
      if (la === 0 || lb === 0) continue
      const cross = da[0] * db[1] - da[1] * db[0]
      const dot = da[0] * db[0] + da[1] * db[1]
      // The same sine rung select's parallel clause uses: it absorbs the
      // solver's angular residual while still rejecting a visible bend.
      adj[i] = Math.abs(cross) <= TOL_SELECT_DIRECTION * la * lb && dot > 0
    } else if (ak === 'arc' && bk === 'arc') {
      const ca = a['center'] as number[] | undefined
      const cb = b['center'] as number[] | undefined
      const ra = a['radius'] as number | undefined
      const rb = b['radius'] as number | undefined
      if (!Array.isArray(ca) || !Array.isArray(cb) || ra === undefined || rb === undefined) continue
      if (Math.abs(ra - rb) > TOL_LOOP_CLOSURE) continue
      if (Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) > TOL_LOOP_CLOSURE) continue
      if (((a['ccw'] as boolean) ?? true) !== ((b['ccw'] as boolean) ?? true)) continue
      // The shared endpoint is already checked; the stored angles only need to
      // agree on which point of the circle that is (modulo a full turn).
      const aEndDeg = (a['angle_end_deg'] as number) ?? 0
      const bStartDeg = (b['angle_start_deg'] as number) ?? 0
      adj[i] = angleDiffDeg(aEndDeg, bStartDeg) <= ARC_ANGLE_TOL_DEG
    }
  }

  // One break linearizes the cycle; every run then falls between two breaks.
  // With no break at all the whole loop is one run (an arc loop on one circle
  // becomes a full turn). The LAST break is the start point so a loop with no
  // fuse keeps its authored edge order.
  let breakAt = -1
  for (let i = 0; i < n; i++) if (!adj[i]) breakAt = i
  if (breakAt === -1) {
    // No break anywhere: every joint is continuous, so this run may close the
    // whole loop into a full turn.
    return [mergeRun(edges, Array.from({ length: n }, (_, i) => i), true)]
  }
  const runs: number[][] = []
  let run: number[] = []
  for (let k = 0; k < n; k++) {
    const i = (breakAt + 1 + k) % n
    run.push(i)
    if (!adj[i]) {
      runs.push(run)
      run = []
    }
  }
  return runs.map((indices) => mergeRun(edges, indices, false))
}

/**
 * Partition one profile's (outer, holes) groups into clusters of regions that
 * share a boundary edge, so each cluster can be built on its own and the
 * clusters compounded without a boolean.
 *
 * Two groups join only when one of their edges and one of the other's overlap
 * along a positive length: lines by a collinear shared interval, arcs by the
 * same circle with overlapping sweeps. A shared vertex alone -- a point touch,
 * a corner touch, an external or internal tangency -- never joins. That is the
 * whole point: fusing two prisms that meet only at a point makes BOP split both
 * walls along the contact line, and no downstream clean can fold those faces
 * back on every shape. Never fusing them is the fix; regions that really share
 * a boundary are still fused exactly as before.
 *
 * Edges are matched by geometry, not only by their source entity, because a
 * boundary can be authored twice: two sketches whose rectangles meet along one
 * side share no entity id, yet their profile is one connected region and must
 * keep fusing. Within one area surface the traced pieces of an entity are the
 * common case, and the source ids (including a fused run's `mergedIds`) are
 * what proves a shared piece for the kinds whose overlap this does not measure
 * (an ellipse or a spline: two pieces of one authored curve bound both areas).
 *
 * Clusters come back in first-group order, each keeping its own groups in
 * profile order, so a caller that builds them in sequence gives the downstream
 * part split a stable order. One cluster is the ordinary multi-group profile;
 * one group per cluster is today's single-group path.
 *
 * Pure and OCC-free, so the partition unit-tests without WASM.
 */
export function profileClusters(
  groups: [LoopEdge[], LoopEdge[][]][],
): [LoopEdge[], LoopEdge[][]][][] {
  if (groups.length < 2) return groups.map((group) => [group])
  const parent = groups.map((_, i) => i)
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
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB)
  }

  const edges: ProfileClusterEdge[][] = groups.map(([outer, holes]) =>
    [outer, ...holes].flat().map((edge) => ({
      edge,
      source: sourceIds(edge),
      box: edgeBox(edge),
    })),
  )
  for (let a = 0; a < groups.length; a++) {
    for (let b = a + 1; b < groups.length; b++) {
      if (find(a) === find(b)) continue
      if (!groupsShareBoundary(edges[a], edges[b])) continue
      union(a, b)
    }
  }

  const clusters: [LoopEdge[], LoopEdge[][]][][] = []
  const slotOf = new Map<number, number>()
  for (let i = 0; i < groups.length; i++) {
    const root = find(i)
    let slot = slotOf.get(root)
    if (slot === undefined) {
      slot = clusters.length
      slotOf.set(root, slot)
      clusters.push([])
    }
    clusters[slot].push(groups[i])
  }
  return clusters
}

/** One loop edge plus the identity and bounds the cluster pass compares it by. */
interface ProfileClusterEdge {
  edge: LoopEdge
  source: string[]
  // Null when the edge carries no point to bound; such an edge is compared to
  // every candidate rather than pruned on a box it does not have.
  box: [number, number, number, number] | null
}

function groupsShareBoundary(a: ProfileClusterEdge[], b: ProfileClusterEdge[]): boolean {
  for (const ea of a) {
    for (const eb of b) {
      if (ea.box !== null && eb.box !== null && !boxesOverlap(ea.box, eb.box)) continue
      const sameEntity = ea.source.some((id) => eb.source.includes(id))
      if (edgesOverlap(ea.edge, eb.edge, sameEntity)) return true
    }
  }
  return false
}

function boxesOverlap(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  const tol = TOL_LOOP_CLOSURE
  return a[0] <= b[2] + tol && b[0] <= a[2] + tol && a[1] <= b[3] + tol && b[1] <= a[3] + tol
}

/** The bounding box an edge can occupy, conservative for every curved kind. */
function edgeBox(edge: LoopEdge): [number, number, number, number] | null {
  const kind = String(edge['kind'] ?? 'line')
  const center = edge['center'] as unknown
  if (kind === 'arc' && isPoint2(center) && typeof edge['radius'] === 'number') {
    // A full circle bound: the arc's samples would under-approximate a bulge
    // between them, and a box that misses geometry lets a real neighbour escape.
    const r = Math.abs(edge['radius'] as number)
    return [center[0] - r, center[1] - r, center[0] + r, center[1] + r]
  }
  if ((kind === 'ellipse' || kind === 'ellipse_arc') && isPoint2(center)) {
    const half = Math.max(Math.abs((edge['a'] as number) ?? 0), Math.abs((edge['b'] as number) ?? 0))
    return [center[0] - half, center[1] - half, center[0] + half, center[1] + half]
  }
  const pts: number[][] = []
  const add = (p: unknown): void => {
    if (isPoint2(p)) pts.push(p)
  }
  add(edge['start'])
  add(edge['end'])
  add(edge['c1'])
  add(edge['c2'])
  if (Array.isArray(edge['poles'])) for (const pole of edge['poles']) add(pole)
  if (pts.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p[0])
    minY = Math.min(minY, p[1])
    maxX = Math.max(maxX, p[0])
    maxY = Math.max(maxY, p[1])
  }
  return [minX, minY, maxX, maxY]
}

function isPoint2(p: unknown): p is number[] {
  return Array.isArray(p) && p.length >= 2
    && typeof p[0] === 'number' && typeof p[1] === 'number'
}

/**
 * Whether two loop edges bound the same positive length of boundary. The kind
 * decides how that is measured; `sameEntity` is the evidence for the kinds this
 * does not measure, where two pieces traced from one authored curve are the
 * curve's own boundary on both sides.
 */
function edgesOverlap(a: LoopEdge, b: LoopEdge, sameEntity: boolean): boolean {
  const kindA = String(a['kind'] ?? 'line')
  const kindB = String(b['kind'] ?? 'line')
  if (kindA === 'line' && kindB === 'line') return linesOverlap(a, b)
  if (kindA === 'arc' && kindB === 'arc') return arcsOverlap(a, b)
  return sameEntity
}

function linesOverlap(a: LoopEdge, b: LoopEdge): boolean {
  const a0 = a['start'] as unknown
  const a1 = a['end'] as unknown
  const b0 = b['start'] as unknown
  const b1 = b['end'] as unknown
  if (!isPoint2(a0) || !isPoint2(a1) || !isPoint2(b0) || !isPoint2(b1)) return false
  const da = [a1[0] - a0[0], a1[1] - a0[1]]
  const db = [b1[0] - b0[0], b1[1] - b0[1]]
  const la = Math.hypot(da[0], da[1])
  const lb = Math.hypot(db[0], db[1])
  if (la === 0 || lb === 0) return false
  // Parallel and on one line: the sine and the perpendicular offset both sit on
  // the loop-closure rung, so a solver residual still reads collinear while a
  // drawn offset does not.
  if (Math.abs(da[0] * db[1] - da[1] * db[0]) > TOL_LOOP_CLOSURE * la * lb) return false
  if (Math.abs((b0[0] - a0[0]) * da[1] - (b0[1] - a0[1]) * da[0]) / la > TOL_LOOP_CLOSURE) return false
  const ux = da[0] / la
  const uy = da[1] / la
  const tb0 = (b0[0] - a0[0]) * ux + (b0[1] - a0[1]) * uy
  const tb1 = (b1[0] - a0[0]) * ux + (b1[1] - a0[1]) * uy
  const lo = Math.max(0, Math.min(tb0, tb1))
  const hi = Math.min(la, Math.max(tb0, tb1))
  return hi - lo > TOL_LOOP_CLOSURE
}

function arcsOverlap(a: LoopEdge, b: LoopEdge): boolean {
  const ca = a['center'] as unknown
  const cb = b['center'] as unknown
  const ra = a['radius'] as unknown
  const rb = b['radius'] as unknown
  if (!isPoint2(ca) || !isPoint2(cb) || typeof ra !== 'number' || typeof rb !== 'number') return false
  if (Math.abs(ra - rb) > TOL_LOOP_CLOSURE) return false
  if (Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) > TOL_LOOP_CLOSURE) return false
  const a0 = (a['angle_start_deg'] as number) ?? 0
  const b0 = (b['angle_start_deg'] as number) ?? 0
  const sweepA = arcSweepDeg(a0, (a['angle_end_deg'] as number) ?? 0, (a['ccw'] as boolean) ?? true)
  const sweepB = arcSweepDeg(b0, (b['angle_end_deg'] as number) ?? 0, (b['ccw'] as boolean) ?? true)
  return arcSweepsOverlapDeg(a0, sweepA, b0, sweepB) > ARC_ANGLE_TOL_DEG
}

/**
 * The length two circular sweeps share, in degrees. A sweep is the interval it
 * covers on the circle, so its sign (winding) is irrelevant: only a positive
 * shared extent is boundary, and a mere shared endpoint is none.
 */
function arcSweepsOverlapDeg(a0: number, sweepA: number, b0: number, sweepB: number): number {
  if (Math.abs(sweepA) >= 360 - ARC_ANGLE_TOL_DEG) return Math.abs(sweepB)
  if (Math.abs(sweepB) >= 360 - ARC_ANGLE_TOL_DEG) return Math.abs(sweepA)
  const aLo = Math.min(a0, a0 + sweepA)
  const aHi = Math.max(a0, a0 + sweepA)
  const bLo = Math.min(b0, b0 + sweepB)
  const bHi = Math.max(b0, b0 + sweepB)
  let shared = 0
  // Each sweep is under a turn, so a second overlap is reachable only through
  // one whole turn of shift.
  for (const turn of [-360, 0, 360]) {
    const lo = Math.max(aLo, bLo + turn)
    const hi = Math.min(aHi, bHi + turn)
    shared = Math.max(shared, hi - lo)
  }
  return shared
}

/** Source entity ids of one loop edge: its aliases when already merged. */
function sourceIds(e: LoopEdge): string[] {
  const merged = e['mergedIds']
  if (Array.isArray(merged)) return merged.map((id) => String(id))
  const id = String(e['id'] ?? '')
  return id ? [id] : []
}

function mergeRun(E: LoopEdge[], indices: number[], wholeLoop: boolean): LoopEdge {
  const first = E[indices[0]]
  const last = E[indices[indices.length - 1]]
  const kind = String(first['kind'] ?? 'line')
  // Read `mergedIds` rather than `id` so fusing an already-fused loop cannot
  // drop an alias.
  const mergedIds: string[] = []
  const seen = new Set<string>()
  for (const i of indices) {
    for (const id of sourceIds(E[i])) {
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      mergedIds.push(id)
    }
  }
  const primary = mergedIds.length === 0 ? '' : [...mergedIds].sort()[0]
  const assign = (out: LoopEdge): LoopEdge => {
    out['id'] = primary
    out['mergedIds'] = mergedIds
    return out
  }
  const copyPoint = (out: LoopEdge, key: 'start' | 'end', src: unknown): void => {
    if (Array.isArray(src)) out[key] = [...(src as number[])]
    else delete out[key]
  }
  const setVertex = (out: LoopEdge, key: 'start_vertex' | 'end_vertex', value: unknown): void => {
    if (value === undefined) delete out[key]
    else out[key] = value
  }

  if (kind === 'line') {
    const out: LoopEdge = { ...first }
    out['kind'] = 'line'
    copyPoint(out, 'start', first['start'])
    copyPoint(out, 'end', last['end'])
    // The merged edge now runs from the first piece's start vertex to the last
    // piece's end vertex; an inherited interior id would make the matchable
    // key disagree with the geometry the OCC wire and `edgeMatch` see.
    setVertex(out, 'start_vertex', first['start_vertex'])
    setVertex(out, 'end_vertex', last['end_vertex'])
    return assign(out)
  }

  if (kind === 'arc') {
    const centerRaw = first['center']
    const radius = first['radius']
    if (!Array.isArray(centerRaw) || typeof radius !== 'number') return assign({ ...first })
    const firstArc = first
    const ccw = ((firstArc['ccw'] as boolean) ?? true)
    let totalSweep = 0
    for (const i of indices) {
      const e = E[i]
      const a0 = (e['angle_start_deg'] as number) ?? 0
      const a1 = (e['angle_end_deg'] as number) ?? 0
      totalSweep += arcSweepDeg(a0, a1, ccw)
    }
    const out: LoopEdge = { ...firstArc }
    out['kind'] = 'arc'
    const center = [...(centerRaw as number[])]
    out['center'] = center
    out['radius'] = radius
    out['ccw'] = ccw
    const startDeg = (firstArc['angle_start_deg'] as number) ?? 0
    if (wholeLoop && Math.abs(totalSweep) >= 360 - 1e-6) {
      // A run with no break that closes the whole loop is a full turn. Store it
      // as a 360-degree arc (the closed-circle form `arcJointCircle` rebuilds as
      // one OCC circle edge), not as a `circle` loop kind, which the wire writer
      // does not accept. Start at the circle's own 0 degrees so the stored
      // endpoints and angles describe the same point.
      out['angle_start_deg'] = 0
      out['angle_end_deg'] = totalSweep >= 0 ? 360 : -360
      out['start'] = [center[0] + radius, center[1]]
      out['end'] = [center[0] + radius, center[1]]
      setVertex(out, 'start_vertex', first['start_vertex'])
      setVertex(out, 'end_vertex', first['start_vertex'])
    } else {
      out['angle_start_deg'] = startDeg
      out['angle_end_deg'] = startDeg + totalSweep
      copyPoint(out, 'start', first['start'])
      copyPoint(out, 'end', last['end'])
      setVertex(out, 'start_vertex', first['start_vertex'])
      setVertex(out, 'end_vertex', last['end_vertex'])
    }
    return assign(out)
  }

  return assign({ ...first })
}

function withMergedIds(e: LoopEdge): LoopEdge {
  const out: LoopEdge = { ...e }
  if (!Array.isArray(out['mergedIds'])) out['mergedIds'] = sourceIds(out)
  return out
}

function arcSweepDeg(a0: number, a1: number, ccw: boolean): number {
  if (Math.abs(a1 - a0) >= 360 - 1e-6) return ccw ? 360 : -360
  if (ccw) {
    let s = (a1 - a0) % 360
    if (s < 0) s += 360
    return s
  }
  let s = (a0 - a1) % 360
  if (s < 0) s += 360
  return -s
}

function angleDiffDeg(a: number, b: number): number {
  let d = Math.abs((a - b) % 360)
  if (d > 180) d = 360 - d
  return d
}
