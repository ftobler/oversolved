/**
 * The UnifySameDomain pass, moved out of the boolean pipeline so every result
 * that wants its faces or edges folded runs the same call.
 *
 * The clean has no guard of its own: the layer's guard decides adoption, which
 * is what lets a boolean fall back to its un-merged result and a modifier keep
 * its healed one. The two tolerances are ALWAYS set, even when the caller
 * passes none: the defaults are OCC's compiled-in pair, but reading that pair
 * by name here is what keeps the kernel and the sketch solver on one contract.
 */

import type { DisposeScope } from '../disposeScope'
import type { PassOptions, PassResult } from './types'
import type { OccHistory, OccModule, OccShape } from '../occTypes'
import { OCC_ANGULAR, OCC_CONFUSION } from '../../solverConstants'

/** The tolerances one clean reads. Absent values fall back to the contract. */
export interface CleanTolerances {
  linearTol?: number
  angularTol?: number
}

/**
 * ShapeUpgrade_UnifySameDomain (cadquery Shape.clean) with exposed history
 * (mirrors `ocp_clean_with_history`). `unifyFaces` gates the face merge; pass
 * false to keep only the edge merge when the face merge is unsafe (imported STEP
 * geometry, see `booleanWithDiff`) or would fold a feature's own face into a
 * neighbour (the modifier plan).
 */
export function cleanWithHistory(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  unifyFaces = true,
  tolerances: CleanTolerances = {},
): { shape: OccShape; history: OccHistory } {
  const up = scope.track(new oc.ShapeUpgrade_UnifySameDomain_2(shape, true, unifyFaces, unifyFaces))
  up.SetLinearTolerance(tolerances.linearTol ?? OCC_CONFUSION)
  up.SetAngularTolerance(tolerances.angularTol ?? OCC_ANGULAR)
  up.AllowInternalEdges(false)
  up.Build()
  return { shape: up.Shape(), history: scope.track(up.History_1()).get() }
}

/** The cleanup layer's pass over `cleanWithHistory`; the layer guards it. */
export function unifySameDomain(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  options: PassOptions = {},
): PassResult {
  const merged = cleanWithHistory(oc, scope, shape, options.unifyFaces ?? true, {
    linearTol: options.linearTol,
    angularTol: options.angularTol,
  })
  return {
    shape: merged.shape,
    changed: true,
    rebase: (s) => s,
    history: merged.history,
  }
}
