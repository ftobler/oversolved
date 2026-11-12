// The fillet_corners applier: round one or more corners of a sketch profile by
// trimming both straight sides to their tangent points and joining them with one
// authored arc per corner. The math lives in utils/geometry/filletCorner; this
// file owns the document write and the constraint policy.
//
// Every corner is validated before the first write. A step with one bad corner
// applies nothing: there is no per-corner partial apply, and the drive boundary
// is expected to have refused the same step before it reached here.
//
// Constraint policy:
// - the coincident joint(s) between the two trimmed endpoints are deleted;
// - a side's `length` dimension measured the whole side before the trim, so it
//   is replaced: by the overall size between the two perpendicular sides when
//   that pair is unambiguous, else by the remaining straight run. Keeping the
//   old value on the shortened line collapses the arc and skews the profile;
// - the corner angle is carried by an explicit direction constraint when the
//   two sides no longer share a vertex that carried it: the matching
//   horizontal/vertical on the free side when one side already names the axis,
//   else an `angle` at the measured direction angle;
// - every new arc gets a `radius` dimension, so the arcs introduce no free
//   radius degree of freedom;
// - a tangent between the two sides, a second coincident on either trimmed
//   endpoint, or a fixed/dimension that anchors either trimmed endpoint is
//   refused by constraint id, because moving the endpoint would silently change
//   what it meant;
// - every other constraint is left alone.

import type { PartConstraint, PartDoc, SketchFeature } from '@/types/cad'
import { TOL_TOPOLOGY_MERGE } from '@/kernel/solverConstants'
import { lineVertexIndices } from '@/utils/geometry/offsetProfile'
import { computeAngleDimension } from '@/utils/geometry/angleDimensionLogic'
import {
  planFilletGeometry,
  type FilletCorner,
  type FilletCornerSide,
  type FilletGeometry,
} from '@/utils/geometry/filletCorner'
import {
  CONSTRAINT_REF_FIELDS,
  findSketchFeature,
  isVertexKeyRef,
  mintEntityId,
  refMatchesEntity,
  resolveSketch,
  round,
  warn,
} from './helpers'
import { applyAddConstraint, applyDeleteElements } from './sketch'

export interface PlannedFilletCorner extends FilletGeometry {
  // The joint coincidents to delete before the trims are written.
  removeConstraintIds: string[]
}

// One constraint the step authors after the trims. Radius dimensions are not
// listed here: they name the arc the applier mints, so it adds them inline.
export interface PlannedFilletConstraint {
  kind: string
  targets: string[]
  value?: number
  pos?: [number, number]
  // Directional dimensions (the overall line_distance) carry the side the
  // solved distance lies on, so a reversed source line still satisfies the
  // value instead of failing by twice it.
  sign?: number
}

export type FilletSketchPlan =
  | {
      corners: PlannedFilletCorner[]
      // The stale side `length` dimensions consumed by the rewrite.
      removeConstraintIds: string[]
      // Replacement dimensions and the direction constraints that preserve the
      // corner angles.
      addConstraints: PlannedFilletConstraint[]
    }
  | { code: 'invalid' | 'unknown-target'; reason: string }

type FilletSketchInput = Pick<SketchFeature, 'id' | 'entities' | 'initial' | 'constraints'>

type Point = [number, number]

interface LineInfo {
  id: string
  params: readonly number[]
  start: Point
  end: Point
  dir: Point
  length: number
  construction: boolean
}

const AXIS_ANGLE_TOL = 1e-6
const PARALLEL_TOL = 1e-6
// A side length is a dimension the user typed; the drawn overall distance only
// has to identify which pair of sides the value names, so it tolerates the
// solver's own noise.
const OVERALL_TOL_REL = 1e-4
const OVERALL_TOL_ABS = 1e-4

const DIRECTION_KINDS = new Set(['horizontal', 'vertical', 'angle', 'parallel', 'normal', 'colinear'])

