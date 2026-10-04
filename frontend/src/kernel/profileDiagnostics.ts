// What the profile actually looks like at the handoff from the sketch area
// builder to OCC, measured rather than assumed.
//
// The two sides disagree about what "closed" means. The area builder closes a
// face combinatorially, by merged vertex id, at TOL_TOPOLOGY_MERGE (1e-5) and
// never measures a gap. `extractProfileLoops` re-derives the same loops
// metrically, by chaining coordinates at TOL_LOOP_CLOSURE (1e-6). OCC then
// connects edges at Precision::Confusion (OCC_CONFUSION, 1e-7). The looser
// number wins earliest, so an area can exist, be filled in the viewport and be
// offered to the picker while the profile it implies never reaches the kernel.
// This module reports where in that ladder each joint sits.
//
// Deliberately pure: no OCC import, so it runs in the solver worker (where OCC
// may not be loaded) and is unit-testable without the gated Real harness. The
// OCC-side counterpart -- what the kernel thinks the gaps are once the edges
// exist -- is `wireEndpointGaps` in occ/primitives.ts.

import {
  CENTROID_ARC_SAMPLES,
  loopContainment,
  loopPts,
  loopSignedArea,
  type LoopEdge,
} from './profileLoops'
import { extractProfileLoops } from './features/shared'
import { OCC_CONFUSION, TOL_LOOP_CLOSURE, TOL_TOPOLOGY_EPS, TOL_TOPOLOGY_MERGE } from './solverConstants'

/**
 * Edges whose OCC endpoints are pinned to an analytic curve (center+radius+angle
 * for arcs, the eccentric-angle frame for ellipse arcs): a neighbouring joint
 * cannot pull them off that curve, so at a joint they win and the free edge
 * moves. Lives here rather than in prismLineage so the pure diagnostic and the
 * OCC-side snapper (`snapLoopJoints`) share one definition instead of drifting.
 */
export const ANCHORED_KINDS = new Set(['arc', 'ellipse', 'ellipse_arc'])

export interface JointReport {
  index: number
  aKind: string
  bKind: string
  aEnd: number[]
  bStart: number[]
  gap: number
  aAnchored: boolean
  bAnchored: boolean
  aEndVertex: string | null
  bStartVertex: string | null
}

export interface LoopReport {
  edgeCount: number
  kinds: string[]
  joints: JointReport[]
  closureGap: number
  areaCoarse: number
  areaFine: number
  areaRatio: number
  minChord: number
  duplicateOf: number | null
}

export interface ProfileReport {
  loops: LoopReport[]
  depth: number[]
  container: number[]
  groups: { outer: number; holes: number[] }[]
  worstJointGap: number
  verdict: 'ok' | 'suspect'
  reasons: string[]
}

/**
 * Why an area will not build, as a stable token. The prose in `reason` is free
 * to be reworded; this is not. It is stamped onto every `TopologySurface`, which
 * is persisted inside `_topo_<featureId>` in every checkpoint snapshot, so a
 * consumer written a year from now still has something to switch on. Add codes,
 * never rename or repurpose one.
 */
export type AreaReasonCode =
  | 'no_boundary'
  | 'loop_not_chained'
  | 'degenerate_edge'
  | 'duplicate_loop'

/** Verdict of the cheap pre-OCC gate; see `validateSketchArea`. */
export interface AreaValidation {
  buildable: boolean
  reason?: string
  reasonCode?: AreaReasonCode
}

// An areaCoarse/areaFine ratio outside this band means the 1-sample chord
// polygon the containment math runs on is not the shape the user sees.
const AREA_RATIO_BAND: [number, number] = [0.9, 1.1]

