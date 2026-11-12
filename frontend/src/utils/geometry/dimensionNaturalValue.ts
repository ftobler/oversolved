// PURE LOGIC -- no Three.js, no React, no R3F hooks.
// Importable in a plain vitest test.

import type {
  PartConstraint, Point, Sketch,
  DimLinearRender, DimRadiusRender, DimDiameterRender, DimAngleRender,
} from '@/types/cad'
import { parseTarget } from '@/utils/yamlMutations/helpers'
import { computeConstraintRender } from '@/utils/geometry/geometryMapping'
import type { ConstraintRenderContext } from '@/utils/geometry/geometryMapping'
import { computeAngleDimension, shorterSpan } from '@/utils/geometry/angleDimensionLogic'
import type { AngleDimGeometry } from '@/utils/geometry/angleDimensionLogic'

const DEG = 180 / Math.PI

/** The render context for a dimension authored in the active sketch: its
 *  document origin in the sketch's local frame, which the render needs to place
 *  an `@builtin_origin` operand. Absent means a builtin plane ([0,0]). */
function renderCtx(originLocal?: Point): ConstraintRenderContext {
  return originLocal ? { originLocal } : {}
}

/**
 * Compute the natural measurement for a freshly-placed dimension so the value-
 * edit dialog can pre-fill it. Returns null when geometry can't be resolved
 * (the dialog then opens with an empty default).
 *
 * Reuses the same query-resolution path as the post-solve dimension rendering
 * (computeConstraintRender), so the value here matches what the solver would
 * report after the constraint is added with no value set.
 */
/**
 * Resolve the two endpoints of a two-point dimension (point_distance, or its
 * X/Y variants) from the sketch. Returns [pa, pb] in world coords or null
 * when either point can't be resolved. Mirrors the point-finding path used
 * by computeConstraintRender so the values are always consistent.
 */
export function resolveDimPoints(
  kind: string,
  targets: readonly string[],
  sketch: Sketch,
  featureId: string,
  originLocal?: Point,
): [[number, number], [number, number]] | null {
  if (targets.length < 2) return null
  const c: PartConstraint = { id: '__resolve__', kind }
  const refs = targets.map(t => parseTarget(t, featureId))
  c.a = refs[0]
  c.b = refs[1]
  const render = computeConstraintRender(c, sketch, renderCtx(originLocal)) as
    DimLinearRender | DimRadiusRender | DimDiameterRender | DimAngleRender | { kind: 'unknown' | string }
  if (render.kind === 'dim_linear' || render.kind === 'dim_radius' || render.kind === 'dim_diameter') {
    const r = render as DimLinearRender | DimRadiusRender | DimDiameterRender
    return [r.p1, r.p2]
  }
  return null
}

/** The unsigned angle between two lines' stored direction vectors, in degrees,
 *  in [0, 180]: the number an `angle` constraint stores as its value. */
export function linePairAngle(
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
  p4: readonly [number, number],
): number {
  const d1x = p2[0] - p1[0]
  const d1y = p2[1] - p1[1]
  const d2x = p4[0] - p3[0]
  const d2y = p4[1] - p3[1]
  const dot = d1x * d2x + d1y * d2y
  const cross = d1x * d2y - d1y * d2x
  return Math.atan2(Math.abs(cross), dot) * DEG
}