function constraintRefs(c: PartConstraint): string[] {
  const refs: string[] = []
  for (const field of CONSTRAINT_REF_FIELDS) {
    const value = c[field]
    if (typeof value === 'string') refs.push(value)
  }
  if (Array.isArray(c.refs)) refs.push(...c.refs)
  if (typeof c.circle === 'string') refs.push(c.circle)
  return refs
}

function touchesEntity(c: PartConstraint, entityId: string): boolean {
  return constraintRefs(c).some(ref => refMatchesEntity(ref, entityId))
}

function touchesVertex(c: PartConstraint, entityId: string, vertexKey: string): boolean {
  return constraintRefs(c).some(ref => isVertexKeyRef(ref, entityId, vertexKey))
}

function isJoint(c: PartConstraint, corner: FilletCorner): boolean {
  if (c.kind !== 'coincident' || typeof c.a !== 'string' || typeof c.b !== 'string') return false
  const forward = isVertexKeyRef(c.a, corner.a, corner.aVertex)
    && isVertexKeyRef(c.b, corner.b, corner.bVertex)
  const backward = isVertexKeyRef(c.a, corner.b, corner.bVertex)
    && isVertexKeyRef(c.b, corner.a, corner.aVertex)
  return forward || backward
}

function lineInfo(entity: FilletCornerSide): LineInfo | null {
  if (entity.kind !== 'line' || entity.params.length < 4) return null
  const [x0, y0, x1, y1] = entity.params
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null
  const dx = x1 - x0
  const dy = y1 - y0
  const length = Math.hypot(dx, dy)
  if (!(length > 0)) return null
  return {
    id: entity.id,
    params: entity.params,
    start: [x0, y0],
    end: [x1, y1],
    dir: [dx / length, dy / length],
    length,
    construction: entity.construction === true,
  }
}

/** The absolute axis a line currently lies on, or null when it is not
 *  axis-aligned. The tolerance is angular, expressed against the unit
 *  direction, so it reads the same at every sketch scale. */
function axisOf(line: LineInfo): 'horizontal' | 'vertical' | null {
  if (Math.abs(line.dir[1]) <= AXIS_ANGLE_TOL) return 'horizontal'
  if (Math.abs(line.dir[0]) <= AXIS_ANGLE_TOL) return 'vertical'
  return null
}

function cross(a: Point, b: Point): number {
  return a[0] * b[1] - a[1] * b[0]
}

function dot(a: Point, b: Point): number {
  return a[0] * b[0] + a[1] * b[1]
}

function sub(a: Point, b: Point): Point {
  return [a[0] - b[0], a[1] - b[1]]
}

/**
 * The overall-size replacement for one side's stale `length`: the distance
 * between the two parallel lines perpendicular to the side, measured to a
 * vertex of the far one. The rectangle's bottom length is the distance between
 * its two vertical sides, which is the number the user typed and which the
 * trimmed geometry keeps exactly.
 *
 * Only an unambiguous pair is accepted. An open chain, a triangle, or a profile
 * with several equally plausible parallel pairs falls back to the straight-run
 * rewrite, which is always true of the trimmed line.
 */
