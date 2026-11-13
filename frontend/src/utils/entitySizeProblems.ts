// The geometric size floor an entity must clear to bound, sweep or silhouette
// anything. One predicate feeds both sides of the authoring boundary: the drive
// value rules refuse a step that stores a degenerate curve, and the sketch
// appliers refuse the same seed from a draw tool or a dispatch that skipped the
// drive. The solved sketch reads it too, because a document can still carry a
// degenerate curve from a load, a projection or a solve that drove a dimension
// to zero.
//
// The floor is TOL_TOPOLOGY_MERGE, the world-space vertex merge: two points
// closer than that are one, so a curve inside it has no separable endpoints and
// can never bound a region. It is deliberately not a separate epsilon, which
// would leave the author, the profile builder and the writer disagreeing about
// what "zero" means.
import { TOL_TOPOLOGY_MERGE } from '@/kernel/solverConstants'

/** The accepted minimum for one size scalar. Exported so a drag clamp and the
 *  size rule cannot disagree about where zero begins. */
export const ENTITY_SIZE_FLOOR = TOL_TOPOLOGY_MERGE
const MIN_SIZE = ENTITY_SIZE_FLOOR
const MIN_SIZE_TEXT = `TOL_TOPOLOGY_MERGE (${MIN_SIZE})`

// Below this a degree span describes the same point twice; the arc bounds no
// region and only reaches the builder as a sliver. Legitimate small arcs (a
// chamfer relief, a degree-scale fillet) are far above it. The drive and the
// solved sketch read this one rule, so an authored arc and a solve-flipped one
// are judged the same way.
const DEGENERATE_ARC_SPAN_DEG = 1e-6

/** One solved curve the size rule rejects. The solve result carries this list
 *  so a caller (the tree verdict, the drive reply) can name the cause without
 *  parsing the joined warning text. */
export interface DegenerateEntity {
  id: string
  reason: string
}

/** The warning row a degenerate solved entity contributes. */
export function degenerateEntityWarning(id: string, reason: string): string {
  return `entity ${id} is degenerate (${reason}); it is left out of profiles`
}

/**
 * Why a circle or arc radius cannot bound a region, or null when it can.
 * `label` names the field the caller refused (`radius` on a circle, a
 * `diameter` dimension's driven radius, ...).
 */
export function circleRadiusProblem(radius: number, label = 'radius'): string | null {
  if (radius > MIN_SIZE) return null
  return `${label} ${radius} is not greater than ${MIN_SIZE_TEXT}, so the curve encloses no area`
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay)
}

/**
 * The size reason an entity's flat params carry, or null when the curve clears
 * the floor. The kinds without a size (a point, a fit spline whose span rules
 * live in the fit-point writer) return null. A param block of an unexpected
 * length is left to the arity rule that owns it, so this never turns a shape
 * error into a size error.
 */
export function entitySizeProblem(kind: string, params: readonly number[]): string | null {
  switch (kind) {
    case 'line':
      if (params.length < 4) return null
      return lineSizeProblem(params[0], params[1], params[2], params[3])
    case 'circle':
      if (params.length < 3) return null
      return circleRadiusProblem(params[2], 'circle radius')
    case 'arc': {
      if (params.length < 5) return null
      return circleRadiusProblem(params[2], 'arc radius') ?? arcSpanProblem(params[3], params[4])
    }
    case 'ellipse':
      if (params.length < 4) return null
      return ellipseSizeProblem(params[2], params[3])
    case 'spline':
      if (params.length < 8) return null
      return splineSizeProblem(params)
    default:
      return null
  }
}

/** A degree span that describes the same point twice. No unit guessing: a degree
 *  value is simply taken as degrees. The hint only fires when the pair is inside
 *  one turn in radians, the exact shape of a radian value stored in a degree
 *  slot. */
function arcSpanProblem(start: number, end: number): string | null {
  const span = Math.abs(end - start)
  if (span > DEGENERATE_ARC_SPAN_DEG) return null
  const looksRadian = Math.abs(start) <= 2 * Math.PI && Math.abs(end) <= 2 * Math.PI
  const hint = looksRadian
    ? '; the pair looks like radians, but arc angles are degrees (a quarter turn is 90, a full turn 360)'
    : ''
  return `arc angles are degrees, and ${start} to ${end} spans ${span} degrees, so the arc has no extent${hint}`
}

function lineSizeProblem(x0: number, y0: number, x1: number, y1: number): string | null {
  const span = distance(x0, y0, x1, y1)
  if (span > MIN_SIZE) return null
  return `line start (${x0}, ${y0}) and end (${x1}, ${y1}) are ${span} apart, `
    + `inside ${MIN_SIZE_TEXT}, so it has no length`
}

/**
 * An ellipse's axes are both sizes and their order is part of what `theta`
 * means. The writer refuses `a < b` on purpose (a gp_Elips_2 construction error
 * is uncatchable), so the boundary refuses it first and spells the equivalent
 * params: swapping a and b turns the stored theta into a different angle, which
 * is why this is a refusal rather than a silent normalisation.
 */
function ellipseSizeProblem(a: number, b: number): string | null {
  const aProblem = circleRadiusProblem(a, 'ellipse a (major)')
  if (aProblem !== null) return aProblem
  const bProblem = circleRadiusProblem(b, 'ellipse b (minor)')
  if (bProblem !== null) return bProblem
  if (a >= b) return null
  return `ellipse a (major) ${a} is less than b (minor) ${b}; `
    + 'the same ellipse is [cx, cy, b, a, theta + 90]'
}

/** A cubic spline has no region when all four control points are the same
 *  point. Coincident endpoints with spread controls are a closed loop and stay
 *  legal. */
function splineSizeProblem(params: readonly number[]): string | null {
  const [x, y] = [params[0], params[1]]
  for (let i = 2; i < 8; i += 2) {
    if (params[i] !== x || params[i + 1] !== y) return null
  }
  return `spline control points are all coincident at (${x}, ${y}), so it has no extent`
}

/**
 * Why a radius or diameter dimension cannot drive its curve, or null. The
 * dimension values are the solver's own: `radius` is r, `diameter` is 2r, so
 * the diameter floor is twice the radius floor.
 */
export function dimensionSizeProblem(kind: string, value: number): string | null {
  if (kind === 'radius') return circleRadiusProblem(value)
  if (kind === 'diameter') {
    const radius = value / 2
    if (radius > MIN_SIZE) return null
    return `diameter ${value} drives a radius of ${radius}, which is not greater than ${MIN_SIZE_TEXT}, `
      + 'so the circle encloses no area'
  }
  return null
}
