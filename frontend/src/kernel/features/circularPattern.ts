// The circular pattern leaf. The axis pick (or stored origin/direction pair)
// and the angle law live here; the shared subject dispatch and the instance
// filtering are pattern.ts.
//
// The angle law, in one place:
// - equal spacing (the default): `angle` is the full sweep. A full turn spreads
//   the instances over 360 / total, where total is count or 2*count - 1 when
//   centered, so nothing lands on the source. A smaller sweep puts the end
//   instances ON the sweep ends (step = angle / (count - 1), or
//   angle / (2 * (count - 1)) centered, so +-(count-1) sits at +-angle/2).
// - not equal spacing: `angle` is the increment between neighbours.
// A negative angle is refused (reverse with `invert_axis`); an equal-spaced
// angle past a full turn, or a step that lands one instance on another, is the
// instance model's coincidence refusal.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { PartSolid } from '../types3d'
import type { Repository } from '../query'
import { makeRotationTrsf } from '../occ/transforms'
import { resolveAxisQueryStrict } from './shared/directionQuery'
import {
  circularCoincidentRefusal, generatedCount, instanceIndices, toInstances,
} from './patternInstances'
import {
  keptInstances, patternCountOf, patternNumber, solvePatternInstances,
  type Dict, type PatternCopy,
} from './pattern'
import type { PatternResult } from './patternFeature'
import type { PartPatternResult } from './patternPart'

/** A stored VEC3 field, or null when absent; a malformed value is a solve error. */
function storedVec3(value: unknown, key: string): number[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.length !== 3 || !value.every((c) => typeof c === 'number' && Number.isFinite(c))) {
    throw new Error(`pattern: ${key} must be three finite numbers, got ${JSON.stringify(value)}`)
  }
  return value as number[]
}

/**
 * A rotation axis, with the same precedence transform uses for its rotation: an
 * `axis` pick wins; else the stored `axis_origin` / `axis_direction` pair, where
 * a direction alone rotates about the world origin and an origin alone uses +Z
 * (transform's rule, so one default holds for both). Neither is a solve error
 * rather than a silent rotation about a world axis.
 */
export function resolvePatternAxis(
  axisQuery: string,
  originValue: unknown,
  directionValue: unknown,
  globalRepo: Repository,
  partStore: Record<string, PartSolid>,
): [number[], number[]] {
  // The pick can be a straight edge, circular edge, sketch line, sketch
  // circle, cylindrical face, or planar face.
  if (axisQuery) {
    const axis = resolveAxisQueryStrict(axisQuery, globalRepo, partStore)
    if (!axis) throw new Error(`pattern: axis query '${axisQuery}' did not resolve to a usable axis`)
    return axis
  }
  const origin = storedVec3(originValue, 'axis_origin')
  const direction = storedVec3(directionValue, 'axis_direction')
  if (origin === null && direction === null) {
    throw new Error(
      'pattern: axis is required; pick an edge, sketch entity, or face as `axis`, ' +
        'or store the pair `axis_origin` + `axis_direction`',
    )
  }
  const dir = direction ?? [0, 0, 1]
  const len = Math.hypot(dir[0], dir[1], dir[2])
  if (len < 1e-12) throw new Error('pattern: axis_direction must be a non-zero vector')
  return [origin ?? [0, 0, 0], dir.map((c) => c / len)]
}

/** The angle one neighbour sits from the previous, in degrees. */
export function circularStep(
  angle: number,
  equalSpacing: boolean,
  count: number,
  centered: boolean,
): number {
  if (!equalSpacing) return angle
  if (angle > 360 + 1e-9) {
    throw new Error(
      `pattern: angle ${angle} deg is more than a full turn with equal spacing; ` +
        'use 360 deg or less, or turn equal spacing off to set a step',
    )
  }
  // A full turn (within the tolerance the coincidence test uses) divides by the
  // generated total, so no instance lands on the source.
  if (Math.abs(angle - 360) <= 1e-9) return 360 / generatedCount(count, centered)
  // A smaller sweep puts the two end instances on the sweep ends. Count 1
  // generates no copies, so its step is never used.
  if (count === 1) return angle
  const span = centered ? 2 * (count - 1) : count - 1
  return angle / span
}

/** The copies a circular pattern generates. Count 1 generates an empty list:
 *  the caller's quiet no-op, whatever the angle. */
export function buildCircularCopies(
  oc: OccModule,
  scope: DisposeScope,
  sub: Dict,
  globalRepo: Repository,
  partStore: Record<string, PartSolid>,
): { copies: PatternCopy[]; warnings: string[] } {
  const count = patternCountOf(sub, 'count', 4)
  const centered = sub.centered === true
  const generated = toInstances(instanceIndices(count, centered))
  const { kept, warnings } = keptInstances(generated, sub, generatedCount(count, centered), `count ${count}`)
  const angle = patternNumber(sub, 'angle', 360)
  if (angle < 0) {
    throw new Error(`pattern: angle must be a non-negative number of degrees, got ${angle}; reverse the sense with invert_axis`)
  }
  const equalSpacing = sub.equal_spacing !== false
  const step = circularStep(angle, equalSpacing, count, centered)
  const coincident = circularCoincidentRefusal(kept.map((instance) => instance.index), step)
  if (coincident !== null) throw new Error(coincident)
  const [origin, resolvedDirection] = resolvePatternAxis(
    (sub.axis as string) ?? '',
    sub.axis_origin,
    sub.axis_direction,
    globalRepo,
    partStore,
  )
  // Invert flips the axis direction, which reverses the sweep sense.
  const invert = (sub.invert_axis as boolean) ?? false
  const axisDirection = invert ? resolvedDirection.map((c) => (c === 0 ? 0 : -c)) : resolvedDirection
  const copies = kept.map((instance) => {
    const i = instance.index as number
    return {
      key: instance.key,
      trsf: makeRotationTrsf(oc, scope, origin, axisDirection, ((step * i) * Math.PI) / 180),
    }
  })
  return { copies, warnings }
}

/** The `circular_pattern` leaf entry. */
export function solveCircularPattern(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  partStore: Record<string, PartSolid>,
  featuresById: Record<string, Dict> = {},
  solveContext: { variables: Record<string, number>; laterVariables: Record<string, number> } = {
    variables: {}, laterVariables: {},
  },
): PatternResult | PartPatternResult {
  const sub = (feature.circular_pattern as Dict) ?? {}
  return solvePatternInstances(
    oc, scope, table, feature, sub, globalRepo, partStore, featuresById, solveContext,
    () => buildCircularCopies(oc, scope, sub, globalRepo, partStore),
  )
}