function overallPair(
  side: LineInfo,
  value: number,
  lines: readonly LineInfo[],
  neighbourIds: ReadonlySet<string>,
  usedPairs: ReadonlySet<string>,
): { line: LineInfo; point: LineInfo; sign: number } | null {
  const tol = Math.max(OVERALL_TOL_ABS, Math.abs(value) * OVERALL_TOL_REL)
  const candidates: Array<{ line: LineInfo; point: LineInfo; key: string; neighbour: boolean }> = []
  for (const line of lines) {
    if (line.id === side.id || line.construction !== side.construction) continue
    // The measuring line must be perpendicular to the dimensioned side.
    if (Math.abs(dot(line.dir, side.dir)) > PARALLEL_TOL) continue
    for (const point of lines) {
      if (point.id === side.id || point.id === line.id) continue
      if (point.construction !== side.construction) continue
      // The two sides the dimension spans are parallel to each other.
      if (Math.abs(cross(line.dir, point.dir)) > PARALLEL_TOL) continue
      const separation = Math.abs(cross(line.dir, sub(point.start, line.start)))
      if (Math.abs(separation - value) > tol) continue
      // The dimensioned side has to lie between the pair, or this is some other
      // parallel pair that happens to be the same distance apart.
      const fromLine = cross(line.dir, sub(side.start, line.start))
      const fromPoint = cross(line.dir, sub(side.start, point.start))
      if (fromLine * fromPoint > 0) continue
      const key = [line.id, point.id].sort().join('|')
      if (usedPairs.has(key)) continue
      candidates.push({
        line,
        point,
        key,
        neighbour: neighbourIds.has(line.id) || neighbourIds.has(point.id),
      })
    }
  }
  if (candidates.length === 0) return null
  const preferred = candidates.filter(candidate => candidate.neighbour)
  const pool = preferred.length > 0 ? preferred : candidates
  // Several distinct pairs of the same size are ambiguous: guessing one would
  // dimension a relation the user never named.
  const keys = new Set(pool.map(candidate => candidate.key))
  if (keys.size > 1) return null
  const [only] = pool
  // The solver's line_distance measures the signed perpendicular offset from
  // the line's own direction; the pair is parallel, so the far side's vertex
  // fixes which side of the line the size is on. Without the sign a reversed
  // source line fails by twice the value.
  const signed = cross(only.line.dir, sub(only.point.start, only.line.start))
  return { line: only.line, point: only.point, sign: signed >= 0 ? 1 : -1 }
}

/** How much the fillet cuts off this side: one tangent distance per trimmed
 *  end. */
function trimTotal(sideId: string, corners: readonly FilletGeometry[]): number {
  let total = 0
  for (const corner of corners) {
    if (corner.a === sideId || corner.b === sideId) total += corner.tangentDistance
  }
  return total
}

function hasDirectionConstraint(
  constraints: readonly PartConstraint[],
  entityId: string,
): boolean {
  return constraints.some(c => DIRECTION_KINDS.has(c.kind) && touchesEntity(c, entityId))
}

function axisConstraintKind(
  constraints: readonly PartConstraint[],
  addedAxis: ReadonlyMap<string, 'horizontal' | 'vertical'>,
  entityId: string,
): 'horizontal' | 'vertical' | null {
  const added = addedAxis.get(entityId)
  if (added !== undefined) return added
  for (const c of constraints) {
    if ((c.kind === 'horizontal' || c.kind === 'vertical') && touchesEntity(c, entityId)) {
      return c.kind
    }
  }
  return null
}

/** The solver's `angle` value: the unsigned angle between the two lines'
 *  stored direction vectors, in degrees. Authoring it near the current geometry
 *  keeps the corner exactly where it is drawn. */
function directionAngle(a: LineInfo, b: LineInfo): number | null {
  const cosine = Math.max(-1, Math.min(1, dot(a.dir, b.dir)))
  const theta = Math.acos(cosine) * (180 / Math.PI)
  if (!Number.isFinite(theta) || theta < 1e-6 || 180 - theta < 1e-6) return null
  return round(theta)
}

/** A label offset, relative to the corner vertex, on the interior bisector, so
 *  the angle dimension reads the corner the fillet leaves. The offset, not an
 *  absolute point: an angle dim's stored `pos` is vertex-relative. Its wedge
 *  decides the value the plan passes (see displayedCornerAngle). */
function angleLabelPos(corner: FilletGeometry): [number, number] | null {
  const bx = corner.center[0] - corner.corner[0]
  const by = corner.center[1] - corner.corner[1]
  const length = Math.hypot(bx, by)
  if (!(length > 1e-12)) return null
  const radius = Math.max(corner.radius * 2, corner.tangentDistance, 1e-3)
  return [
    round((bx / length) * radius),
    round((by / length) * radius),
  ]
}

