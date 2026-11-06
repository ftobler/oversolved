// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
//
// Rigid-copy math for sketch entities: the instance transforms one
// pattern_entities step generates, the image of one entity's flat parameter
// block under one transform, and the rules a carried constraint follows under a
// rotation. Math only; minting ids and rewriting constraints is the applier's
// job (yamlMutations/sketchPattern.ts). Reflection is mirror_entities' business
// and never happens here, so no vertex key swaps and no handedness flips.

import type { EntityKind, Point, SketchPatternMode } from '@/types/cad'
import { round, allFinite } from '@/utils/yamlMutations/helpers'
import { arcSpanDeg, canonicalVertexPositions } from './mirrorSketch'

export type { SketchPatternMode }

export const SKETCH_PATTERN_MODES: readonly SketchPatternMode[] = ['linear', 'grid', 'rotate', 'copy']

/** The authored fields of one pattern step, exactly as the mutation carries
 *  them. Which ones a mode reads is `SKETCH_PATTERN_MODE_FIELDS`. */
export interface SketchPatternFields {
  mode: SketchPatternMode
  count?: number
  count2?: number
  pitch?: number
  pitch2?: number
  direction?: Point
  direction2?: Point
  angle_deg?: number
  center?: Point
  translate?: Point
}

/** The fields each mode reads. A field outside its mode's list is refused by
 *  name at the drive boundary, so a linear step carrying `center` is a mistake
 *  an author hears about instead of a silently ignored value. */
export const SKETCH_PATTERN_MODE_FIELDS: Record<SketchPatternMode, readonly (keyof SketchPatternFields)[]> = {
  linear: ['count', 'pitch', 'direction'],
  grid: ['count', 'count2', 'pitch', 'pitch2', 'direction', 'direction2'],
  rotate: ['count', 'angle_deg', 'center'],
  copy: ['angle_deg', 'center', 'translate'],
}

// Every mode-owned field, the set a mode's own list is checked against.
const PATTERN_FIELDS: readonly (keyof SketchPatternFields)[] = [...new Set(Object.values(SKETCH_PATTERN_MODE_FIELDS).flat())]

/** Total instances (source included) one step may produce. Bounds a single
 *  step's mint, solve and undo entry; the gear rack's 63 fits with room. */
export const MAX_PATTERN_INSTANCES = 200

/** The sketch solver's entity capacity (`MAX_ENTITIES` in
 *  sketch-solver/src/topology/codec.rs): a pattern that would push the sketch
 *  past it is refused before it writes. */
export const MAX_SKETCH_ENTITIES = 4096

/**
 * One rigid instance transform: rotate by `angleDeg` about (cx, cy), then
 * translate by (tx, ty), so p' = R(p - c) + c + t. A pure translation has
 * angleDeg 0; the centre is then irrelevant.
 */
export interface SketchTransform {
  angleDeg: number
  cx: number
  cy: number
  tx: number
  ty: number
}

const DEG = Math.PI / 180

const normDeg = (d: number): number => ((d % 360) + 360) % 360

/** cos/sin of an angle, exact at the quarter turns so a 90 deg copy of an
 *  axis-aligned line stays exactly axis-aligned instead of picking up 6e-17. */
function cosSin(angleDeg: number): [number, number] {
  const n = normDeg(angleDeg)
  if (n === 0) return [1, 0]
  if (n === 90) return [0, 1]
  if (n === 180) return [-1, 0]
  if (n === 270) return [0, -1]
  return [Math.cos(n * DEG), Math.sin(n * DEG)]
}

export function transformPoint(p: readonly [number, number], t: SketchTransform): [number, number] {
  const [c, s] = cosSin(t.angleDeg)
  const dx = p[0] - t.cx
  const dy = p[1] - t.cy
  return [t.cx + c * dx - s * dy + t.tx, t.cy + s * dx + c * dy + t.ty]
}

