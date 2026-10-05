// Profile-loop assembly and the diagnostics that explain why a boundary did
// not build. Pure, no OCC: mirrors the Python `_extract_profile_loops` and its
// "no closed profile found" companions.

import { TOL_LOOP_CLOSURE } from '../../solverConstants'

type Dict = Record<string, unknown>

/** A boundary chain that did not form a clean closed loop, for reporting. */
export type ProfileLoopDiag =
  | { kind: 'unclosed'; startedAt: number[]; used: number; total: number }
  | { kind: 'leftover'; leftover: number; total: number }

/**
 * Assemble surface boundaries into ordered closed loops (mirrors
 * `_extract_profile_loops`). Each surface's boundary edges are chained by
 * endpoint proximity (within TOL_LOOP_CLOSURE), reversing edges as needed; a
 * reversed arc swaps its angles and flips `ccw`.
 *
 * The optional `diagnostics` out-param collects every boundary that did NOT
 * form a clean closed loop (an unclosed chain, or leftover edges after the
 * first closure). What is BUILT is unchanged - the same `allLoops` as always -
 * but a caller that wants to name the failure can read these alongside it.
 */
export function extractProfileLoops(surfaces: Dict[], diagnostics?: ProfileLoopDiag[]): Dict[][] {
  if (!surfaces || surfaces.length === 0) return []
  const TOL = TOL_LOOP_CLOSURE

  const dist2d = (a: number[], b: number[]): number =>
    Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)

  const allLoops: Dict[][] = []
  for (const surface of surfaces) {
    // Emit the outer boundary and every inner hole as separate loops;
    // classifyLoops re-nests them (outer + holes) for the OCC face.
    const holes = (surface.holes as Dict[][]) ?? []
    for (const boundary of [(surface.boundary as Dict[]) ?? [], ...holes]) {
      if (boundary.length === 0) continue

      // A full ellipse is a single self-closed edge with no shared endpoints: it is
      // its own complete loop. (The endpoint-chaining below needs start/end edges,
      // which a full ellipse lacks; a sliced ellipse arrives as ellipse_arc edges.)
      for (const e of boundary) if (e.kind === 'ellipse') allLoops.push([e])

      const rawEdges: [number[], number[], Dict][] = []
      for (const e of boundary) {
        if (e.kind === 'ellipse') continue
        const s = e.start as number[] | undefined | null
        const en = e.end as number[] | undefined | null
        if (s !== undefined && s !== null && en !== undefined && en !== null) {
          rawEdges.push([s, en, e])
        }
      }
      if (rawEdges.length < 1) continue

      const used = new Set<number>()
      let current = [...rawEdges[0][0]]
      const loop: Dict[] = []

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
          diagnostics?.push({ kind: 'unclosed', startedAt: rawEdges[0][0], used: used.size, total: rawEdges.length })
          break
        }
        if (dist2d([...rawEdges[0][0]], current) <= TOL && loop.length >= 1) {
          allLoops.push(loop)
          // The chain closed, but any edge left unconsumed is a second defect:
          // it is part of the same boundary and is being silently discarded.
          const leftover = rawEdges.length - used.size
          if (leftover > 0) {
            diagnostics?.push({ kind: 'leftover', leftover, total: rawEdges.length })
          }
          break
        }
      }
      // The outer bound is rawEdges.length, so a chain that consumed EVERY edge
      // without closing back to the start never reaches the foundNext=false
      // branch above (it runs out of iterations first). Same failure, one bound
      // later: name it too. The `used === total` test keeps the two from
      // double-reporting (foundNext=false only fires while edges remain).
      if (loop.length > 0 && rawEdges.length - used.size === 0) {
        diagnostics?.push({ kind: 'unclosed', startedAt: rawEdges[0][0], used: used.size, total: rawEdges.length })
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