/** The number the dimension label at `pos` shows for this corner: theta when
 *  `pos` lands in a theta wedge, 180 - theta in a supplement wedge. The angle
 *  applier reads an `add_constraint` value as that displayed number and stores
 *  theta again, so the plan must plan the displayed value. */
function displayedCornerAngle(
  a: LineInfo,
  b: LineInfo,
  theta: number,
  pos: [number, number],
): number {
  const geometry = computeAngleDimension(
    [a.params[0], a.params[1]], [a.params[2], a.params[3]],
    [b.params[0], b.params[1]], [b.params[2], b.params[3]],
    pos,
  )
  return round(geometry.isSupplement ? 180 - theta : theta)
}

/**
 * Validate the whole step and return the geometry plus the constraints to
 * delete and author. Shared by the applier and the drive value rule so an
 * external step is refused for exactly the reason the document write would use.
 */
export function planFilletCorners(
  feature: FilletSketchInput,
  radius: number,
  corners: readonly FilletCorner[],
): FilletSketchPlan {
  const entities = feature.entities ?? []
  const initial = feature.initial ?? {}
  const constraints = feature.constraints ?? []
  const byId = new Map(entities.map(entity => [entity.id, entity]))

  for (let index = 0; index < corners.length; index++) {
    for (const [id, key] of [[corners[index].a, 'a'], [corners[index].b, 'b']] as const) {
      if (!byId.has(id)) {
        return {
          code: 'unknown-target',
          reason: `corner ${index}: side "${id}" (${key}) names no entity in the sketch`,
        }
      }
    }
  }

  const heldByProjection = new Set(
    (feature.constraints ?? [])
      .filter(c => c.kind === 'projection' && typeof c.target === 'string')
      .map(c => String(c.target).replace(/^\$/, '')),
  )
  const sides: FilletCornerSide[] = entities.map(entity => ({
    id: entity.id,
    kind: entity.kind,
    params: initial[entity.id] ?? [],
    construction: entity.construction === true,
    heldByProjection: heldByProjection.has(entity.id),
  }))
  const geometry = planFilletGeometry(sides, corners, radius)
  if ('reason' in geometry) {
    return { code: geometry.missingId === undefined ? 'invalid' : 'unknown-target', reason: geometry.reason }
  }

  const planned: PlannedFilletCorner[] = []
  for (let index = 0; index < geometry.corners.length; index++) {
    const corner = corners[index]
    const geo = geometry.corners[index]
    const where = `corner ${index}`

    const joints = constraints.filter(c => isJoint(c, corner))
    const jointIds = new Set(joints.map(c => c.id))

    // A tangent between the two sides says the corner does not exist: the
    // "corner" is already a smooth blend.
    const tangent = constraints.find(c =>
      c.kind === 'tangent' && touchesEntity(c, corner.a) && touchesEntity(c, corner.b))
    if (tangent !== undefined) {
      return {
        code: 'invalid',
        reason: `${where}: sides "${corner.a}" and "${corner.b}" already meet tangentially `
          + `(constraint "${tangent.id}"); there is no corner to fillet`,
      }
    }

    for (const side of [
      { id: corner.a, key: corner.aVertex },
      { id: corner.b, key: corner.bVertex },
    ]) {
      const secondJoint = constraints.find(c =>
        c.kind === 'coincident' && !jointIds.has(c.id) && touchesVertex(c, side.id, side.key))
      if (secondJoint !== undefined) {
        return {
          code: 'invalid',
          reason: `${where}: the trimmed endpoint "${side.id}:${side.key}" carries a second coincident `
            + `(constraint "${secondJoint.id}"); a T-junction or duplicate joint is ambiguous`,
        }
      }

      const fixed = constraints.find(c =>
        c.kind === 'fixed'
        && (touchesEntity(c, side.id) || touchesVertex(c, side.id, side.key)))
      if (fixed !== undefined) {
        return {
          code: 'invalid',
          reason: `${where}: constraint "${fixed.id}" is a fixed on the trimmed endpoint `
            + `"${side.id}:${side.key}"; remove or re-anchor it first`,
        }
      }

      const dimension = constraints.find(c =>
        c.value !== undefined && touchesVertex(c, side.id, side.key))
      if (dimension !== undefined) {
        return {
          code: 'invalid',
          reason: `${where}: constraint "${dimension.id}" dimensions the trimmed endpoint `
            + `"${side.id}:${side.key}"; remove or re-anchor it first`,
        }
      }
    }

    planned.push({ ...geo, removeConstraintIds: [...jointIds] })
  }

  const lines: LineInfo[] = []
  for (const entity of entities) {
    const info = lineInfo({
      id: entity.id,
      kind: entity.kind,
      params: initial[entity.id] ?? [],
      construction: entity.construction === true,
    })
    if (info !== null) lines.push(info)
  }
  const lineById = new Map(lines.map(line => [line.id, line]))

  // The sides each corner trims, with the neighbour it shares that corner with.
  const trimmedSides = new Set<string>()
  const neighbours = new Map<string, Set<string>>()
  for (const corner of planned) {
    for (const [id, other] of [[corner.a, corner.b], [corner.b, corner.a]] as const) {
      trimmedSides.add(id)
      const set = neighbours.get(id) ?? new Set<string>()
      set.add(other)
      neighbours.set(id, set)
    }
  }

  const removeConstraintIds: string[] = []
  const addConstraints: PlannedFilletConstraint[] = []
  const usedPairs = new Set<string>()
  // Sides whose direction the planned `parallel` replacements already tie to
  // another side; the angle pass must not state it a second time.
  const plannedParallel = new Set<string>()

  // A `length` dimension measured the side before the trim. Left as-is it
  // asserts a straight run the fillet just shortened, which the solver answers
  // by collapsing the arcs. Replace it with what the user meant.
  for (const id of [...trimmedSides].sort()) {
    for (const dimension of constraints) {
      if (dimension.kind !== 'length' || dimension.value === undefined) continue
      if (!touchesEntity(dimension, id)) continue
      if (!Number.isFinite(dimension.value)) continue
      const side = lineById.get(id)
      if (side === undefined) continue
      const pair = overallPair(side, dimension.value, lines, neighbours.get(id) ?? new Set(), usedPairs)
      if (pair !== null) {
        usedPairs.add([pair.line.id, pair.point.id].sort().join('|'))
        addConstraints.push({
          kind: 'line_distance',
          targets: [`entity:${feature.id}:${pair.line.id}`, `vertex:${feature.id}:${pair.point.id}:start`],
          value: round(Math.abs(dimension.value)),
          sign: pair.sign,
          ...(dimension.pos !== undefined ? { pos: [dimension.pos[0], dimension.pos[1]] as [number, number] } : {}),
        })
      } else {
        const straight = round(dimension.value - trimTotal(id, planned))
        // The geometry plan already refuses a radius that consumes the line, so
        // this is positive by construction; the guard keeps a rounding edge from
        // authoring a zero length.
        const value = straight > 0 ? straight : round(side.length)
        addConstraints.push({
          kind: 'length',
          targets: [`entity:${feature.id}:${id}`],
          value,
          ...(dimension.pos !== undefined ? { pos: [dimension.pos[0], dimension.pos[1]] as [number, number] } : {}),
        })
      }
      removeConstraintIds.push(dimension.id)
    }
  }

  // A trim changes a line's straight length, so an `equal_length` between a
  // trimmed side and an untrimmed (or differently trimmed) one no longer states
  // what the user asserted: keeping it makes the step unsatisfiable. What the
  // pair still means is its direction, so a pair that was parallel keeps a
  // `parallel` and the equality is dropped. A non-parallel equal pair has no
  // surviving form and is dropped outright; the direction pass below still
  // restates its corner. Pairs trimmed by the same amount keep the equality.
  const trimTotalById = new Map<string, number>()
  for (const id of trimmedSides) trimTotalById.set(id, trimTotal(id, planned))
  for (const c of constraints) {
    if (c.kind !== 'equal_length' || typeof c.a !== 'string' || typeof c.b !== 'string') continue
    if (!c.a.startsWith('$') || !c.b.startsWith('$')) continue
    const leftId = c.a.slice(1)
    const rightId = c.b.slice(1)
    const left = trimTotalById.get(leftId)
    const right = trimTotalById.get(rightId)
    if (left === undefined && right === undefined) continue
    if (Math.abs((left ?? 0) - (right ?? 0)) <= 1e-6) continue
    removeConstraintIds.push(c.id)
    const a = lineById.get(leftId)
    const b = lineById.get(rightId)
    // A pair whose two sides already name a direction does not need the
    // parallel stated again; both axis constraints (or an existing relation)
    // keep the direction the equality used to imply.
    const bothDirected = hasDirectionConstraint(constraints, leftId)
      && hasDirectionConstraint(constraints, rightId)
    if (!bothDirected && a !== undefined && b !== undefined && Math.abs(cross(a.dir, b.dir)) <= PARALLEL_TOL) {
      plannedParallel.add(leftId)
      plannedParallel.add(rightId)
      addConstraints.push({
        kind: 'parallel',
        targets: [`entity:${feature.id}:${leftId}`, `entity:${feature.id}:${rightId}`],
      })
    }
  }

  // The consumed coincident carried the corner angle only while the two sides
  // shared a vertex. Once a tangent arc stands in for that vertex, an
  // axis-aligned side keeps its absolute direction only if the sketch said so
  // elsewhere, and a closed loop's implied right angle is gone. Add the
  // smallest constraint that fixes the relative direction again.
  const addedAxis = new Map<string, 'horizontal' | 'vertical'>()
  const addedAngles = new Set<string>()
  const sideHasDirection = (entityId: string): boolean =>
    plannedParallel.has(entityId)
    || addedAxis.has(entityId)
    || [...addedAngles].some(key => key.split('|').includes(entityId))
    || hasDirectionConstraint(constraints, entityId)

  const handled = new Set<number>()
  for (let pass = 0; pass <= planned.length; pass++) {
    let progressed = false
    for (let index = 0; index < planned.length; index++) {
      if (handled.has(index)) continue
      const corner = planned[index]
      const aDir = sideHasDirection(corner.a)
      const bDir = sideHasDirection(corner.b)
      if (aDir && bDir) {
        handled.add(index)
        progressed = true
        continue
      }
      const constrained = aDir ? corner.a : corner.b
      const free = aDir ? corner.b : corner.a
      const freeAxis = lineById.get(free) !== undefined ? axisOf(lineById.get(free)!) : null
      const namedAxis = aDir || bDir ? axisConstraintKind(constraints, addedAxis, constrained) : null
      // A right-angle corner is made of the two different axes: naming the axis
      // the constrained side is on and then the free side the same way would
      // assert a collinear corner, which the geometry plan already refused.
      if (freeAxis !== null && namedAxis !== null && namedAxis !== freeAxis) {
        addedAxis.set(free, freeAxis)
        addConstraints.push({ kind: freeAxis, targets: [`entity:${feature.id}:${free}`] })
        handled.add(index)
        progressed = true
        continue
      }
      const a = lineById.get(corner.a)
      const b = lineById.get(corner.b)
      if (a === undefined || b === undefined) {
        handled.add(index)
        continue
      }
      const theta = directionAngle(a, b)
      if (theta !== null) {
        const key = [corner.a, corner.b].sort().join('|')
        addedAngles.add(key)
        const pos = angleLabelPos(corner)
        addConstraints.push({
          kind: 'angle',
          targets: [`entity:${feature.id}:${corner.a}`, `entity:${feature.id}:${corner.b}`],
          value: pos !== null ? displayedCornerAngle(a, b, theta, pos) : theta,
          ...(pos !== null ? { pos } : {}),
        })
      }
      handled.add(index)
      progressed = true
    }
    if (!progressed) break
  }

  return { corners: planned, removeConstraintIds, addConstraints }
}