/** The linear part alone, for offsets with no anchor (a label `pos`). */
export function transformVector(v: readonly [number, number], t: SketchTransform): [number, number] {
  const [c, s] = cosSin(t.angleDeg)
  return [c * v[0] - s * v[1], s * v[0] + c * v[1]]
}

/** The transform as p' = M p + e, the form two transforms compare in. */
function affineOf(t: SketchTransform): [number, number, number, number] {
  const [c, s] = cosSin(t.angleDeg)
  const e = transformPoint([0, 0], t)
  return [c, s, e[0], e[1]]
}

/** True when two transforms place every point at the same spot: the stacked
 *  copy test. The tolerance follows the size-scaled TOL_LOOP_CLOSURE (1e-6):
 *  a rotation part differing by d moves a point at distance |p| by about
 *  d * |p|, so d <= 1e-6 is a copy the loop builder would merge anyway (a
 *  decimal step whose 7th copy lands at 359.999997 deg is stacked). This
 *  compares transforms, not geometry: a circle rotated about its own centre is
 *  a transform that moves points but leaves the curve where it was, and is not
 *  caught here. */
function sameTransform(a: SketchTransform, b: SketchTransform): boolean {
  const fa = affineOf(a)
  const fb = affineOf(b)
  const scale = Math.max(1, Math.abs(fa[2]), Math.abs(fa[3]))
  return Math.abs(fa[0] - fb[0]) <= 1e-6 && Math.abs(fa[1] - fb[1]) <= 1e-6
    && Math.abs(fa[2] - fb[2]) <= 1e-6 * scale && Math.abs(fa[3] - fb[3]) <= 1e-6 * scale
}

const IDENTITY: SketchTransform = { angleDeg: 0, cx: 0, cy: 0, tx: 0, ty: 0 }

const isFinitePoint = (p: unknown): p is Point =>
  Array.isArray(p) && p.length === 2 && allFinite(p as number[])

/** A count field: a whole number from 1 up. */
function countProblem(value: unknown, label: string): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return `${label} must be a whole number of at least 1 (the source included), got ${JSON.stringify(value)}`
  }
  return null
}

