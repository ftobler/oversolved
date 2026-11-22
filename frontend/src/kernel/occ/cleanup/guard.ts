/**
 * The one soundness guard every cleanup pass shares.
 *
 * A pass that rebuilds, heals or merges geometry is adopted only when its
 * result carries the same material as its input (and, for a pass that promised
 * not to change topology, the same counts). A rejected or throwing guard is
 * never fatal: the layer keeps the previous sound shape. The three guards this
 * replaced were copies of the same idea with different options; their measured
 * reasons live here.
 */

import type { DisposeScope } from '../disposeScope'
import type { GuardOptions } from './types'
import type { OccModule, OccShape } from '../occTypes'
import { volumeOfDefault } from '../volume'
import { swallowUnlessTrap } from '../../errors'

/** Whole-shape BRepCheck gate, shared by the boolean fallbacks and offsetShape.
 *  A throwing analyzer is not a vote of confidence, so it reads as invalid. */
export function shapeIsValid(oc: OccModule, scope: DisposeScope, shape: OccShape): boolean {
  try {
    return scope.track(new oc.BRepCheck_Analyzer(shape, true, false, false)).IsValid_2()
  } catch (e) {
    swallowUnlessTrap(e)
    return false
  }
}

/**
 * A closed body has a non-zero volume under volumeOf's OnlyClosed read; an open
 * shell (an imported body) integrates to 0. BRepCheck flags an open shell
 * invalid for its very openness, and an open shell is a supported body, so only
 * a closed input's result has to validate unless a pass asks for more.
 */
export function isClosedByVolume(volume: number): boolean {
  return Math.abs(volume) > 1e-12
}

export interface GuardVerdict {
  sound: boolean
  // The checked handle, so a caller's own check can skip this exact shape.
  validated: OccShape | null
}

function topoCounts(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
): { solids: number; faces: number; edges: number } {
  const E = oc.TopAbs_ShapeEnum
  const count = (type: object): number => {
    const exp = scope.track(new oc.TopExp_Explorer_2(shape, type, E.TopAbs_SHAPE))
    let n = 0
    for (; exp.More(); exp.Next()) n++
    return n
  }
  return { solids: count(E.TopAbs_SOLID), faces: count(E.TopAbs_FACE), edges: count(E.TopAbs_EDGE) }
}

const UNSOUND: GuardVerdict = { sound: false, validated: null }

/**
 * Was `after` a sound replacement for `before`?
 *
 * The volume difference is the default rule's correlated read error: it
 * cancels between before and after, and using the adaptive rule here flipped an
 * adoption verdict that rewrote face UUIDs under a perturbed rebuild (fuzz seed
 * 235). The growing-volume fuse that made the guard necessary was a tool cap
 * welding into a coincident target face: the clean adopted a self-intersecting
 * solid whose volume GREW, and a BRepCheck-invalid body shipped under an ok
 * status.
 */
export function guardShape(
  oc: OccModule,
  scope: DisposeScope,
  before: OccShape,
  after: OccShape,
  options: GuardOptions = {},
): GuardVerdict {
  try {
    const v0 = volumeOfDefault(oc, scope, before)
    const v1 = volumeOfDefault(oc, scope, after)
    // A pass whose input has no material cannot be judged by a volume delta:
    // a collapsed shell would pass at ~0 either way.
    if (options.positiveVolume && !(v0 > 1e-9)) return UNSOUND
    // Validity is read before the delta so a pass that corrupts orientation is
    // reported by BRepCheck even when the volume happens to be preserved.
    const demandValidity = options.validity === 'always' || isClosedByVolume(v0)
    if (demandValidity && !shapeIsValid(oc, scope, after)) return UNSOUND
    const volumeKept = Math.abs(v1 - v0) <= Math.max(1e-9, 1e-6 * Math.abs(v0))
    if (!volumeKept) return UNSOUND
    if (options.topology) {
      const beforeCounts = topoCounts(oc, scope, before)
      const afterCounts = topoCounts(oc, scope, after)
      if (
        afterCounts.solids !== beforeCounts.solids ||
        afterCounts.faces !== beforeCounts.faces ||
        afterCounts.edges !== beforeCounts.edges
      ) {
        return UNSOUND
      }
    }
    return { sound: true, validated: demandValidity ? after : null }
  } catch (e) {
    swallowUnlessTrap(e)
    // A guard that cannot run must not adopt the shape it cannot check.
    return UNSOUND
  }
}
