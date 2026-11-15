// The instance pattern's placement law, pure: a target point plus (under
// `normal`) a target normal decide where a copy sits and how it turns. No OCC,
// so the minimal-rotation and antiparallel rules unit-test on their own; the
// kernel leaf only resolves the picks and turns these placements into gp_Trsf
// copies.
//
// `fixed` translates by target - reference and ignores every normal. `normal`
// rotates the source normal onto the target normal with the minimal rotation,
// then translates so the reference point lands on the target point. The spin
// about the normal is not defined by a point target, so the minimal rotation is
// the rule: a copy aligned to the source normal is a pure translation, which
// keeps a flat sketch-points pattern identical in both modes. Antiparallel
// normals turn 180 degrees about the source frame's x axis (the sketch x axis
// when the caller knows it, else a deterministic perpendicular of the source
// normal), so the choice is stable across re-solves.
//
// A target without a normal is moved only: it has no direction to turn onto.
// A target within TOL_TOPOLOGY_MERGE of the reference point is the source's own
// slot and makes no copy (quietly: putting the source on a sketch point is the
// normal way to author this).

import type { Transform3D } from '@/types/cad'
import { makeTransform, quatFromAxisAngle, rotateVector, type Quat } from '@/utils/transform3d'
import { TOL_TOPOLOGY_MERGE } from '../solverConstants'

export type Vec3 = [number, number, number]
export type InstanceOrientation = 'normal' | 'fixed'

export interface PlacementTarget {
  // The stable copy key: the sketch entity id, or a short pick hash.
  key: string
  // The readable number-to-name map the editor hint shows.
  label: string
  point: Vec3
  normal: Vec3 | null
}

export interface PlacementInput {
  reference: Vec3
  // The normal the copies turn FROM under `normal`; null means no target can
  // carry one, so every copy is a translation.
  sourceNormal: Vec3 | null
  // The source frame's x direction, used only for the antiparallel rule.
  sourceX?: Vec3 | null
  targets: readonly PlacementTarget[]
  orientation: InstanceOrientation
  // Flip every target normal before the rotation is computed (not the source
  // normal). Under `fixed` it changes nothing.
  reverseNormal: boolean
}

export interface Placement {
  key: string
  label: string
  transform: Transform3D
}

export interface PlacementResult {
  placements: Placement[]
  // The targets that were the source's own slot, 1-based positions, so a report
  // can say how many copies a count would have made.
  sourceSlots: number[]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function unit(v: Vec3, fallback: Vec3 = [0, 0, 1]): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2])
  return len < 1e-12 ? fallback : [v[0] / len, v[1] / len, v[2] / len]
}

/** A deterministic unit vector perpendicular to `n`, the antiparallel rule's
 *  x axis when the caller has no sketch frame. */
export function perpendicularTo(n: Vec3): Vec3 {
  const seed: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  return unit(cross(n, seed), [0, 1, 0])
}

/**
 * The minimal rotation carrying `from` onto `to`. Equal directions are the
 * identity; antiparallel ones turn 180 degrees about `sourceX` (or a
 * deterministic perpendicular), because the minimal axis is then undefined.
 */
export function minimalRotation(from: Vec3, to: Vec3, sourceX?: Vec3 | null): Quat {
  const a = unit(from)
  const b = unit(to)
  const axis = cross(a, b)
  const axisLength = Math.hypot(axis[0], axis[1], axis[2])
  const c = Math.max(-1, Math.min(1, dot(a, b)))
  if (axisLength < 1e-9) {
    if (c > 0) return [0, 0, 0, 1]
    const x = sourceX === null || sourceX === undefined ? perpendicularTo(a) : unit(sourceX)
    return quatFromAxisAngle(x, Math.PI)
  }
  return quatFromAxisAngle(axis, Math.atan2(axisLength, c))
}

/** The rigid transform that carries the reference point and source normal onto
 *  one target. */
export function placeOnTarget(
  reference: Vec3,
  sourceNormal: Vec3 | null,
  sourceX: Vec3 | null | undefined,
  target: PlacementTarget,
  orientation: InstanceOrientation,
  reverseNormal: boolean,
): Transform3D {
  const normal = target.normal === null
    ? null
    : unit(reverseNormal ? [-target.normal[0], -target.normal[1], -target.normal[2]] : target.normal)
  const q: Quat = orientation === 'normal' && sourceNormal !== null && normal !== null
    ? minimalRotation(sourceNormal, normal, sourceX)
    : [0, 0, 0, 1]
  const rotated = rotateVector(q, reference)
  return makeTransform(sub(target.point, rotated), q)
}

/** Every kept target's placement, in target order. */
export function placeOnTargets(input: PlacementInput): PlacementResult {
  const placements: Placement[] = []
  const sourceSlots: number[] = []
  for (const [index, target] of input.targets.entries()) {
    const offset = sub(target.point, input.reference)
    if (Math.hypot(offset[0], offset[1], offset[2]) <= TOL_TOPOLOGY_MERGE) {
      sourceSlots.push(index + 1)
      continue
    }
    placements.push({
      key: target.key,
      label: target.label,
      transform: placeOnTarget(
        input.reference, input.sourceNormal, input.sourceX, target, input.orientation, input.reverseNormal,
      ),
    })
  }
  return { placements, sourceSlots }
}
