// Profile-loop assembly and the diagnostics that explain why a boundary did
// not build. Pure, no OCC: mirrors the Python `_extract_profile_loops` and its
// "no closed profile found" companions.

import { TOL_LOOP_CLOSURE } from '../../solverConstants'
import { ANCHORED_KINDS, loopGeometryKey, type LoopEdge } from '../../profileLoops'

type Dict = Record<string, unknown>

/** A boundary chain that did not form a clean closed loop, for reporting. */
export type ProfileLoopDiag =
  | { kind: 'unclosed'; startedAt: number[]; used: number; total: number; surface?: number }
  | { kind: 'leftover'; leftover: number; total: number; surface?: number }

/**
 * The endpoint position the area builder already MERGED into each vertex id.
 *
 * The builder closes a face combinatorially at TOL_TOPOLOGY_MERGE, by vertex id,
 * and never measures a gap; this assembler re-derived the same loop metrically
 * at TOL_LOOP_CLOSURE, so a joint in between (a hand-typed coordinate 1e-5 off
 * its arc end, well inside what the document keeps) built an area the profile
 * never got. Using the merged vertex's own position makes the two sides agree
 * by construction: the area the user sees IS the area the kernel builds.
 *
 * Which position a merged vertex keeps follows the same anchored-kind rule as
 * `snapLoopJoints`: an arc/ellipse endpoint (pinned to its curve) wins over a
 * line's, so only a free end moves. A vertex all of whose edges are free keeps
 * the first position registered, matching the builder's own `Verts` pool.
 */
function mergedVertexPositions(
  surfaces: Dict[],
): Map<string, { pos: number[]; anchored: boolean }> {
  const out = new Map<string, { pos: number[]; anchored: boolean }>()
  const consider = (edge: Dict, pKey: string, vKey: string): void => {
    const id = edge[vKey]
    const p = edge[pKey]
    if (typeof id !== 'string' || !Array.isArray(p)) return
    const anchored = ANCHORED_KINDS.has(edge.kind as string)
    const prev = out.get(id)
    if (prev === undefined || (!prev.anchored && anchored)) out.set(id, { pos: p, anchored })
  }
  for (const surface of surfaces) {
    const holes = (surface.holes as Dict[][]) ?? []
    for (const boundary of [(surface.boundary as Dict[]) ?? [], ...holes]) {
      for (const e of boundary) {
        consider(e, 'start', 'start_vertex')
        consider(e, 'end', 'end_vertex')
      }
    }
  }
  return out
}

/** Clone `edge` with its endpoints moved onto the merged vertices it names. */
function onMergedVertices(
  edge: Dict,
  merged: Map<string, { pos: number[]; anchored: boolean }>,
): Dict {
  const startId = edge.start_vertex
  const endId = edge.end_vertex
  const startPos = typeof startId === 'string' ? merged.get(startId) : undefined
  const endPos = typeof endId === 'string' ? merged.get(endId) : undefined
  if (startPos === undefined && endPos === undefined) return edge
  const copy: Dict = { ...edge }
  if (startPos !== undefined) copy.start = [...startPos.pos]
  if (endPos !== undefined) copy.end = [...endPos.pos]
  return copy
}

/**
 * Assemble surface boundaries into ordered closed loops (mirrors
 * `_extract_profile_loops`). Each surface's boundary edges are chained by
 * endpoint proximity (within TOL_LOOP_CLOSURE), reversing edges as needed; a
 * reversed arc swaps its angles and flips `ccw`.
 *
 * Each boundary edge whose endpoints name area-builder vertex ids is chained
 * from the MERGED vertex position, not from its own stored endpoint (see
 * `mergedVertexPositions`): the two sides of a joint the builder already fused
 * are the same point even when their coordinates differ inside
 * TOL_TOPOLOGY_MERGE.
 *
 * The optional `diagnostics` out-param collects every boundary that did NOT
 * form a clean closed loop (an unclosed chain, or leftover edges after the
 * first closure). `builtSurfaces` collects the index of every surface that
 * published a loop, for the "built N of M profile areas" accounting. What is
 * BUILT is unchanged - the same `allLoops` as always - but a caller that wants
 * to name the failure can read these alongside it.
 */