function trimEndpoint(params: number[], vertexKey: 'start' | 'end', to: readonly [number, number]): void {
  const indices = lineVertexIndices(vertexKey)
  if (indices === null) return
  const [ix, iy] = indices
  // An endpoint already at the tangent point is left byte-identical: rounding it
  // again would rewrite the same number for no reason.
  if (Math.hypot(params[ix] - to[0], params[iy] - to[1]) <= TOL_TOPOLOGY_MERGE) return
  params[ix] = to[0]
  params[iy] = to[1]
}

/**
 * fillet_corners: trim each named side to its tangent point and join the pair
 * with a tangent arc. One mutation is one undo entry, whatever the corner count.
 */
export function applyFilletCorners(
  doc: PartDoc,
  featureId: string,
  radius: number,
  corners: readonly FilletCorner[],
): void {
  const feature = findSketchFeature(doc, featureId)
  if (feature === undefined) {
    warn('fillet_corners: feature id names no sketch', { featureId })
    return
  }
  const plan = planFilletCorners(feature, radius, corners)
  if ('reason' in plan) {
    warn('fillet_corners: refused, document left untouched', { featureId, reason: plan.reason })
    return
  }

  const writable = resolveSketch(doc, featureId, 'entities', 'initial', 'constraints')
  if (writable === undefined) return

  const removeIds = [...plan.corners.flatMap(corner => corner.removeConstraintIds), ...plan.removeConstraintIds]
  if (removeIds.length > 0) {
    applyDeleteElements(doc, removeIds.map(id => `constraint:${featureId}:${id}`))
  }

  for (const corner of plan.corners) {
    const paramsA = writable.initial[corner.a]
    const paramsB = writable.initial[corner.b]
    if (paramsA === undefined || paramsB === undefined) continue
    trimEndpoint(paramsA, corner.aVertex, corner.ta)
    trimEndpoint(paramsB, corner.bVertex, corner.tb)

    const arcId = mintEntityId(writable.entities)
    writable.entities.push(corner.construction
      ? { id: arcId, kind: 'arc', construction: true }
      : { id: arcId, kind: 'arc' })
    writable.initial[arcId] = [...corner.arc]

    applyAddConstraint(doc, featureId, 'coincident', [
      `vertex:${featureId}:${corner.a}:${corner.aVertex}`,
      `vertex:${featureId}:${arcId}:${corner.arcStart}`,
    ])
    applyAddConstraint(doc, featureId, 'coincident', [
      `vertex:${featureId}:${arcId}:${corner.arcEnd}`,
      `vertex:${featureId}:${corner.b}:${corner.bVertex}`,
    ])
    applyAddConstraint(doc, featureId, 'tangent', [
      `entity:${featureId}:${corner.a}`,
      `entity:${featureId}:${arcId}`,
    ])
    applyAddConstraint(doc, featureId, 'tangent', [
      `entity:${featureId}:${arcId}`,
      `entity:${featureId}:${corner.b}`,
    ])
    // One radius dimension per arc keeps the radius the user asked for. Without
    // it the arc is a free radius and the solver is free to shrink it.
    applyAddConstraint(doc, featureId, 'radius', [`entity:${featureId}:${arcId}`], corner.radius)
  }

  for (const constraint of plan.addConstraints) {
    applyAddConstraint(
      doc, featureId, constraint.kind, constraint.targets,
      constraint.value, constraint.pos, constraint.sign,
    )
  }
}
