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