function dist2d(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

/** One gap, rendered the same way everywhere a gap reaches a human. */
export function formatGap(n: number): string {
  if (!Number.isFinite(n)) return 'n/a'
  if (n === 0) return '0'
  return n.toExponential(3)
}

const fmt = formatGap

function pt(p: number[]): string {
  return p.length ? `(${p.map((c) => c.toFixed(9)).join(', ')})` : '(none)'
}

function endpoint(e: LoopEdge, key: 'start' | 'end'): number[] {
  const v = e[key]
  return Array.isArray(v) ? (v as number[]) : []
}

function vertexId(e: LoopEdge, key: 'start_vertex' | 'end_vertex'): string | null {
  const v = e[key]
  return typeof v === 'string' ? v : null
}

const CURVE_KINDS = new Set(['arc', 'ellipse', 'ellipse_arc', 'spline'])

/**
 * True for an edge that is a complete closed curve on its own: a full ellipse, a
 * full-turn arc or elliptical arc, a self-closing spline. Its start and end
 * coincide BY CONSTRUCTION, so its zero chord is not the degenerate-edge signal
 * C10 is about, and calling it degenerate would mark a perfectly good area
 * unbuildable.
 *
 * The endpoint test covers every curve kind rather than only spline, because a
 * near-zero span on a CURVE is not this predicate's business: `makeArcEdge`
 * already refuses a span under 1e-6, earlier and far more specifically than a
 * chord measurement could. A degenerate straight LINE has no such guard, which
 * is exactly what minChord is left to catch.
 */
function isSelfClosedEdge(e: LoopEdge): boolean {
  const kind = e['kind'] as string | undefined
  if (kind === undefined || !CURVE_KINDS.has(kind)) return false
  if (kind === 'ellipse') return true
  if (kind === 'arc' || kind === 'ellipse_arc') {
    const a0 = (e['angle_start_deg'] as number | undefined) ?? 0
    const a1 = (e['angle_end_deg'] as number | undefined) ?? 360
    if (Math.abs(Math.abs(a1 - a0) - 360) < 1e-9) return true
  }
  const s = endpoint(e, 'start')
  const en = endpoint(e, 'end')
  return s.length > 0 && en.length > 0 && dist2d(s, en) < TOL_TOPOLOGY_EPS
}

// Every geometry field that can tell two edges of the same kind apart. The
// endpoint multiset alone is NOT enough: a full ellipse carries no start/end and
// no radius, so two concentric ellipses of different size hashed identically and
// the smaller was reported as a duplicate of the larger (seen on the elliptical
// donut). A false positive here marks a good area unbuildable, so the key errs
// wide.
const SHAPE_KEY_FIELDS = [
  'start', 'end', 'center', 'c1', 'c2',
  'radius', 'a', 'b', 'theta', 'angle_start_deg', 'angle_end_deg', 'ccw',
] as const

/** Order-independent identity key for a loop, for duplicate detection. */
function loopKey(loop: LoopEdge[]): string {
  const field = (v: unknown): string => {
    if (Array.isArray(v)) return (v as number[]).map((c) => c.toFixed(9)).join(',')
    if (typeof v === 'number') return v.toFixed(9)
    if (typeof v === 'boolean') return String(v)
    return ''
  }
  return loop
    .map((e) => [String(e['kind'] ?? ''), ...SHAPE_KEY_FIELDS.map((k) => field(e[k]))].join('|'))
    .sort()
    .join(';')
}

/** Shoelace area over an explicitly sampled polygon. */
function shoelace(pts: number[][]): number {
  const n = pts.length
  if (n < 3) return 0
  let acc = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    acc += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
  }
  return acc / 2
}

/**
 * One joint per edge, pairing edge i's end with edge (i+1)'s start, so the last
 * entry is the loop's closure.
 *
 * REQUIRES a head-to-tail oriented loop. That is not a free assumption: the
 * DCEL emits boundaries in cycle order, but `extractProfileLoops` deliberately
 * makes none (features/shared.ts reverses an edge when it attaches backwards),
 * so a raw surface boundary is only conventionally oriented. Callers must pass
 * loops that are ordered -- `validateSketchArea` gets them from
 * `extractProfileLoops`, `sketchLoopsToFace` from the same function upstream --
 * or every joint reads as a spurious gap.
 */