export function computeNaturalDimensionValue(
  kind: string,
  targets: readonly string[],
  sketch: Sketch,
  featureId: string,
  originLocal?: Point,
): number | null {
  const c: PartConstraint = { id: '__preview__', kind }
  const refs = targets.map(t => parseTarget(t, featureId))

  if (kind === 'length' || kind === 'radius' || kind === 'diameter') {
    c.target = refs[0]
  } else {
    c.a = refs[0]
    c.b = refs[1]
  }

  // Cast required because SymbolRender's `kind: string` collides with the
  // string-literal kinds of the dim variants, so TS won't narrow on `kind`
  // alone. The geometryMapping branch we hit for length / radius / diameter /
  // distance / angle definitely returns the matching shape.
  const render = computeConstraintRender(c, sketch, renderCtx(originLocal)) as
    DimLinearRender | DimRadiusRender | DimDiameterRender | DimAngleRender | { kind: 'unknown' | string }
  if (render.kind === 'dim_linear' || render.kind === 'dim_radius' || render.kind === 'dim_diameter') {
    const r = render as DimLinearRender | DimRadiusRender | DimDiameterRender
    return Math.hypot(r.p2[0] - r.p1[0], r.p2[1] - r.p1[1])
  }
  if (render.kind === 'dim_angle') {
    // Smaller of the two opposite angles between the two line directions,
    // in degrees. Matches the solver's angle constraint (angle in [0, 180]).
    const r = render as DimAngleRender
    return linePairAngle(r.p1, r.p2, r.p3, r.p4)
  }
  return null
}

/**
 * Orientation sign (+1 / -1) for a directional dimension, derived from the
 * current geometry so that the constraint authored at +value already holds at
 * the side the user drew (creation never mirrors the sketch). Returns null for
 * non-directional kinds (length / radius / diameter / euclidean
 * point_distance), which have no side.
 *
 *   point_distance_x -> sign of (b.x - a.x)
 *   point_distance_y -> sign of (b.y - a.y)
 *   angle            -> sign of the directed cross product dirA x dirB, matching
 *                       the Rust residual's signed `atan2(cross, dot)`.
 *
 * A zero / near-zero measure resolves to +1 (an arbitrary but stable default;
 * the side is indeterminate when the points coincide on that axis).
 */
export function computeDimensionSign(
  kind: string,
  targets: readonly string[],
  sketch: Sketch,
  featureId: string,
  originLocal?: Point,
): number | null {
  const c: PartConstraint = { id: '__sign__', kind }
  const refs = targets.map(t => parseTarget(t, featureId))
  c.a = refs[0]
  c.b = refs[1]
  return dimensionSignFromConstraint(c, sketch, originLocal)
}

/**
 * Same as `computeDimensionSign` but reads the operand refs straight off an
 * existing constraint, via the render path so the side matches what the
 * dimension is drawn against.
 */
export function dimensionSignFromConstraint(
  c: PartConstraint,
  sketch: Sketch,
  originLocal?: Point,
): number | null {
  if (c.kind === 'point_distance_x' || c.kind === 'point_distance_y') {
    const render = computeConstraintRender(c, sketch, renderCtx(originLocal)) as DimLinearRender | { kind: string }
    if (render.kind !== 'dim_linear') return null
    const r = render as DimLinearRender
    return linearDimensionSign(c.kind, r.p1, r.p2)
  }
  if (c.kind === 'line_distance') {
    const render = computeConstraintRender(c, sketch, renderCtx(originLocal)) as DimLinearRender | { kind: string }
    if (render.kind !== 'dim_linear') return null
    const r = render as DimLinearRender
    return lineDistanceSign(r.p1, r.p2, r.normal)
  }
  if (c.kind === 'angle') {
    const render = computeConstraintRender(c, sketch, renderCtx(originLocal)) as DimAngleRender | { kind: string }
    if (render.kind !== 'dim_angle') return null
    const r = render as DimAngleRender
    return angleDimensionSign(r.p1, r.p2, r.p3, r.p4)
  }
  return null
}

// ─── Pure sign-from-geometry helpers ───
// Shared by the creation path (constraint + sketch) and the live flip button
// (which already holds the rendered dim geometry). The current side is the sign
// of the signed measure; flipping is just negating the result.

/** Current side of an axis distance: sign of (b - a) along x (or y). +1/-1. */
export function linearDimensionSign(
  kind: string,
  p1: readonly [number, number],
  p2: readonly [number, number],
): number {
  const d = kind === 'point_distance_y' ? p2[1] - p1[1] : p2[0] - p1[0]
  return d < 0 ? -1 : 1
}

/** Current side of a perpendicular point-to-line distance: sign of the offset
 *  of `p2` (the point) from `p1` (its foot on the line) along the measurement
 *  direction. `normal` is the rendered line direction, so the measurement
 *  direction is its perpendicular `(-normal.y, normal.x)`, matching the solver's
 *  signed projection `(pb - line_start) . (-dy, dx)/n`. +1/-1. */