export function extractProfileLoops(
  surfaces: Dict[],
  diagnostics?: ProfileLoopDiag[],
  builtSurfaces?: number[],
): Dict[][] {
  if (!surfaces || surfaces.length === 0) return []
  const TOL = TOL_LOOP_CLOSURE
  const merged = mergedVertexPositions(surfaces)

  const dist2d = (a: number[], b: number[]): number =>
    Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)

  const allLoops: Dict[][] = []
  // A nested loop is published twice by the sketch area model: as the filled
  // area inside the curve, and as the hole of the area around it (nest_surfaces
  // copies each nested loop into its container's holes). In a profile that
  // boundary is ONE loop. Keeping both reaches OCC as an outer with two
  // coincident hole wires, so a washer comes out as V_outer - 2 * V_inner --
  // negative for a bore wider than the wall. Only a loop another AREA already
  // published is dropped here; an area that repeats a loop in its own data is
  // malformed and validateSketchArea still refuses it.
  const published = new Set<string>()
  const publish = (loop: Dict[]): void => {
    const key = loopGeometryKey(loop as LoopEdge[])
    if (published.has(key)) return
    published.add(key)
    allLoops.push(loop)
  }
  for (const [surfaceIndex, surface] of surfaces.entries()) {
    const mine = new Set<string>()
    const publishHere = (loop: Dict[]): void => {
      builtSurfaces?.push(surfaceIndex)
      const key = loopGeometryKey(loop as LoopEdge[])
      if (mine.has(key)) {
        // A repeat inside this area's own boundary/holes is the gate's to
        // refuse, not the assembler's to silently fold.
        allLoops.push(loop)
        return
      }
      mine.add(key)
      publish(loop)
    }
    // Emit the outer boundary and every inner hole as separate loops;
    // classifyLoops re-nests them (outer + holes) for the OCC face.
    const holes = (surface.holes as Dict[][]) ?? []
    for (const boundary of [(surface.boundary as Dict[]) ?? [], ...holes]) {
      if (boundary.length === 0) continue

      // A full ellipse is a single self-closed edge with no shared endpoints: it is
      // its own complete loop. (The endpoint-chaining below needs start/end edges,
      // which a full ellipse lacks; a sliced ellipse arrives as ellipse_arc edges.)
      for (const e of boundary) if (e.kind === 'ellipse') publishHere([e])

      const rawEdges: [number[], number[], Dict][] = []
      for (const e of boundary) {
        if (e.kind === 'ellipse') continue
        const se = onMergedVertices(e, merged)
        const s = se.start as number[] | undefined | null
        const en = se.end as number[] | undefined | null
        if (s !== undefined && s !== null && en !== undefined && en !== null) {
          rawEdges.push([s, en, se])
        }
      }
      if (rawEdges.length < 1) continue

      const used = new Set<number>()
      let current = [...rawEdges[0][0]]
      const loop: Dict[] = []
      let closed = false

      for (let _i = 0; _i < rawEdges.length; _i++) {
        let foundNext = false
        for (let i = 0; i < rawEdges.length; i++) {
          if (used.has(i)) continue
          const [s, e, edict] = rawEdges[i]
          const forward = dist2d(current, s) <= TOL
          const reverse = dist2d(current, e) <= TOL
          if (forward || reverse) {
            if (forward) {
              loop.push(edict)
              current = [...e]
            } else {
              const rev: Dict = { ...edict }
              rev.start = [...(edict.end as number[])]
              rev.end = [...(edict.start as number[])]
              // Arc and elliptical-arc carry an angle range + winding that must flip
              // too, else the OCC edge builder rebuilds the wrong (stale) curve.
              if (edict.kind === 'arc' || edict.kind === 'ellipse_arc') {
                rev.angle_start_deg = (edict.angle_end_deg as number) ?? 0
                rev.angle_end_deg = (edict.angle_start_deg as number) ?? 0
                rev.ccw = !((edict.ccw as boolean) ?? true)
              }
              loop.push(rev)
              current = [...s]
            }
            used.add(i)
            foundNext = true
            break
          }
        }
        if (!foundNext) {
          // The chain ran out before closing: the remaining edges cannot form
          // this loop. Emitting nothing made the caller report "no closed profile
          // found", which is true but names neither the area nor the gap.
          diagnostics?.push({
            kind: 'unclosed',
            startedAt: rawEdges[0][0],
            used: used.size,
            total: rawEdges.length,
            surface: surfaceIndex,
          })
          break
        }
        if (dist2d([...rawEdges[0][0]], current) <= TOL && loop.length >= 1) {
          closed = true
          publishHere(loop)
          // The chain closed, but any edge left unconsumed is a second defect:
          // it is part of the same boundary and is being silently discarded.
          const leftover = rawEdges.length - used.size
          if (leftover > 0) {
            diagnostics?.push({ kind: 'leftover', leftover, total: rawEdges.length, surface: surfaceIndex })
          }
          break
        }
      }
      // The outer bound is rawEdges.length, so a chain that consumed EVERY edge
      // without closing back to the start never reaches the foundNext=false
      // branch above (it runs out of iterations first). Same failure, one bound
      // later: name it too. The `used === total` test keeps the two from
      // double-reporting (foundNext=false only fires while edges remain).
      if (!closed && loop.length > 0 && rawEdges.length - used.size === 0) {
        diagnostics?.push({
            kind: 'unclosed',
            startedAt: rawEdges[0][0],
            used: used.size,
            total: rawEdges.length,
            surface: surfaceIndex,
          })
      }
    }
  }

  return allLoops
}

