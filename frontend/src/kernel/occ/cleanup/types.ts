/**
 * The contract every post-feature cleanup pass implements.
 *
 * A feature's B-rep result passes through one plan of these before it is named
 * and committed. The layer owns adoption (guard, history and name hand-off),
 * so a pass only has to describe what it did and how to carry identity across
 * it. The pass itself never decides whether it is adopted.
 */

import type { DisposeScope } from '../disposeScope'
import type { OccHistory, OccModule, OccShape, OccSubShape } from '../occTypes'
import type { BrepDiff } from '../../types3d'
import type { ShapeNames } from '../partNames'

/** Maps a sub-shape of a pass's input to its counterpart in the pass output. */
export type SubShapeRebase = (s: OccSubShape) => OccSubShape

/**
 * A pass's result. `changed: false` means the pass left the shape alone and the
 * caller keeps its own handle; `rebase` is then the identity.
 *
 * A pass that merges or removes sub-shapes (UnifySameDomain) cannot express
 * that as a one-to-one rebase, so it returns its `history` instead. The layer
 * then composes the diff, the face origins and the names through that history,
 * and `rebase` is only a best-effort representative image per sub-shape.
 *
 * `rejected` is for a pass that was needed but refused (a heal that could not
 * make its shape sound): the shape is unchanged, but a caller whose result is
 * only usable when the pass ran must refuse the feature rather than ship the
 * pass's own unsound input.
 */
export interface PassResult {
  shape: OccShape
  changed: boolean
  rebase: SubShapeRebase
  history?: OccHistory
  rejected?: boolean
}

/** Options one pass reads. A pass ignores fields it has no use for. */
export interface PassOptions {
  /** UnifySameDomain's face merge gate. False keeps the edge merge only. */
  unifyFaces?: boolean
  /** The merge tolerance pair; absent reads the kernel contract. */
  linearTol?: number
  angularTol?: number
  /** Heal only when the input is not already valid. */
  onlyIfInvalid?: boolean
}

export type CleanupPass = (
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  options: PassOptions,
) => PassResult

/**
 * The pass's soundness contract. The layer's guard is the same one every pass
 * shares, with the options each pass's old inline guard carried:
 *
 * - `validity: 'always'` demands BRepCheck on the result even for an open
 *   shell. The cylinder rebuild and the healer re-make faces, so an
 *   orientation slip must be caught; the boolean clean only has to validate a
 *   closed input's result (an open shell is a supported body).
 * - `topology: true` demands the same solid/face/edge counts, the promise a
 *   projector-like pass (the healer) makes: a heal that invents or drops a
 *   face is corruption wearing a repair.
 * - `positiveVolume: true` refuses a pass whose input has no material (a
 *   collapsed shell), which keeping a ~0 volume would otherwise pass.
 */
export interface GuardOptions {
  validity?: 'whenClosed' | 'always'
  topology?: boolean
  positiveVolume?: boolean
}

/** One step of a plan: which pass, with which options, under which guard. */
export interface CleanupPlanEntry {
  name: string
  pass: CleanupPass
  options?: PassOptions
  /**
   * True when the pass already ran the layer's guard internally and returns
   * its input on refusal (the cylinder pass). The layer must not pay a second
   * whole-shape check on geometry it did not build.
   */
  selfGuarded?: boolean
  guard?: GuardOptions
}

export type CleanupPlan = readonly CleanupPlanEntry[]

/** What the layer hands into a plan. Every table is keyed by the input shape. */
export interface CleanupInput {
  shape: OccShape
  diff?: BrepDiff
  names?: ShapeNames | null
  faceOrigin?: readonly FaceOrigin[]
}

/** What each pass did, read by the solve notes and by the tests. */
export type PassStatus = 'adopted' | 'rejected' | 'unchanged'

export interface PassReport {
  name: string
  status: PassStatus
}

export interface CleanupResult {
  shape: OccShape
  changed: boolean
  /** Present when the input carried one, composed onto the result. */
  diff?: BrepDiff
  names?: ShapeNames | null
  faceOrigin?: readonly FaceOrigin[]
  /** One row per plan entry, in plan order. */
  passes: PassReport[]
  /**
   * The handle the last adopted pass's guard validated, so a caller that must
   * otherwise pay its own whole-shape BRepCheck can skip this exact handle.
   */
  validated: OccShape | null
  /** Input sub-shape to result sub-shape, the pass one-to-one where possible. */
  rebase: SubShapeRebase
}

/**
 * An output face paired with the input face it derived from
 * (query-naming-by-construction), carried across cleanup unchanged.
 */
export interface FaceOrigin {
  output: OccSubShape
  source: OccSubShape
  fromTool: boolean
}