export function lineDistanceSign(
  p1: readonly [number, number],
  p2: readonly [number, number],
  normal: readonly [number, number],
): number {
  const t = (p2[0] - p1[0]) * -normal[1] + (p2[1] - p1[1]) * normal[0]
  return t < 0 ? -1 : 1
}

/** Current handedness of an angle: sign of the directed cross dirA x dirB,
 *  matching the solver's signed `atan2(cross, dot)`. +1/-1. */
export function angleDimensionSign(
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
  p4: readonly [number, number],
): number {
  const cross = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0])
  return cross < 0 ? -1 : 1
}

/**
 * Convert an absolute world-space placement point to the anchor-relative
 * offset (`pos`) expected by the dim renderers. Each renderer interprets
 * `pos` relative to its dim-specific anchor:
 *
 *   dim_linear   -> anchor = midpoint(p1, p2)
 *   dim_radius   -> anchor = p1 (center)
 *   dim_diameter -> anchor = midpoint(p1, p2)  (which is the circle center)
 *   dim_angle    -> anchor = the two lines' intersection vertex
 *
 * Returns null when the kind isn't a supported dim or geometry can't resolve.
 * Angle dims fall back to null because the vertex is computed inside
 * angleDimensionLogic and we'd duplicate the math here for marginal value --
 * angle dims revert to the default placement and the user drags.
 */
export function computeAnchorRelativePos(
  kind: string,
  targets: readonly string[],
  sketch: Sketch,
  featureId: string,
  world: readonly [number, number],
  originLocal?: Point,
): [number, number] | null {
  const c: PartConstraint = { id: '__preview__', kind }
  const refs = targets.map(t => parseTarget(t, featureId))
  if (kind === 'length' || kind === 'radius' || kind === 'diameter') {
    c.target = refs[0]
  } else {
    c.a = refs[0]
    c.b = refs[1]
  }

  const render = computeConstraintRender(c, sketch, renderCtx(originLocal)) as
    DimLinearRender | DimRadiusRender | DimDiameterRender | DimAngleRender | { kind: 'unknown' | string }

  if (render.kind === 'dim_radius') {
    const r = render as DimRadiusRender
    return [world[0] - r.p1[0], world[1] - r.p1[1]]
  }
  if (render.kind === 'dim_linear' || render.kind === 'dim_diameter') {
    const r = render as DimLinearRender | DimDiameterRender
    const ax = (r.p1[0] + r.p2[0]) / 2
    const ay = (r.p1[1] + r.p2[1]) / 2
    return [world[0] - ax, world[1] - ay]
  }
  if (render.kind === 'dim_angle') {
    const r = render as DimAngleRender
    const base = computeAngleDimension(r.p1, r.p2, r.p3, r.p4)
    return [world[0] - base.vx, world[1] - base.vy]
  }
  return null
}

/**
 * True when an angle dimension placed at `world` lands in a supplement quadrant,
 * where the label shows (and edits against) 180 - theta rather than the stored
 * theta. Mirrors AngleDimension's `isSupplement`, so the creation dialog can
 * pre-fill and commit the same value the live preview label displays. Returns
 * false for non-angle kinds or when geometry / placement can't be resolved.
 */
export function computeAnglePlacementIsSupplement(
  targets: readonly string[],
  sketch: Sketch,
  featureId: string,
  world: readonly [number, number] | null,
  originLocal?: Point,
): boolean {
  if (!world) return false
  const refs = targets.map(t => parseTarget(t, featureId))
  const c: PartConstraint = { id: '__supplement__', kind: 'angle', a: refs[0], b: refs[1] }
  const render = computeConstraintRender(c, sketch, renderCtx(originLocal)) as DimAngleRender | { kind: string }
  if (render.kind !== 'dim_angle') return false
  const r = render as DimAngleRender
  const base = computeAngleDimension(r.p1, r.p2, r.p3, r.p4)
  const pos: [number, number] = [world[0] - base.vx, world[1] - base.vy]
  return computeAngleDimension(r.p1, r.p2, r.p3, r.p4, pos).isSupplement
}

