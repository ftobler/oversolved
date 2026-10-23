// Arc sampling, polygon point list, area-weighted centroid. Only what the slice
// topology needs lives here.

import { TOL_NEAR_ZERO_AREA } from "./solverConstants"

// Sample count that makes a curved loop read as its true shape rather than as
// its chord polygon: the centroid uses it, the viewport tessellates boundaries
// at the same 64 (Geometry3D/constants ARC_SEGMENTS), and the profile dump
// re-runs containment at it to measure how far the coarse 1-sample polygon has
// drifted from what the user sees.
export const CENTROID_ARC_SAMPLES = 64

export type LoopEdge = Record<string, unknown>

export function radians(deg: number): number {
  return (deg * Math.PI) / 180
}

/** n interior points spread along an arc edge (n>=1); empty if not an arc. */
export function arcSamplePoints(e: LoopEdge, n: number): number[][] {
  if (e["kind"] !== "arc") return []
  const center = e["center"] as number[] | undefined
  if (center === undefined || center === null) return []
  const cx = center[0]
  const cy = center[1]
  const r = (e["radius"] as number) ?? 0.0
  const a0 = radians((e["angle_start_deg"] as number) ?? 0.0)
  const a1 = radians((e["angle_end_deg"] as number) ?? 0.0)
  // Samples follow the stored traversal direction, like the Rust mirror: a CW
  // side sweeps towards its end angle. Swapping the angles instead (as this once
  // did) sampled the same arc in reverse order, so a polygon that starts at the
  // edge's start then jumps to the end-angle side and retraces the arc; a
  // reversed half-edge in a traced face doubled its own area (a venn crescent
  // read as 308 instead of 155, which is what mis-nested it under the lens).
  const sweep = (e["ccw"] as boolean) ?? true
    ? ((a1 - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
    : -(((a0 - a1) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI))
  const out: number[][] = []
  for (let k = 0; k < n; k++) {
    const a = a0 + (sweep * (k + 1)) / (n + 1)
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  return out
}

/** n interior points sampled along a cubic-Bezier spline edge; empty if not one. */
export function splineSamplePoints(e: LoopEdge, n: number): number[][] {
  if (e["kind"] !== "spline") return []
  const p1 = e["start"] as number[]
  const c1 = e["c1"] as number[]
  const c2 = e["c2"] as number[]
  const p4 = e["end"] as number[]
  if (!p1 || !c1 || !c2 || !p4) return []
  const out: number[][] = []
  for (let k = 0; k < n; k++) {
    const t = (k + 1) / (n + 1)
    const mt = 1 - t
    const a = mt * mt * mt
    const b = 3 * mt * mt * t
    const c = 3 * mt * t * t
    const d = t * t * t
    out.push([
      a * p1[0] + b * c1[0] + c * c2[0] + d * p4[0],
      a * p1[1] + b * c1[1] + c * c2[1] + d * p4[1],
    ])
  }
  return out
}

/** True for a spline edge whose start and end coincide (a closed self-loop). */
function splineIsClosed(e: LoopEdge): boolean {
  if (e["kind"] !== "spline") return false
  const p1 = e["start"] as number[] | undefined
  const p4 = e["end"] as number[] | undefined
  if (!p1 || !p4) return false
  return Math.hypot(p1[0] - p4[0], p1[1] - p4[1]) < 1e-6
}

/** n interior points along an elliptical-arc edge; empty if not one. */
export function ellipseArcSamplePoints(e: LoopEdge, n: number): number[][] {
  if (e["kind"] !== "ellipse_arc") return []
  const center = e["center"] as number[] | undefined
  if (!center) return []
  const a = (e["a"] as number) ?? 0.0
  const b = (e["b"] as number) ?? 0.0
  const rot = radians((e["theta"] as number) ?? 0.0)
  const cr = Math.cos(rot)
  const sr = Math.sin(rot)
  const p0 = radians((e["angle_start_deg"] as number) ?? 0.0)
  let p1 = radians((e["angle_end_deg"] as number) ?? 0.0)
  const ccw = (e["ccw"] as boolean) ?? true
  if (ccw) { if (p1 < p0) p1 += 2 * Math.PI } else if (p1 > p0) p1 -= 2 * Math.PI
  const out: number[][] = []
  for (let k = 0; k < n; k++) {
    const phi = p0 + ((p1 - p0) * (k + 1)) / (n + 1)
    const ax = a * Math.cos(phi)
    const ay = b * Math.sin(phi)
    out.push([center[0] + ax * cr - ay * sr, center[1] + ax * sr + ay * cr])
  }
  return out
}

/** n points spread around a full closed ellipse edge; empty if not one. */
export function ellipseSamplePoints(e: LoopEdge, n: number): number[][] {
  if (e["kind"] !== "ellipse") return []
  const center = e["center"] as number[] | undefined
  if (center === undefined || center === null) return []
  const cx = center[0]
  const cy = center[1]
  const a = (e["a"] as number) ?? 0.0
  const b = (e["b"] as number) ?? 0.0
  const rot = radians((e["theta"] as number) ?? 0.0)
  const cr = Math.cos(rot)
  const sr = Math.sin(rot)
  const out: number[][] = []
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n
    const ax = a * Math.cos(t)
    const ay = b * Math.sin(t)
    out.push([cx + ax * cr - ay * sr, cy + ax * sr + ay * cr])
  }
  return out
}

/** Polygon point list from a loop, inserting arc/spline/ellipse sample points. */
export function loopPts(loop: LoopEdge[], arcSamples = 1): number[][] {
  const pts: number[][] = []
  for (const e of loop) {
    if ("start" in e) pts.push(e["start"] as number[])
    pts.push(...arcSamplePoints(e, arcSamples))
    pts.push(...ellipseArcSamplePoints(e, Math.max(arcSamples, 4)))
    // A self-closing spline (start == end) is a standalone closed loop, so it
    // needs enough points to read as a polygon on its own, like a full ellipse.
    pts.push(...splineSamplePoints(e, splineIsClosed(e) ? Math.max(arcSamples * 4, 16) : arcSamples))
    // A full ellipse is a standalone closed loop: it needs enough points to read
    // as a polygon on its own, independent of the coarse arc sample count.
    pts.push(...ellipseSamplePoints(e, Math.max(arcSamples * 4, 16)))
  }
  return pts
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
  return loop
    .map((e) => [String(e['kind'] ?? ''), ...LOOP_SHAPE_FIELDS.map((k) => field(e[k]))].join('|'))
    .sort()
    .join(';')
}

/** Signed 2D area via the shoelace formula. Positive = CCW. `arcSamples` is the
 *  arc/spline sampling the polygon is built from; the default 1 is the coarse
 *  polygon every existing caller has always used. */
export function loopSignedArea(loop: LoopEdge[], arcSamples = 1): number {
  const pts = loopPts(loop, arcSamples)
  const n = pts.length
  if (n < 3) return 0.0
  let acc = 0.0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    acc += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
  }
  return acc / 2.0
}

/** Ray-casting point-in-polygon test against a 2D loop, at the same sampling
 *  the caller measured the areas with. */
export function pointInLoop(pt: number[], loop: LoopEdge[], arcSamples = 1): boolean {
  const x = pt[0]
  const y = pt[1]
  const pts = loopPts(loop, arcSamples)
  const n = pts.length
  let inside = false
  let j = n - 1
  for (let i = 0; i < n; i++) {
    const xi = pts[i][0]
    const yi = pts[i][1]
    const xj = pts[j][0]
    const yj = pts[j][1]
    if (yi > y !== yj > y) {
      if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    j = i
  }
  return inside
}

/**
 * A point `pointInLoop` reads as genuinely inside the loop, for the containment
 * questions `loopCentroid` cannot answer: a concave loop (a C or a U) can have
 * its area centroid in its own notch, outside the loop, and every containment
 * question asked of that point is then answered wrong. Returns the centroid
 * when it verifies as interior; otherwise nudges a boundary edge's midpoint to
 * either side, shrinking the step until one side verifies (a step past the
 * opposite boundary of a thin loop lands outside and is rejected). `null` when
 * nothing verifies, so the caller can keep its centroid-only behaviour.
 *
 * `arcSamples` is threaded through so the profile dump's fine pass
 * (`describeProfile` at CENTROID_ARC_SAMPLES) verifies the probe on the same
 * polygon it tests containment with. The Rust mirror has no fine pass and
 * samples at the coarse 1; at the default both agree.
 */
function interiorProbe(loop: LoopEdge[], arcSamples: number): number[] | null {
  const pts = loopPts(loop, arcSamples)
  const n = pts.length
  if (n < 3) return null
  const centroid = loopCentroid(loop)
  if (pointInLoop(centroid, loop, arcSamples)) return centroid
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len = Math.hypot(dx, dy)
    if (!(len > 0)) continue
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const nx = -dy / len
    const ny = dx / len
    for (const scale of [0.25, 0.1, 0.02, 0.005, 0.001, 0.0002]) {
      const step = len * scale
      for (const side of [1, -1]) {
        const candidate = [m[0] + side * step * nx, m[1] + side * step * ny]
        if (pointInLoop(candidate, loop, arcSamples)) return candidate
      }
    }
  }
  return null
}

/**
 * Containment analysis: for each loop, its nesting `depth` (how many other
 * loops enclose it) and its immediate `container` (the smallest strictly larger
 * loop that encloses it, or -1 if none).
 *
 * `arcSamples` controls how finely a curved loop is polygonised for the area and
 * point-in-loop tests. The default 1 is the historical coarse pass, kept as the
 * profile dump's comparison baseline; `classifyLoops` -- the function that
 * decides what OCC actually builds -- passes `CENTROID_ARC_SAMPLES`, because a
 * 1-sample chord polygon is a shape neither the user nor `loopCentroid` sees.
 * The Rust mirror in profile_loops.rs still nests areas at the coarse count.
 */
export function loopContainment(
  loops: LoopEdge[][],
  arcSamples = 1,
): { depth: number[]; container: number[] } {
  const n = loops.length
  const areas = loops.map((loop) => Math.abs(loopSignedArea(loop, arcSamples)))
  const cents = loops.map((loop) => loopCentroid(loop))
  // The centroid is the historical probe and stays the primary one; a concave
  // loop whose centroid sits outside it is backed by a probe that is verified
  // interior, or a hole inside it would be dropped.
  const probes = loops.map((loop) => interiorProbe(loop, arcSamples))

  const depth: number[] = new Array(n).fill(0)
  const container: number[] = new Array(n).fill(-1)  // immediate enclosing loop
  for (let i = 0; i < n; i++) {
    let bestArea = Infinity
    const probe = probes[i]
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      const held = pointInLoop(cents[i], loops[j], arcSamples)
        || (probe !== null && pointInLoop(probe, loops[j], arcSamples))
      if (areas[j] > areas[i] && held) {
        depth[i] += 1
        if (areas[j] < bestArea) {
          bestArea = areas[j]
          container[i] = j
        }
      }
    }
  }
  return { depth, container }
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

  const n = loops.length
  const { depth, container } = loopContainment(loops, CENTROID_ARC_SAMPLES)

  const result: [LoopEdge[], LoopEdge[][]][] = []
  for (let oi = 0; oi < n; oi++) {
    if (depth[oi] % 2 === 1) continue  // a hole, attached to its container below
    const holes: LoopEdge[][] = []
    for (let i = 0; i < n; i++) if (depth[i] % 2 === 1 && container[i] === oi) holes.push(loops[i])
    result.push([loops[oi], dissolveAdjacentLoops(holes)])
  }
  return result
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
  for (let li = 0; li < loops.length; li++) {
    for (let ei = 0; ei < loops[li].length; ei++) {
      const match = edgeMatch(loops[li][ei])
      if (match === null) return loops  // a self-closed edge: leave the set alone
      entries.push({ loop: li, edge: ei, match })
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
  return cycles
}

/**
 * Planar subdivision: every loop bounds its own face whose holes are the loops
 * immediately nested inside it -- at every depth, not just even ones. Two
 * concentric circles yield two areas: the outer ring (with the inner circle as
 * a hole) AND the inner disk. This is the sketch-area model, where every region
 * the eye can see is selectable, unlike the even/odd `classifyLoops` donut.
 */
export function subdivideLoops(loops: LoopEdge[][]): [LoopEdge[], LoopEdge[][]][] {
  if (loops.length === 0) return []
  if (loops.length === 1) return [[loops[0], []]]

  const n = loops.length
  const { container } = loopContainment(loops)

  const result: [LoopEdge[], LoopEdge[][]][] = []
  for (let oi = 0; oi < n; oi++) {
    const holes: LoopEdge[][] = []
    for (let i = 0; i < n; i++) if (container[i] === oi) holes.push(loops[i])
    result.push([loops[oi], holes])
  }
  return result
}

/** Area-weighted centroid of a 2D loop polygon. */
export function loopCentroid(loop: LoopEdge[]): number[] {
  const pts = loopPts(loop, CENTROID_ARC_SAMPLES)
  const n = pts.length
  if (n < 3) return [0.0, 0.0]
  let cx = 0.0
  let cy = 0.0
  let area = 0.0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const cross = pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
    area += cross
    cx += (pts[i][0] + pts[j][0]) * cross
    cy += (pts[i][1] + pts[j][1]) * cross
  }
  area /= 2.0
  if (Math.abs(area) < TOL_NEAR_ZERO_AREA) return [pts[0][0], pts[0][1]]
  cx /= 6.0 * area
  cy /= 6.0 * area
  return [cx, cy]
}