function jointsOf(loop: LoopEdge[]): JointReport[] {
  const n = loop.length
  const out: JointReport[] = []
  for (let i = 0; i < n; i++) {
    const a = loop[i]
    const b = loop[(i + 1) % n]
    const aEnd = endpoint(a, 'end')
    const bStart = endpoint(b, 'start')
    // A loop whose single edge is a complete closed curve has no joint to
    // measure; report 0 rather than a fabricated gap.
    const gap = aEnd.length && bStart.length ? dist2d(aEnd, bStart) : 0
    out.push({
      index: i,
      aKind: String(a['kind'] ?? ''),
      bKind: String(b['kind'] ?? ''),
      aEnd,
      bStart,
      gap,
      aAnchored: ANCHORED_KINDS.has(a['kind'] as string),
      bAnchored: ANCHORED_KINDS.has(b['kind'] as string),
      aEndVertex: vertexId(a, 'end_vertex'),
      bStartVertex: vertexId(b, 'start_vertex'),
    })
  }
  return out
}

function loopReport(loop: LoopEdge[]): LoopReport {
  const joints = jointsOf(loop)
  const areaCoarse = loopSignedArea(loop)
  const areaFine = shoelace(loopPts(loop, CENTROID_ARC_SAMPLES))
  let minChord = Infinity
  for (const e of loop) {
    if (isSelfClosedEdge(e)) continue
    const s = endpoint(e, 'start')
    const en = endpoint(e, 'end')
    if (!s.length || !en.length) continue
    minChord = Math.min(minChord, dist2d(s, en))
  }
  return {
    edgeCount: loop.length,
    kinds: loop.map((e) => String(e['kind'] ?? '')),
    joints,
    // The wrap-around joint (last edge -> first edge) IS the loop's closure.
    closureGap: joints.length ? joints[joints.length - 1].gap : 0,
    areaCoarse,
    areaFine,
    areaRatio: Math.abs(areaFine) > 0 ? Math.abs(areaCoarse) / Math.abs(areaFine) : 1,
    minChord,
    duplicateOf: null,
  }
}

/**
 * Which band of the tolerance ladder a gap falls in, phrased so the constant
 * names appear verbatim in the report (a pasted dump has to be readable without
 * the source next to it).
 */
function gapBand(gap: number): string | null {
  if (gap <= OCC_CONFUSION) return null
  if (gap <= TOL_LOOP_CLOSURE) {
    return `gap ${fmt(gap)} exceeds OCC_CONFUSION (${fmt(OCC_CONFUSION)}): OCC may refuse to connect these edges`
  }
  if (gap <= TOL_TOPOLOGY_MERGE) {
    return (
      `gap ${fmt(gap)} sits between TOL_LOOP_CLOSURE (${fmt(TOL_LOOP_CLOSURE)}) and ` +
      `TOL_TOPOLOGY_MERGE (${fmt(TOL_TOPOLOGY_MERGE)}): the area builder merged what the loop chainer will not join`
    )
  }
  return `gap ${fmt(gap)} exceeds TOL_TOPOLOGY_MERGE (${fmt(TOL_TOPOLOGY_MERGE)}): the loop is genuinely open`
}

/**
 * Measure a profile: per-joint gaps against the tolerance ladder, per-loop area
 * at both sample counts, duplicate loops, degenerate edges, and the containment
 * the face builder will use (plus the same containment at 64 samples, so a
 * nesting decision that only holds on the coarse polygon shows up).
 *
 * `loops` is what `sketchLoopsToFace` receives: loops[0] the outer boundary and
 * loops[1:] its holes, or (from `extractProfileLoops`) every loop of a sketch.
 * Each loop must be HEAD TO TAIL (see `jointsOf`); both of those sources are.
 */
