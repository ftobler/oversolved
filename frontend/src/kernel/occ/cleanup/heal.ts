/**
 * The healer as a cleanup pass.
 *
 * ShapeFix is a projector, not a rebuilder: the defect it is meant to clear is
 * a missing pcurve on an edge a blend shares with a corner patch. It is only
 * worth running on an invalid result, and only adoptable when the result comes
 * out valid with the normal modifier guards intact: the same solid/face/edge
 * counts and the same positive volume. A heal that changes the topology has
 * invented or dropped a face rather than projected a curve.
 */

import type { DisposeScope } from '../disposeScope'
import type { OccModule, OccShape, OccSubShape, OccShapeFixShape } from '../occTypes'
import type { PassOptions, PassResult, SubShapeRebase } from './types'
import { guardShape, shapeIsValid } from './guard'
import { unchanged } from './pipeline'
import { swallowUnlessTrap } from '../../errors'
import { noProgress } from '../defaultArgs'

/**
 * Repair an invalid modifier result, or null when it cannot be trusted.
 *
 * The returned shape is DETACHED, matching `maker.Shape()`: the caller owns it
 * exactly as it owns an unhealed result. ShapeFix re-makes every face rather
 * than editing it in place, so `rebase` maps a sub-shape of the input to its
 * counterpart in the healed shape through the fixer's own substitution context
 * (its history): the hand-off of names keyed by the input's faces and edges.
 */
export function healShape(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
): { shape: OccShape; rebase: SubShapeRebase } | null {
  let healed: OccShape
  let fixer: OccShapeFixShape
  try {
    fixer = scope.track(new oc.ShapeFix_Shape_2(shape))
    fixer.Perform(noProgress(oc))
    healed = scope.track(fixer.Shape())
  } catch (e) {
    swallowUnlessTrap(e)
    return null
  }
  if (!guardShape(oc, scope, shape, healed, {
    validity: 'always',
    topology: true,
    positiveVolume: true,
  }).sound) {
    // The healed handle stays in the scope: it is no longer referenced by this
    // call, and the build scope frees it with the other transients.
    return null
  }
  const context = scope.track(fixer.Context()).get()
  const E = oc.TopAbs_ShapeEnum
  return {
    shape: scope.detach(healed),
    rebase: (s) => (context ? scope.track(context.Apply(s, E.TopAbs_SHAPE)) as OccSubShape : s),
  }
}

/**
 * The cleanup pass: heal only when the input is not already valid. A pass that
 * was needed and refused reports `rejected`, so a caller whose result is only
 * usable when the heal ran refuses the feature rather than ship the invalid
 * input.
 */
export function heal(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  options: PassOptions = {},
): PassResult {
  if (options.onlyIfInvalid !== false && shapeIsValid(oc, scope, shape)) return unchanged(shape)
  const healed = healShape(oc, scope, shape)
  if (healed === null) return unchanged(shape, true)
  return { shape: healed.shape, changed: true, rebase: healed.rebase }
}
