// Port of the transform slice of ocp_ops.py + geometry_features.py +
// cadquery_ops.py: gp_Trsf construction (translation / rotation / mirror / scale),
// `apply_transform_shape` (compose scale -> rotation -> translation), and
// `transform_copy`. These back the array / circular_array / transform / mirror
// leaves. Every trsf is built fresh in the caller's scope; transformCopy returns
// a raw shape the caller owns.

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccTrsf } from './occTypes'
import type { Vec3 } from './primitives'

export function makeTranslationTrsf(oc: OccModule, scope: DisposeScope, dx: number, dy: number, dz: number): OccTrsf {
  const t = scope.track(new oc.gp_Trsf_1())
  t.SetTranslation_1(scope.track(new oc.gp_Vec_4(dx, dy, dz)))
  return t
}

export function makeRotationTrsf(
  oc: OccModule,
  scope: DisposeScope,
  origin: number[],
  direction: number[],
  angleRad: number,
): OccTrsf {
  const ax = scope.track(
    new oc.gp_Ax1_2(
      scope.track(new oc.gp_Pnt_3(origin[0], origin[1], origin[2])),
      scope.track(new oc.gp_Dir_4(direction[0], direction[1], direction[2])),
    ),
  )
  const t = scope.track(new oc.gp_Trsf_1())
  t.SetRotation_1(ax, angleRad)
  return t
}

export function makeScaleTrsf(oc: OccModule, scope: DisposeScope, center: number[], factor: number): OccTrsf {
  const t = scope.track(new oc.gp_Trsf_1())
  t.SetScale(scope.track(new oc.gp_Pnt_3(center[0], center[1], center[2])), factor)
  return t
}

export function makeMirrorTrsf(oc: OccModule, scope: DisposeScope, origin: number[], normal: number[]): OccTrsf {
  const ax2 = scope.track(
    new oc.gp_Ax2_3(
      scope.track(new oc.gp_Pnt_3(origin[0], origin[1], origin[2])),
      scope.track(new oc.gp_Dir_4(normal[0], normal[1], normal[2])),
    ),
  )
  const t = scope.track(new oc.gp_Trsf_1())
  t.SetMirror_3(ax2)
  return t
}

/** Apply a gp_Trsf to a shape (copy=true), returning the raw result shape (mirrors `transform_copy`). */
export function transformCopy(oc: OccModule, scope: DisposeScope, shape: OccShape, trsf: OccTrsf): OccShape {
  const builder = scope.track(new oc.BRepBuilderAPI_Transform_2(shape, trsf, true))
  builder.Build()
  return builder.Shape()
}

/**
 * Independent defensive copy of a shape, mirroring builder.py `_copy_shape`
 * (BRepBuilderAPI_Copy with copyGeom=true). The result shares no topology with
 * the original, so storing it in a checkpoint and later mutating/freeing the
 * live body cannot corrupt the copy. (An identity BRepBuilderAPI_Transform does
 * NOT suffice in this OCC build -- it shares the source TShape, which a later
 * in-place fillet/boolean then frees underneath the snapshot.) The result
 * outlives ``scope``; only the transient copy builder is tracked.
 */
export function copyShape(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape {
  const maker = scope.track(new oc.BRepBuilderAPI_Copy_2(shape, true, false))
  return maker.Shape()
}

export interface TransformParams {
  translation?: number[] | null
  rotationAxisOrigin?: number[] | null
  rotationAxisDirection?: number[] | null
  rotationAngleDeg?: number
  scale?: number
  scaleCenter?: number[] | null
}

/**
 * Compose scale -> rotation -> translation into one gp_Trsf and apply it (mirrors
 * `apply_transform_shape`). Each component is skipped when it would be identity.
 * Rotation defaults to the Z axis when an angle is set but no direction is given.
 */
export function applyTransformShape(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  params: TransformParams,
): OccShape {
  const {
    translation = null,
    rotationAxisOrigin = null,
    rotationAxisDirection = null,
    rotationAngleDeg = 0.0,
    scale = 1.0,
    scaleCenter = null,
  } = params

  const combined = scope.track(new oc.gp_Trsf_1())

  if (scale !== 1.0) {
    combined.Multiply(makeScaleTrsf(oc, scope, scaleCenter ?? [0, 0, 0], scale))
  }
  if (rotationAngleDeg) {
    const dir = rotationAxisDirection ?? [0, 0, 1]
    combined.Multiply(
      makeRotationTrsf(oc, scope, rotationAxisOrigin ?? [0, 0, 0], dir, (rotationAngleDeg * Math.PI) / 180),
    )
  }
  if (translation) {
    combined.Multiply(makeTranslationTrsf(oc, scope, translation[0], translation[1], translation[2]))
  }

  return transformCopy(oc, scope, shape, combined)
}

export type { Vec3 }