export function describeProfile(loops: LoopEdge[][]): ProfileReport {
  const reports = loops.map(loopReport)

  const seen = new Map<string, number>()
  loops.forEach((loop, i) => {
    const key = loopKey(loop)
    const first = seen.get(key)
    if (first === undefined) seen.set(key, i)
    else reports[i].duplicateOf = first
  })

  // Containment is only a question once there are two loops to nest, and the
  // overwhelmingly common profile is a single boundary. Skipping both passes
  // there also skips two 64-sample centroid polygonisations per solve.
  const single = loops.length < 2
  const coarse = single
    ? { depth: loops.map(() => 0), container: loops.map(() => -1) }
    : loopContainment(loops)
  const { depth, container } = coarse
  const fine = single ? coarse : loopContainment(loops, CENTROID_ARC_SAMPLES)

  const groups: { outer: number; holes: number[] }[] = []
  for (let oi = 0; oi < loops.length; oi++) {
    if (depth[oi] % 2 === 1) continue
    const holes: number[] = []
    for (let i = 0; i < loops.length; i++) {
      if (depth[i] % 2 === 1 && container[i] === oi) holes.push(i)
    }
    groups.push({ outer: oi, holes })
  }

  const reasons: string[] = []
  // Not every reason is an anomaly. A loop of arcs ALWAYS has an areaCoarse far
  // below its true area (the containment polygon samples an arc once), so making
  // that note drive the verdict would mark every circular hole in every sketch
  // suspect and bury the real signals under a dump per solve. Notes go in the
  // report; only the anomalies raise the verdict.
  let suspect = false
  const note = (text: string, isAnomaly = true): void => {
    reasons.push(text)
    if (isAnomaly) suspect = true
  }
  let worstJointGap = 0
  reports.forEach((lr, li) => {
    for (const j of lr.joints) {
      worstJointGap = Math.max(worstJointGap, j.gap)
      const band = gapBand(j.gap)
      if (band === null) continue
      const where = `loop ${li} joint ${j.index} (${j.aKind}/${j.bKind}): `
      note(where + band)
      // Same merged vertex id on both sides of a measurable gap is the exact
      // signature of the merge-versus-confusion mismatch: the area builder
      // called these one point, the coordinates disagree.
      if (j.aEndVertex !== null && j.aEndVertex === j.bStartVertex) {
        note(`${where}both sides carry vertex id ${j.aEndVertex} yet their coordinates differ by ${fmt(j.gap)}`)
      }
      // Neither side can be moved onto the other: snapLoopJoints leaves an
      // anchored/anchored joint exactly as it found it.
      if (j.aAnchored && j.bAnchored) {
        note(`${where}both sides are anchored to a curve, so this joint is unsnappable`)
      }
    }
    if (lr.duplicateOf !== null) {
      note(`loop ${li} duplicates loop ${lr.duplicateOf}`)
    }
    if (lr.minChord < OCC_CONFUSION) {
      note(`loop ${li} has a degenerate edge: shortest chord ${fmt(lr.minChord)} is under OCC_CONFUSION`)
    }
    if (lr.areaRatio < AREA_RATIO_BAND[0] || lr.areaRatio > AREA_RATIO_BAND[1]) {
      // Expected for any curved loop; it only matters once it changes a nesting
      // decision, which the container comparison below catches on its own.
      note(
        `loop ${li} area ratio ${lr.areaRatio.toFixed(4)}: the 1-sample polygon containment runs on ` +
        `a shape that is not the one rendered at ${CENTROID_ARC_SAMPLES} samples`,
        false,
      )
    }
  })
  for (let i = 0; i < loops.length; i++) {
    if (container[i] !== fine.container[i]) {
      note(
        `loop ${i} nests under ${container[i]} at 1 arc sample but under ${fine.container[i]} at ` +
        `${CENTROID_ARC_SAMPLES}: the hole assignment depends on the sampling`,
      )
    }
  }

  return {
    loops: reports,
    depth,
    container,
    groups,
    worstJointGap,
    verdict: suspect ? 'suspect' : 'ok',
    reasons,
  }
}