/** The bisector, in degrees, of the supplement wedge nearest the base
 *  geometry's default label direction. The two supplement wedges sit on
 *  opposite sides of the crossing; the label belongs in the one the drawn
 *  corner is on, not the far one. */
function nearestSupplementBisector(
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
  p4: readonly [number, number],
  base: AngleDimGeometry,
): number {
  const dirA = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) * DEG
  const dirB = Math.atan2(p4[1] - p3[1], p4[0] - p3[0]) * DEG
  const first = dirA + 180 + shorterSpan(dirA + 180, dirB) / 2
  const second = first + 180
  const distance = (angle: number) => Math.abs(shorterSpan(base.labelAngleDeg, angle))
  return distance(first) <= distance(second) ? first : second
}

export interface AngleStoredValueArgs {
  // The angle constraint being authored or edited; its `a`/`b` name the two
  // lines whose stored directions define theta.
  constraint: PartConstraint
  // The number the dimension label shows (or, for a fresh label, the number
  // the author typed for the corner).
  value: number
  sketch: Sketch
  // The label offset the caller holds, in the stored anchor-relative form.
  pos?: [number, number] | null
  // True for a fresh `add_constraint` with no label yet. Without a `pos` the
  // typed value then picks the wedge it names (nearest the drawn theta0 or its
  // supplement) and the returned `pos` places the label there. False treats a
  // missing `pos` as the renderer's default wedge, which is where an existing
  // label already is.
  newLabel?: boolean
}

export interface AngleStoredValue {
  // The value the document stores: the unsigned angle between the two lines'
  // direction vectors, in [0, 180].
  theta: number
  // A label offset to store when the caller authored none and the typed value
  // names a supplement wedge.
  pos?: [number, number]
}

/**
 * Translate an angle mutation's value, the number the label shows, into the
 * value the solver stores (theta). The label's wedge decides the mapping: the
 * two wedges bounded by the direction vectors subtend theta and show theta, the
 * other two show 180 - theta. A stored `pos` names its wedge; without one the
 * renderer's default does, which is what the UI has always displayed and edited
 * against. This is the only place the conversion lives, so a dimension dialog,
 * an MCP call and a script mean the same number by construction.
 *
 * Returns null when the operands do not resolve to two lines, so the caller can
 * keep the value it was given.
 */
export function angleStoredValue({
  constraint, value, sketch, pos, newLabel = false,
}: AngleStoredValueArgs): AngleStoredValue | null {
  const render = computeConstraintRender(constraint, sketch) as DimAngleRender | { kind: string }
  if (render.kind !== 'dim_angle') return null
  const { p1, p2, p3, p4 } = render as DimAngleRender
  // A malformed offset cannot name a wedge; the caller would drop it at the
  // document boundary, so read the renderer's default instead of a NaN frame.
  const labelPos = pos && Number.isFinite(pos[0]) && Number.isFinite(pos[1]) ? pos : undefined
  const placed = computeAngleDimension(p1, p2, p3, p4, labelPos)
  if (!newLabel || labelPos) {
    return { theta: placed.isSupplement ? 180 - value : value }
  }
  // A fresh label has no wedge of its own. The typed number picks the wedge
  // nearest the drawn corner, so a headless author can type the corner they
  // see instead of the invisible direction-vector angle. A tie keeps
  // theta = value: the drawn theta wedge, and the only sane reading on the
  // right-angle corners where the two wedges are the same size.
  const theta0 = linePairAngle(p1, p2, p3, p4)
  const supplement = 180 - value
  if (Math.abs(supplement - theta0) < Math.abs(value - theta0)) {
    const labelAngle = nearestSupplementBisector(p1, p2, p3, p4, placed)
    const rad = labelAngle * (Math.PI / 180)
    return {
      theta: supplement,
      pos: [placed.arcR * Math.cos(rad), placed.arcR * Math.sin(rad)],
    }
  }
  return { theta: value }
}
