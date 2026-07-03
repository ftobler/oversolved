// Viewport drag-handle descriptors emitted by the brep feature leaves.
//
// While a feature is being edited the viewport shows a draggable arrow that
// freeforms the feature's primary scalar (extrude distance, revolve angle,
// fillet radius, chamfer distance). Only the kernel knows the true anchor and
// direction (profile plane, face normal, resolved axis, resolved edges), so
// each leaf attaches a `handle` dict to its solve result and the frontend
// renders/drag-maps it generically. The kernel stays blind and deaf: the
// descriptor is plain JSON riding the existing per-feature result channel.
//
// Contract: dragging the grab point by `delta` world units along `direction`
// changes the field by `delta / unit_scale`. `anchor` is the grab point for
// the CURRENT value, so the frontend previews a drag as
// `anchor + direction * (newValue - value) * unit_scale`.

import { sub, dot, cross, type Vec3 } from './vec3'

export interface FeatureHandle {
  [key: string]: unknown
  kind: 'linear' | 'angular'
  field: string  // feature-def field the handle edits ('distance', 'angle', 'radius')
  anchor: Vec3  // world grab point at the current value
  direction: Vec3  // unit world drag direction at the anchor
  value: number  // evaluated current field value
  unit_scale: number  // world units of travel along direction per +1.0 of value
  min: number  // lower clamp while dragging
  max?: number  // optional upper clamp (angular handles)
}

// Matches the 0.01 commit rounding step of the frontend drag: the smallest
// value a drag can produce without collapsing the feature to zero.
export const HANDLE_MIN_VALUE = 0.01

function normalize(v: number[]): Vec3 | null {
  const len = Math.sqrt(dot(v, v))
  if (len < 1e-12) return null
  return [v[0] / len, v[1] / len, v[2] / len]
}

function add3(a: number[], b: number[]): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function scale3(v: number[], s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s]
}

/** `base + normalize(dir) * dist`, or null when dir is degenerate. */
export function offsetAlong(base: number[], dir: number[], dist: number): Vec3 | null {
  const n = normalize(dir)
  if (n === null) return null
  return add3(base, scale3(n, dist))
}

/**
 * Linear handle (extrude distance, fillet radius, chamfer distance).
 *
 * `anchor` placement is the caller's choice: extrude puts it on the swept
 * end face (so the grab point rides the moving face), fillet/chamfer put it
 * on the picked edge. The drag mapping only uses it as the reference for
 * relative travel. `unitScale` covers symmetric extrudes: the top face
 * lives at distance/2, so a symmetric caller passes 0.5 and dragging the
 * face by d changes the total distance by 2d.
 */
export function linearHandle(
  field: string,
  anchor: number[],
  dir: number[],
  value: number,
  unitScale = 1.0,
): FeatureHandle | null {
  const direction = normalize(dir)
  if (direction === null) return null
  return {
    kind: 'linear',
    field,
    anchor: [anchor[0], anchor[1], anchor[2]],
    direction,
    value,
    unit_scale: unitScale,
    min: HANDLE_MIN_VALUE,
  }
}

/**
 * Angular handle (revolve angle). The grab point is the profile reference
 * point swept to the end angle; the drag direction is the tangent of that
 * sweep circle, so pulling the arrow continues the rotation. The mapping is
 * linearized around the current angle (arc length per degree at the profile
 * radius); the frontend re-anchors from the fresh descriptor after each
 * committed rebuild.
 *
 * Returns null when the axis is degenerate or the reference point sits on
 * the axis (no radius, no meaningful tangent).
 */
export function angularHandle(
  field: string,
  axisOrigin: number[],
  axisDir: number[],
  refPoint: number[],
  angleDeg: number,
  directionSetting: string,
): FeatureHandle | null {
  const k = normalize(axisDir)
  if (k === null) return null
  const v = sub(refPoint, axisOrigin)
  const axial = scale3(k, dot(k, v))
  const radial = sub(v, axial)
  const radius = Math.sqrt(dot(radial, radial))
  if (radius < 1e-9) return null

  // Which end of the sweep the grab point sits on, in degrees of the stored
  // (always positive) angle value.
  const endFactor = directionSetting === 'reverse' ? -1 : directionSetting === 'symmetric' ? 0.5 : 1
  const theta = (angleDeg * endFactor * Math.PI) / 180
  // radial is perpendicular to k, so Rodrigues reduces to cos/sin terms.
  const rotated = add3(scale3(radial, Math.cos(theta)), scale3(cross(k, radial), Math.sin(theta)))
  const anchor = add3(add3(axisOrigin, axial), rotated)

  const tangent = normalize(cross(k, rotated))
  if (tangent === null) return null
  // d(anchor)/d(value) = tangent * endFactor * radius * pi/180; direction must
  // stay unit-length, so the sign folds into direction and the magnitude into
  // unit_scale.
  const direction = endFactor < 0 ? scale3(tangent, -1) : tangent
  return {
    kind: 'angular',
    field,
    anchor,
    direction,
    value: angleDeg,
    unit_scale: (radius * Math.PI * Math.abs(endFactor)) / 180,
    min: HANDLE_MIN_VALUE,
    max: 360,
  }
}