/** The dump a human pastes into a bug report. */
export function formatProfileReport(r: ProfileReport): string {
  const lines: string[] = []
  lines.push(`profile: ${r.loops.length} loop(s), verdict ${r.verdict}, worstJointGap ${fmt(r.worstJointGap)}`)
  lines.push(`  depth      ${JSON.stringify(r.depth)}`)
  lines.push(`  container  ${JSON.stringify(r.container)}`)
  lines.push(`  groups     ${r.groups.map((g) => `${g.outer}+[${g.holes.join(',')}]`).join(' ') || '(none)'}`)
  r.loops.forEach((lr, li) => {
    lines.push(
      `  loop ${li}: ${lr.edgeCount} edge(s) [${lr.kinds.join(', ')}] closureGap ${fmt(lr.closureGap)} ` +
      `areaCoarse ${lr.areaCoarse.toFixed(9)} areaFine ${lr.areaFine.toFixed(9)} ` +
      `areaRatio ${lr.areaRatio.toFixed(4)} minChord ${fmt(lr.minChord)}` +
      (lr.duplicateOf === null ? '' : ` duplicateOf ${lr.duplicateOf}`),
    )
    for (const j of lr.joints) {
      lines.push(
        `    joint ${j.index} ${j.aKind}->${j.bKind} gap ${fmt(j.gap)} ` +
        `${pt(j.aEnd)} -> ${pt(j.bStart)} ` +
        `vertices ${j.aEndVertex ?? '-'}/${j.bStartVertex ?? '-'} ` +
        `anchored ${j.aAnchored ? 'y' : 'n'}${j.bAnchored ? 'y' : 'n'}`,
      )
    }
  })
  if (r.reasons.length) {
    lines.push('  reasons:')
    for (const reason of r.reasons) lines.push(`    - ${reason}`)
  }
  return lines.join('\n')
}

/** A surface's loops in the order `sketchLoopsToFace` wants them. */
function surfaceLoops(surface: Record<string, unknown>): LoopEdge[][] {
  const boundary = (surface['boundary'] as LoopEdge[] | undefined) ?? []
  const holes = (surface['holes'] as LoopEdge[][] | undefined) ?? []
  if (boundary.length === 0) return []
  return [boundary, ...holes.filter((h) => h.length > 0)]
}

/**
 * Cheap, CONSERVATIVE pre-flight for a sketch area: can this area reach OCC as a
 * profile at all? NECESSARY, NOT SUFFICIENT -- it must not run OCC (the topology
 * pass runs in the solver worker, where the kernel may not be loaded), so it can
 * only catch the metric and structural failures. A `buildable: true` verdict is
 * "nothing here is provably wrong", never "OCC will accept this".
 *
 * The gate is the handoff itself: `extractProfileLoops` is what the extrude and
 * revolve leaves run, and a loop it cannot chain is a loop the kernel never
 * sees. `describeProfile` then supplies the reason, so the user is told which
 * joint and how wide instead of watching the area vanish.
 */
export function validateSketchArea(surface: Record<string, unknown>): AreaValidation {
  const loops = surfaceLoops(surface)
  if (loops.length === 0) {
    return {
      buildable: false,
      reasonCode: 'no_boundary',
      reason: 'the area carries no boundary edges',
    }
  }

  const chained = extractProfileLoops([surface])
  if (chained.length < loops.length) {
    // The chain failed, so there are no ordered loops to describe; the raw
    // boundary is the only thing left to measure. Its joints are read in the
    // order the area builder emitted them, which is a cycle, so the widest gap
    // is still the right thing to name even though the orientation is not
    // guaranteed (see `jointsOf`).
    const band = gapBand(describeProfile(loops).worstJointGap)
    return {
      buildable: false,
      reasonCode: 'loop_not_chained',
      reason:
        `the loop chainer dropped ${loops.length - chained.length} of ${loops.length} loop(s)` +
        (band === null ? '' : `: ${band}`),
    }
  }

  // Past this point the loops ARE ordered, so describe those rather than the raw
  // boundary: they are also exactly what would reach OCC.
  const report = describeProfile(chained)
  const degenerate = report.loops.findIndex((lr) => lr.minChord < OCC_CONFUSION)
  if (degenerate >= 0) {
    return {
      buildable: false,
      reasonCode: 'degenerate_edge',
      reason: `loop ${degenerate} has an edge shorter than OCC_CONFUSION (${fmt(report.loops[degenerate].minChord)})`,
    }
  }
  const duplicate = report.loops.findIndex((lr) => lr.duplicateOf !== null)
  if (duplicate >= 0) {
    return {
      buildable: false,
      reasonCode: 'duplicate_loop',
      reason: `loop ${duplicate} duplicates loop ${report.loops[duplicate].duplicateOf}`,
    }
  }
  return { buildable: true }
}
