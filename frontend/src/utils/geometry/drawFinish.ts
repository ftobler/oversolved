// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// The stamp-down half of the drawing tools, kept out of drawLogic so the editor
// state store can import it without pulling drawGeometry (and through it the
// rendering layer) into the headless module closure. See
// utils/__tests__/codeConventions.test.ts.
import type { Mutation } from '@/types/cad'
import { insertCoincidentPoint, SNAP_EPS } from '@/utils/geometry/drawAutoConstraints'
import { sameSnapVertex } from '@/utils/snapRefs'

/** The result shape `computeDrawClick` and `computeDrawFinish` share. Declared
 *  here rather than in drawLogic so this module (and the store that imports it)
 *  stays free of the geometry/render import graph; drawLogic re-exports it
 *  under the name its click callers already use. */
export interface DrawClickResult {
  mutations: Mutation[]
  /**
   * null  -- leave draw points unchanged
   * array -- replace draw points with this array (intermediate clicks, arc 2nd click)
   */
  nextDrawPoints: [number, number][] | null
  // null means leave the carried draw snaps unchanged; an object replaces them.
  // One ref per placed point, index-aligned with drawPoints, each naming either
  // a vertex or a whole entity (a point on that curve). A gesture whose entity
  // is created several clicks after a snapped point (the arc's two ends, the
  // spline's start) reads its own click's ref back out of this list.
  nextDrawSnap: { refs: (string | null)[] } | null
  // true when this click completed the gesture and produced its entity; the
  // adapter clears the draw buffer and consults the tool's
  // `staysArmedAfterCommit` policy to decide whether to keep the tool armed.
  gestureComplete: boolean
}

/** True when two sketch points are close enough for the area builder to merge
 *  them. The fit spline uses it both to detect a closing click and to refuse a
 *  repeated point. */
export function pointsCoincide(a: readonly [number, number], b: readonly [number, number]): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= SNAP_EPS
}

/** The mutation block of a finished fit spline. Shared by the closing click
 *  (`computeDrawClick`) and the stamp-down commands (`computeDrawFinish`) so
 *  both author the same entity and the same point constraints. */
export function finishFitSplineMutations(
  featureId: string,
  points: readonly [number, number][],
  refs: readonly (string | null)[],
  newEntityIdFn: () => string,
): DrawClickResult {
  const fitId = newEntityIdFn()
  const params = points.flatMap(p => [p[0], p[1]])
  const mutations: Mutation[] = [
    { type: 'add_entity', featureId, kind: 'fit_spline', params, entityId: fitId },
  ]
  refs.forEach((ref, i) => {
    if (!ref) return
    const key = i === 0 ? 'start' : i === points.length - 1 ? 'end' : `fit${i}`
    // A closed curve's end is the start vertex; the start constraint already
    // ties it down.
    if (i === points.length - 1 && sameSnapVertex(ref, refs[0] ?? null)) return
    mutations.push(...insertCoincidentPoint(ref, {
      featureId, vertexRef: `vertex:${featureId}:${fitId}:${key}`,
    }))
  })
  return { mutations, nextDrawPoints: null, nextDrawSnap: null, gestureComplete: true }
}

/** The fit points a stamp-down would commit: the buffer minus any trailing
 *  point that repeats its predecessor. Two clicks can resolve to one spot (a
 *  snap, a repeated press), and a spline made of one unique point has no
 *  shape. */
function finishableFitPoints(
  drawPoints: readonly [number, number][],
  drawSnapRefs: readonly (string | null)[],
): { points: [number, number][]; refs: (string | null)[] } {
  const points = drawPoints.map(p => [p[0], p[1]] as [number, number])
  const refs = points.map((_, i) => drawSnapRefs[i] ?? null)
  while (points.length > 1 && pointsCoincide(points[points.length - 1], points[points.length - 2])) {
    points.pop()
    refs.pop()
  }
  return { points, refs }
}

/** Whether the gesture in progress can be stamped down as an entity. Only the
 *  fit spline has a variable point count, so it is the only tool with something
 *  left to finish; every other drawing tool completes on its own last click. */
export function canFinishDraw(tool: string | null, drawPoints: readonly [number, number][]): boolean {
  if (tool !== 'fit_spline') return false
  return finishableFitPoints(drawPoints, []).points.length >= 2
}

/**
 * Finishes the gesture in progress instead of adding one more point: the action
 * Enter, a right click and a double click mean while a fit spline is being
 * drawn. A result with `gestureComplete: false` means there was nothing to
 * stamp down and the buffer must be left untouched.
 */
export function computeDrawFinish(
  tool: string,
  drawPoints: readonly [number, number][],
  drawSnapRefs: readonly (string | null)[],
  featureId: string,
  newEntityIdFn: () => string,
): DrawClickResult {
  const nothing: DrawClickResult = { mutations: [], nextDrawPoints: null, nextDrawSnap: null, gestureComplete: false }
  if (tool !== 'fit_spline') return nothing
  const { points, refs } = finishableFitPoints(drawPoints, drawSnapRefs)
  if (points.length < 2) return nothing
  // No closing special case: a click back on the first point closes the curve
  // on the pointer path (which appends the repeated seam point) and clears the
  // buffer, so a staged gesture can never end on its own start. A buffer that
  // happens to carry one is committed as authored.
  return finishFitSplineMutations(featureId, points, refs, newEntityIdFn)
}