function nonZeroProblem(value: unknown, label: string): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${label} must be a finite number, got ${JSON.stringify(value)}`
  if (value === 0) return `${label} must not be zero; every copy would land on the source`
  return null
}

/** A unit direction, or a reason: absent means the default, and a zero or
 *  non-finite vector has no direction to step along. */
function unitDirection(value: unknown, fallback: Point, label: string): Point | string {
  if (value === undefined) return fallback
  if (!isFinitePoint(value)) return `${label} must be a finite [x, y] vector, got ${JSON.stringify(value)}`
  const len = Math.hypot(value[0], value[1])
  if (len <= 1e-12) return `${label} must not be a zero vector`
  return [value[0] / len, value[1] / len]
}

/** The total instance count a step asks for (source included), read before
 *  the transforms are built so the cap is named against the authored count. */
export function patternInstanceCount(fields: SketchPatternFields): number {
  switch (fields.mode) {
    case 'linear':
    case 'rotate':
      return fields.count ?? 0
    case 'grid':
      return (fields.count ?? 0) * (fields.count2 ?? 0)
    case 'copy':
      return 2
  }
}

/**
 * The transforms of every copy one step generates (the source, the identity
 * instance, is not included), in instance order: linear and rotate by step
 * index, grid row-major over (column, row) with column fastest, copy its one
 * transform. A reason instead when a field is malformed, the count is under
 * two or over the cap, or a copy lands on the source or an earlier copy.
 * `crossSketch` admits the identity copy, which is a real copy when it goes
 * into another sketch.
 */
export function instanceTransforms(
  fields: SketchPatternFields,
  options: { crossSketch?: boolean } = {},
): { transforms: SketchTransform[] } | { reason: string } {
  // hasOwn, so an untyped mode such as "constructor" reaches the mode refusal
  // below instead of an Object.prototype member.
  const reads = Object.hasOwn(SKETCH_PATTERN_MODE_FIELDS, fields.mode)
    ? SKETCH_PATTERN_MODE_FIELDS[fields.mode]
    : undefined
  if (reads !== undefined) {
    for (const field of PATTERN_FIELDS) {
      if (fields[field] !== undefined && !reads.includes(field)) {
        return { reason: `${field} is not a ${fields.mode} field; ${fields.mode} reads ${reads.join(', ')}` }
      }
    }
  }
  // The cap is checked against the authored count before any instance is
  // built, so a runaway count is refused without allocating it.
  const requested = patternInstanceCount(fields)
  if (Number.isFinite(requested) && requested > MAX_PATTERN_INSTANCES) {
    return { reason: `count ${requested} is above the cap of ${MAX_PATTERN_INSTANCES} instances` }
  }
  const transforms: SketchTransform[] = []
  switch (fields.mode) {
    case 'linear': {
      const problem = countProblem(fields.count, 'count') ?? nonZeroProblem(fields.pitch, 'pitch')
      if (problem !== null) return { reason: problem }
      const dir = unitDirection(fields.direction, [1, 0], 'direction')
      if (typeof dir === 'string') return { reason: dir }
      const count = fields.count as number
      if (count < 2) return { reason: 'count 1 is the source alone; a linear pattern needs count >= 2' }
      const pitch = fields.pitch as number
      for (let i = 1; i < count; i++) {
        transforms.push({ angleDeg: 0, cx: 0, cy: 0, tx: dir[0] * pitch * i, ty: dir[1] * pitch * i })
      }
      break
    }
    case 'grid': {
      const problem = countProblem(fields.count, 'count') ?? countProblem(fields.count2, 'count2')
        ?? nonZeroProblem(fields.pitch, 'pitch') ?? nonZeroProblem(fields.pitch2, 'pitch2')
      if (problem !== null) return { reason: problem }
      const dir = unitDirection(fields.direction, [1, 0], 'direction')
      if (typeof dir === 'string') return { reason: dir }
      const dir2 = unitDirection(fields.direction2, [0, 1], 'direction2')
      if (typeof dir2 === 'string') return { reason: dir2 }
      // Parallel directions fold the grid onto one line, where the copies of
      // the two axes overlap instead of tiling.
      if (Math.abs(dir[0] * dir2[1] - dir[1] * dir2[0]) < 1e-9) {
        return { reason: 'direction2 is parallel to direction; a grid needs two independent directions' }
      }
      const count = fields.count as number
      const count2 = fields.count2 as number
      if (count * count2 < 2) return { reason: 'count 1 by count2 1 is the source alone; a grid needs at least two instances' }
      const pitch = fields.pitch as number
      const pitch2 = fields.pitch2 as number
      for (let j = 0; j < count2; j++) {
        for (let i = 0; i < count; i++) {
          if (i === 0 && j === 0) continue
          transforms.push({
            angleDeg: 0, cx: 0, cy: 0,
            tx: dir[0] * pitch * i + dir2[0] * pitch2 * j,
            ty: dir[1] * pitch * i + dir2[1] * pitch2 * j,
          })
        }
      }
      break
    }
    case 'rotate': {
      const problem = countProblem(fields.count, 'count') ?? nonZeroProblem(fields.angle_deg, 'angle_deg')
      if (problem !== null) return { reason: problem }
      if (fields.center !== undefined && !isFinitePoint(fields.center)) {
        return { reason: `center must be a finite [x, y] point, got ${JSON.stringify(fields.center)}` }
      }
      const count = fields.count as number
      if (count < 2) return { reason: 'count 1 is the source alone; a rotate pattern needs count >= 2' }
      const [cx, cy] = fields.center ?? [0, 0]
      for (let i = 1; i < count; i++) {
        transforms.push({ angleDeg: (fields.angle_deg as number) * i, cx, cy, tx: 0, ty: 0 })
      }
      break
    }
    case 'copy': {
      if (fields.angle_deg !== undefined && (typeof fields.angle_deg !== 'number' || !Number.isFinite(fields.angle_deg))) {
        return { reason: `angle_deg must be a finite number, got ${JSON.stringify(fields.angle_deg)}` }
      }
      if (fields.center !== undefined && !isFinitePoint(fields.center)) {
        return { reason: `center must be a finite [x, y] point, got ${JSON.stringify(fields.center)}` }
      }
      if (fields.translate !== undefined && !isFinitePoint(fields.translate)) {
        return { reason: `translate must be a finite [x, y] vector, got ${JSON.stringify(fields.translate)}` }
      }
      const [cx, cy] = fields.center ?? [0, 0]
      const [tx, ty] = fields.translate ?? [0, 0]
      const t = { angleDeg: fields.angle_deg ?? 0, cx, cy, tx, ty }
      if (!options.crossSketch && sameTransform(t, IDENTITY)) {
        return { reason: 'the copy transform is the identity, so the copy would land on the source; give translate or angle_deg' }
      }
      transforms.push(t)
      break
    }
    default:
      return { reason: `mode must be one of ${SKETCH_PATTERN_MODES.join(', ')}, got ${JSON.stringify((fields as { mode: unknown }).mode)}` }
  }

  // A stacked copy is a second coincident profile, which the loop builder
  // would read as overlapping material rather than a new instance. Cross-sketch
  // identity copies were admitted above and are the one exception.
  const placed: SketchTransform[] = options.crossSketch ? [] : [IDENTITY]
  for (let i = 0; i < transforms.length; i++) {
    const t = transforms[i]
    if (!allFinite([t.angleDeg, t.cx, t.cy, t.tx, t.ty])) return { reason: `instance ${i + 1} has a non-finite transform` }
    if (placed.some(p => sameTransform(p, t))) {
      return { reason: `instance ${i + 1} lands on an earlier instance; the step, angle or pitch stacks copies` }
    }
    placed.push(t)
  }
  return { transforms }
}

/**
 * The transformed flat params of one entity, or null when the kind or block
 * cannot be copied (unknown kind, wrong block length, non-finite input). Every
 * coordinate pair moves; sizes (radius, semi-axes, spans) are invariant, and
 * the angle slots of an arc or ellipse turn with the rotation. An arc keeps its
 * CCW sweep with a0 normalized into [0, 360) and a1 = a0 + span.
 */
export function transformEntityParams(
  kind: EntityKind | string,
  params: readonly number[],
  t: SketchTransform,
  handles?: 'start' | 'end' | 'both',
): number[] | null {
  if (!allFinite(params) || canonicalVertexPositions(kind, params, handles) === null) return null
  const pt = (i: number): [number, number] => transformPoint([params[i], params[i + 1]], t)
  switch (kind) {
    case 'line': {
      const a = pt(0)
      const b = pt(2)
      return [a[0], a[1], b[0], b[1]].map(round)
    }
    case 'point':
      return pt(0).map(round)
    case 'circle': {
      const c = pt(0)
      return [c[0], c[1], params[2]].map(round)
    }
    case 'arc': {
      const c = pt(0)
      const span = arcSpanDeg(params[3], params[4])
      const a0 = normDeg(params[3] + t.angleDeg)
      return [c[0], c[1], params[2], a0, a0 + span].map(round)
    }
    case 'ellipse': {
      // theta keeps its turn (not folded into [0, 360) beyond one wrap), so
      // major1 stays the end the rotation carried it to.
      const c = pt(0)
      return [c[0], c[1], params[2], params[3], (params[4] + t.angleDeg) % 360].map(round)
    }
    case 'spline':
    case 'fit_spline': {
      // Every slot pair is a position (Bezier controls, fit points and the
      // end handles alike), so moving each pair moves the curve.
      const out: number[] = []
      for (let i = 0; i < params.length; i += 2) out.push(...pt(i))
      return out.map(round)
    }
    default:
      return null
  }
}

/** The vertex key of the copy that names the image of `key` on the source. A
 *  rigid motion keeps every named vertex in its slot (an arc's start stays its
 *  start, an ellipse's major1 its major1), so this is the identity. It exists
 *  as the one place the applier asks, like mirrorVertexKey for the mirror. */
export function transformVertexKey(_kind: EntityKind | string, key: string): string {
  return key
}

/** The rotation of a transform folded to a quarter turn index (0..3), or null
 *  when it is not a multiple of 90 deg. */
export function quarterTurns(angleDeg: number): 0 | 1 | 2 | 3 | null {
  const n = normDeg(angleDeg)
  const k = Math.round(n / 90)
  if (Math.abs(n - k * 90) > 1e-9) return null
  return (k % 4) as 0 | 1 | 2 | 3
}

/** horizontal/vertical under a rotation: kept at 0 and 180, swapped at 90 and
 *  270, and null for any other angle, where a rotated horizontal line is
 *  neither horizontal nor vertical. */
export function rotatedAxisKind(kind: 'horizontal' | 'vertical', angleDeg: number): 'horizontal' | 'vertical' | null {
  const q = quarterTurns(angleDeg)
  if (q === null) return null
  if (q % 2 === 0) return kind
  return kind === 'horizontal' ? 'vertical' : 'horizontal'
}

/**
 * A signed axis distance (point_distance_x/y, residual `b[axis] - a[axis] -
 * sign * value`) under a rotation. A quarter turn maps dx to dy and dy to -dx,
 * so the kind swaps and the sign follows the coordinate it lands on; a half
 * turn negates both. Null for any other angle. An absent sign stays absent.
 */
export function rotatedAxisDistance(
  kind: 'point_distance_x' | 'point_distance_y',
  sign: number | undefined,
  angleDeg: number,
): { kind: 'point_distance_x' | 'point_distance_y'; sign: number | undefined } | null {
  const q = quarterTurns(angleDeg)
  if (q === null) return null
  const isX = kind === 'point_distance_x'
  // (dx, dy) -> q=1: (-dy, dx); q=2: (-dx, -dy); q=3: (dy, -dx). The source's
  // measured coordinate lands on the copy's coordinate with the factor below.
  const factor = q === 0 ? 1 : q === 2 ? -1 : q === 1 ? (isX ? 1 : -1) : (isX ? -1 : 1)
  const outKind = q % 2 === 0 ? kind : isX ? 'point_distance_y' : 'point_distance_x'
  return { kind: outKind, sign: sign === undefined ? undefined : sign * factor }
}

/** A one-axis restriction (`midpoint` axis x/y) under a rotation: kept at 0
 *  and 180, swapped at 90 and 270, null otherwise. `both` (or no axis) is
 *  rotation-invariant. */
export function rotatedConstraintAxis(axis: string | undefined, angleDeg: number): string | undefined | null {
  if (axis !== 'x' && axis !== 'y') return axis
  const q = quarterTurns(angleDeg)
  if (q === null) return null
  if (q % 2 === 0) return axis
  return axis === 'x' ? 'y' : 'x'
}

/**
 * A `fixed` override under a transform: both coordinates move as a point; a
 * one-coordinate pin survives only a quarter-turn multiple, where its image is
 * again a pin on one coordinate (swapped at 90 and 270). Null when the pin has
 * no fixed-override image (`x = 3` turned by 30 deg is a slanted line).
 */
export function transformFixedOverride(
  x: number | undefined,
  y: number | undefined,
  t: SketchTransform,
): { x?: number; y?: number } | null {
  if (x === undefined && y === undefined) return {}
  if (x !== undefined && y !== undefined) {
    const [nx, ny] = transformPoint([x, y], t)
    return { x: round(nx), y: round(ny) }
  }
  const q = quarterTurns(t.angleDeg)
  if (q === null) return null
  // With the other coordinate set to zero, the copy's pinned coordinate reads
  // only the known one at a quarter-turn multiple (its partner's coefficient
  // is exactly zero there).
  const [nx, ny] = transformPoint([x ?? 0, y ?? 0], t)
  const pinsX = (x !== undefined) === (q % 2 === 0)
  return pinsX ? { x: round(nx) } : { y: round(ny) }
}
