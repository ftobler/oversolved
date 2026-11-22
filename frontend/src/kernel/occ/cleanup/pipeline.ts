/**
 * Run a feature's B-rep result through a plan of cleanup passes.
 *
 * Every pass is adopted only when the one guard says its result is sound; the
 * diff, the face origins and the construction names then move onto the adopted
 * shape through the pass's rebase (one-to-one) or its history (merged). A pass
 * that is rejected or throws leaves the previous shape in place: the result is
 * never fatal, the caller decides whether an unchanged shape is acceptable.
 *
 * The layer sits before naming: `resplitPart` keys names by the result's
 * sub-shapes, so every adopted pass must re-key them here, not inside the
 * commit.
 */

import type { DisposeScope } from '../disposeScope'
import type {
  CleanupInput,
  CleanupPlan,
  CleanupPlanEntry,
  CleanupResult,
  FaceOrigin,
  PassReport,
  PassStatus,
  SubShapeRebase,
} from './types'
import type { OccModule, OccShape } from '../occTypes'
import type { BrepDiff } from '../../types3d'
import type { ShapeNames } from '../partNames'
import { guardShape } from './guard'
import {
  composeDiffThroughClean,
  composeNamesThroughHistory,
  composeOriginThroughClean,
  historyRebase,
  mapDiffThroughRebase,
  mapOriginThroughRebase,
  rebaseNames,
} from './compose'
import { markFeatureProgress } from '../../featureProgress'
import { swallowUnlessTrap } from '../../errors'

const identityRebase: SubShapeRebase = (s) => s

/**
 * Adopt a pass result when its guard accepts it, and carry the identity tables
 * across. `state` is mutated in place so one pass's refusal cannot leave a
 * half-composed table behind.
 */
function adoptPass(
  oc: OccModule,
  scope: DisposeScope,
  entry: CleanupPlanEntry,
  state: {
    shape: OccShape
    diff?: BrepDiff
    names?: ShapeNames | null
    faceOrigin?: readonly FaceOrigin[]
    rebase: SubShapeRebase
  },
  owned: Set<OccShape>,
): PassReport {
  let result
  try {
    result = entry.pass(oc, scope, state.shape, entry.options ?? {})
  } catch (e) {
    swallowUnlessTrap(e)
    return { name: entry.name, status: 'rejected' }
  }
  if (result.rejected) return { name: entry.name, status: 'rejected' }
  if (!result.changed) return { name: entry.name, status: 'unchanged' }

  if (result.shape !== state.shape && !scope.isTracked(result.shape)) scope.track(result.shape)
  markFeatureProgress()
  if (!entry.selfGuarded) {
    const verdict = guardShape(oc, scope, state.shape, result.shape, entry.guard)
    if (!verdict.sound) return { name: entry.name, status: 'rejected' }
  }
  if (result.shape !== state.shape) owned.add(result.shape)

  const previous = state.rebase
  const passRebase = result.rebase
  state.rebase = (s) => passRebase(previous(s))

  if (result.history !== undefined) {
    const history = result.history
    if (state.diff !== undefined) state.diff = composeDiffThroughClean(oc, scope, state.diff, history, result.shape)
    if (state.faceOrigin !== undefined) {
      state.faceOrigin = composeOriginThroughClean(oc, scope, state.faceOrigin, history, result.shape)
    }
    if (state.names) state.names = composeNamesThroughHistory(scope, state.names, history)
    // The rebase above is a representative image only; merged sub-shapes need
    // the history, which the composition has now consumed.
    state.rebase = (s) => historyRebase(scope, history)(previous(s))
  } else {
    if (state.diff !== undefined) state.diff = mapDiffThroughRebase(state.diff, passRebase)
    if (state.faceOrigin !== undefined) state.faceOrigin = mapOriginThroughRebase(state.faceOrigin, passRebase)
    if (state.names) state.names = rebaseNames(state.names, passRebase)
  }
  state.shape = result.shape
  return { name: entry.name, status: 'adopted' }
}

/**
 * Run `plan` over `input`. The returned shape is untracked: the caller owns it
 * exactly as it owned the input, whether the plan changed anything or not.
 */
export function runCleanup(
  oc: OccModule,
  scope: DisposeScope,
  input: CleanupInput,
  plan: CleanupPlan,
): CleanupResult {
  const state: {
    shape: OccShape
    diff?: BrepDiff
    names?: ShapeNames | null
    faceOrigin?: readonly FaceOrigin[]
    rebase: SubShapeRebase
  } = {
    shape: input.shape,
    diff: input.diff,
    names: input.names,
    faceOrigin: input.faceOrigin,
    rebase: identityRebase,
  }
  const passes: PassReport[] = []
  // Shapes this pipeline itself tracked. Only those are detached on success: a
  // caller that tracked its input keeps that ownership as before.
  const owned = new Set<OccShape>()
  // The validated handle of the last adopted pass, before any later pass
  // replaced the shape: a caller's own whole-shape check may skip exactly that
  // handle, never the final shape a later pass produced.
  let validated: OccShape | null = null
  for (const entry of plan) {
    const report = adoptPass(oc, scope, entry, state, owned)
    passes.push(report)
    if (report.status === 'adopted') {
      validated = state.shape
      // Mark after each pass so a long merge keeps the host's stall budget fed.
      markFeatureProgress()
    }
  }
  const changed = passes.some((p) => p.status === 'adopted')
  const shape = owned.has(state.shape) ? scope.detach(state.shape) : state.shape
  return {
    shape,
    changed,
    diff: state.diff,
    names: state.names,
    faceOrigin: state.faceOrigin,
    passes,
    validated,
    rebase: state.rebase,
  }
}

/** True when the named pass was needed and refused its result. */
export function passRejected(result: CleanupResult, name: string): boolean {
  return result.passes.some((p) => p.name === name && p.status === 'rejected')
}

/** The status of the named pass, or undefined when the plan did not run it. */
export function passStatus(result: CleanupResult, name: string): PassStatus | undefined {
  return result.passes.find((p) => p.name === name)?.status
}

/** A pass result's shape unchanged, for a pass that decides to do nothing. */
export function unchanged(shape: OccShape, rejected = false): {
  shape: OccShape
  changed: false
  rebase: SubShapeRebase
  rejected?: boolean
} {
  return { shape, changed: false, rebase: identityRebase, rejected }
}
