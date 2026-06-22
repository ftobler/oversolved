// PURE LOGIC -- no Three.js, no React, no R3F hooks.
// Importable in a plain vitest test.

import type {
  PartConstraint, Sketch,
  DimLinearRender, DimRadiusRender, DimDiameterRender, DimAngleRender,
} from '@/types/cad'
import { parseTarget } from '@/utils/yamlMutations/helpers'
import { computeConstraintRender } from '@/utils/geometry/geometryMapping'
import { computeAngleDimension } from '@/components/Geometry3D/dimensions/angleDimensionLogic'

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
): [[number, number], [number, number]] | null {
  if (targets.length < 2) return null
  const c: PartConstraint = { id: '__resolve__', kind }
  const refs = targets.map(t => parseTarget(t, featureId))
  c.a = refs[0]
  c.b = refs[1]
  const render = computeConstraintRender(c, sketch) as
    DimLinearRender | DimRadiusRender | DimDiameterRender | DimAngleRender | { kind: 'unknown' | string }
  if (render.kind === 'dim_linear' || render.kind === 'dim_radius' || render.kind === 'dim_diameter') {
    const r = render as DimLinearRender | DimRadiusRender | DimDiameterRender
    return [r.p1, r.p2]
  }
  return null
}

export function computeNaturalDimensionValue(
  kind: string,
  targets: readonly string[],
  sketch: Sketch,
  featureId: string,
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
  const render = computeConstraintRender(c, sketch) as
    DimLinearRender | DimRadiusRender | DimDiameterRender | DimAngleRender | { kind: 'unknown' | string }
  if (render.kind === 'dim_linear' || render.kind === 'dim_radius' || render.kind === 'dim_diameter') {
    const r = render as DimLinearRender | DimRadiusRender | DimDiameterRender
    return Math.hypot(r.p2[0] - r.p1[0], r.p2[1] - r.p1[1])
  }
  if (render.kind === 'dim_angle') {
    // Smaller of the two opposite angles between the two line directions,
    // in degrees. Matches the solver's angle constraint (angle in [0, 180]).
    const r = render as DimAngleRender
    const d1x = r.p2[0] - r.p1[0]
    const d1y = r.p2[1] - r.p1[1]
    const d2x = r.p4[0] - r.p3[0]
    const d2y = r.p4[1] - r.p3[1]
    const dot = d1x * d2x + d1y * d2y
    const cross = d1x * d2y - d1y * d2x
    return Math.atan2(Math.abs(cross), dot) * (180 / Math.PI)
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
): number | null {
  const c: PartConstraint = { id: '__sign__', kind }
  const refs = targets.map(t => parseTarget(t, featureId))
  c.a = refs[0]
  c.b = refs[1]
  return dimensionSignFromConstraint(c, sketch)
}

/**
 * Same as `computeDimensionSign` but reads the operand refs straight off an
 * existing constraint, via the render path so the side matches what the
 * dimension is drawn against.
 */
export function dimensionSignFromConstraint(
  c: PartConstraint,
  sketch: Sketch,
): number | null {
  if (c.kind === 'point_distance_x' || c.kind === 'point_distance_y') {
    const render = computeConstraintRender(c, sketch) as DimLinearRender | { kind: string }
    if (render.kind !== 'dim_linear') return null
    const r = render as DimLinearRender
    return linearDimensionSign(c.kind, r.p1, r.p2)
  }
  if (c.kind === 'angle') {
    const render = computeConstraintRender(c, sketch) as DimAngleRender | { kind: string }
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
): [number, number] | null {
  const c: PartConstraint = { id: '__preview__', kind }
  const refs = targets.map(t => parseTarget(t, featureId))
  if (kind === 'length' || kind === 'radius' || kind === 'diameter') {
    c.target = refs[0]
  } else {
    c.a = refs[0]
    c.b = refs[1]
  }

  const render = computeConstraintRender(c, sketch) as
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
