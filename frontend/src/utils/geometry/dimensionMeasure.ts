// PURE LOGIC -- no Three.js, no React, no imports from geometryMapping.
//
// The geometric measurement behind a dimension render. Kept apart from both its
// producers so the dialog pre-fill and a driven dimension's solve-time label
// cannot drift: they both measure the same four render points with one rule.
import type {
  ConstraintRender, DimLinearRender, DimRadiusRender, DimDiameterRender, DimAngleRender,
} from '@/types/cad'

const DEG = 180 / Math.PI

/** The number a dimension measures from its solved render geometry, or null for
 *  a render that is not a dimension. Angles are the unsigned angle between the
 *  two direction vectors in [0, 180], the same number the solver stores. */
export function dimensionValueFromRender(render: ConstraintRender): number | null {
  if (render.kind === 'dim_linear' || render.kind === 'dim_radius' || render.kind === 'dim_diameter') {
    const r = render as DimLinearRender | DimRadiusRender | DimDiameterRender
    const value = Math.hypot(r.p2[0] - r.p1[0], r.p2[1] - r.p1[1])
    return Number.isFinite(value) ? value : null
  }
  if (render.kind === 'dim_angle') {
    const r = render as DimAngleRender
    const d1x = r.p2[0] - r.p1[0]
    const d1y = r.p2[1] - r.p1[1]
    const d2x = r.p4[0] - r.p3[0]
    const d2y = r.p4[1] - r.p3[1]
    const value = Math.atan2(Math.abs(d1x * d2y - d1y * d2x), d1x * d2x + d1y * d2y) * DEG
    return Number.isFinite(value) ? value : null
  }
  return null
}