/**
 * The stamped reason of every area in `surfaces` that will not build.
 *
 * This is what makes the `buildable`/`reason` stamp reach a human. The gate runs
 * in the solver worker and marks the area in the viewport, but the moment the
 * user actually needs the sentence is when they picked that area as a profile
 * and the feature refused: "no closed profile found" answers what happened and
 * not why. Reusing the existing red-feature message costs one line at each leaf
 * and needs no new UI surface.
 */
export function unbuildableAreaReasons(surfaces: Dict[]): string[] {
  const out: string[] = []
  for (const surface of surfaces) {
    if (surface.buildable !== false) continue
    const reason = typeof surface.reason === 'string' ? surface.reason : 'no reason recorded'
    if (!out.includes(reason)) out.push(reason)
  }
  return out
}

/**
 * Turn `extractProfileLoops`'s loop-chain diagnostics into the same kind of
 * sentences `unbuildableAreaReasons` produces, so a caller that collects one
 * list for its "no closed profile found" message can fold both in.
 */
export function loopDiagReasons(diags: ProfileLoopDiag[]): string[] {
  const out: string[] = []
  for (const d of diags) {
    if (d.kind === 'unclosed') {
      out.push(
        `a sketch-area boundary chain is unclosed (${d.used} of ${d.total} edges ` +
        'connected before the chain ran out)',
      )
    } else {
      out.push(
        `a sketch-area boundary left ${d.leftover} of ${d.total} edge(s) unused ` +
        'after its first closed loop',
      )
    }
  }
  return out
}

/** How a profile reference's area set fared, for the partial-profile report. */
export interface ProfileAreaReport {
  /** Areas in the referenced set that produced at least one loop. */
  built: number
  /** Areas the reference names: every area of a whole sketch, or the picked ones. */
  total: number
  /** One sentence per distinct failure, empty when the whole set built. */
  reasons: string[]
}

/**
 * The "built N of M profile areas" accounting for one profile reference.
 *
 * `surfaces` must be the REFERENCED set, not the sketch: a whole-sketch ref
 * names every area, an area pick names only the picked ones. An area the user
 * deliberately did not pick is not unbuildable and must not be reported as
 * such, or a broken area elsewhere in the sketch would turn an unrelated
 * extrude partial.
 *
 * `builtSurfaces` is `extractProfileLoops`'s index list (one entry per
 * published loop). A documented diagnostic is a failure even when the boundary
 * still published a loop: its leftover edges were dropped from the profile.
 */
export function profileAreaReport(
  surfaces: Dict[],
  builtSurfaces: number[] | undefined,
  diags: ProfileLoopDiag[],
): ProfileAreaReport {
  const total = surfaces.length
  const builtSet = new Set(builtSurfaces ?? [])
  const failed = new Set<number>()
  if (builtSurfaces === undefined) {
    surfaces.forEach((surface, i) => {
      if (surface.buildable === false) failed.add(i)
    })
  } else {
    surfaces.forEach((_, i) => {
      if (!builtSet.has(i)) failed.add(i)
    })
  }
  for (const d of diags) {
    if (typeof d.surface === 'number' && d.surface >= 0 && d.surface < total) failed.add(d.surface)
  }
  const reasons: string[] = []
  for (const i of [...failed].sort((a, b) => a - b)) {
    const reason = surfaces[i].buildable === false ? surfaces[i].reason : undefined
    if (typeof reason === 'string' && !reasons.includes(reason)) reasons.push(reason)
  }
  for (const reason of loopDiagReasons(diags)) {
    if (!reasons.includes(reason)) reasons.push(reason)
  }
  return { built: total - failed.size, total, reasons }
}
