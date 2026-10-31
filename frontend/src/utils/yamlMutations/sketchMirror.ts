// The mirror_entities applier: clone a set of sketch entities as mirrored
// authored geometry across a line of the same sketch. The math lives in
// utils/geometry/mirrorSketch; this file owns document writes: fresh entity ids
// (seeded-id-scope deterministic), mirrored initial blocks, and constraint
// carry-over.
//
// Carry-over policy (settled in feature/sketch-mirror.md):
// - A constraint is cloned only when every entity ref it names is a mirrored
//   source or the axis line. Axis refs are kept as-is: an entity pinned to the
//   axis mirrors to an entity pinned to the same axis at the same foot point.
//   Anything naming a source-set-external entity (or another feature) is
//   dropped, warned, and left on the sources.
// - Refs rewrite the entity id; vertex keys remap by position
//   (mirrorVertexKey), so arc start/end swap out of the angle formula and an
//   ellipse axis end lands on whichever canonical end mirrors to it.
// - Geometric relations and measurements carry with their value unchanged.
//   Directional dimensions (sign-carrying point_distance_x/y, line_distance,
//   angle) flip their `sign` selector: the mirror swaps the side the signed
//   measure matched. `fixed` mirrors its x/y overrides; a label `pos` offset
//   reflects as a vector.
// - horizontal/vertical carry as-is for an axis-aligned axis and swap for a
//   45/135 deg axis; for any other axis they are dropped, because a mirrored
//   horizontal line is neither horizontal nor vertical and carrying the
//   constraint would distort the copy.
// - Sugar/dock kinds (offset, ngon, dock) and unknown kinds are dropped.

import type { PartConstraint, PartDoc, PartEntityDef } from '@/types/cad'
import {
  warn, round, resolveSketch, freshEntityIds, uniqueConstraintId, refMatchesEntity,
  CONSTRAINT_REF_FIELDS,
} from './helpers'
import {
  mirrorAxisFromLineParams, mirrorAxisAngleDeg, mirrorEntityParams, mirrorVertexKey,
  mirrorPoint, mirrorVector, type MirrorAxis,
} from '@/utils/geometry/mirrorSketch'

// Constraint kinds cloned with their value and operands intact. horizontal and
// vertical are the axis-dependent pair handled separately; everything outside
// this set (dimension sugar, ngon, dock, focus...) is never cloned.
const CARRY_KINDS = new Set([
  'coincident', 'concentric', 'equal_length', 'parallel', 'normal', 'tangent',
  'midpoint', 'colinear', 'fixed', 'length', 'radius', 'diameter',
  'radius_difference', 'point_distance', 'point_distance_x', 'point_distance_y',
  'line_distance', 'angle', 'horizontal', 'vertical',
])

// The kind whose side selector the mirror reverses: the signed measure ran from
// one side of its datum, and the mirrored copy sits on the other.
const SIGN_FLIP_KINDS = new Set(['point_distance_x', 'point_distance_y', 'line_distance', 'angle'])

/** axisAngleDeg folded into [0, 180) with the special angles of a reflection:
 *  0/90 keep horizontal/vertical, 45/135 swap them. Anything in between leaves
 *  an axis-aligned line neither. */
function axisAlignedKind(kind: 'horizontal' | 'vertical', axisAngleDeg: number): 'horizontal' | 'vertical' | null {
  const fold = ((axisAngleDeg % 180) + 180) % 180
  const near = (d: number) => Math.abs(fold - d) < 1e-6
  const swap = near(45) || near(135)
  if (!swap && !near(0) && !near(90)) return null
  if (!swap) return kind
  return kind === 'horizontal' ? 'vertical' : 'horizontal'
}

interface MirrorPlan {
  axis: MirrorAxis
  axisId: string
  idMap: Map<string, string>
  entityById: Map<string, PartEntityDef>
  initial: Record<string, number[]>
}

/** Rewrite one stored operand ref to the mirrored entity, or null when the ref
 *  names something the mirror does not carry (another feature, a source-set
 *  external entity, or a vertex whose image has no canonical key). An axis ref
 *  is returned unchanged. */
function rewriteRef(ref: string, plan: MirrorPlan): string | null {
  const wire = ref.startsWith('$') || ref.startsWith('@')
  if (ref.startsWith('@')) return null  // cross-feature (or builtin) operand: out of scope
  if (refMatchesEntity(wire ? ref : '$' + ref, plan.axisId)) return ref  // an axis ref (bare or vertex-suffixed) addresses the axis, and the axis does not move
  const body = wire ? ref.slice(1) : ref
  const prefix = wire ? '$' : ''
  for (const [srcId, newId] of plan.idMap) {
    if (body === srcId) return prefix + newId
    if (refMatchesEntity(wire ? ref : '$' + ref, srcId)) {
      const key = body.slice(srcId.length)
      const def = plan.entityById.get(srcId)
      if (def === undefined) return null
      const mapped = mirrorVertexKey(
        def.kind, key, plan.initial[srcId] ?? [], plan.axis, def.handles,
      )
      if (mapped === null) return null
      return prefix + newId + mapped
    }
  }
  return null
}

/** The cloned form of one constraint, or null (with a warn) when policy drops
 *  it: an operand outside the mirror set, a kind that carries no mirrored form,
 *  or an axis remap that the axis angle does not admit. */
function cloneMirrorConstraint(c: PartConstraint, plan: MirrorPlan, constraints: PartConstraint[]): PartConstraint | null {
  const cloned: PartConstraint = { ...c }

  if (!CARRY_KINDS.has(c.kind)) {
    warn('mirror_entities: constraint kind carries no mirrored form, dropped', { id: c.id, kind: c.kind })
    return null
  }

  // Every string operand must rewrite; a null anywhere drops the whole
  // constraint rather than anchoring half of it to the mirrored copy.
  const operandFields = CONSTRAINT_REF_FIELDS.filter(f => typeof c[f] === 'string')
  const refsField = Array.isArray(c.refs) && c.refs.length > 0 ? c.refs : null
  if (refsField !== null) {
    warn('mirror_entities: n-ary (sugar) constraint dropped', { id: c.id, kind: c.kind })
    return null
  }
  let mappedToMirror = 0
  for (const field of operandFields) {
    const rewritten = rewriteRef(c[field] as string, plan)
    if (rewritten === null) {
      warn('mirror_entities: constraint names an entity outside the mirror set, dropped', { id: c.id, kind: c.kind })
      return null
    }
    if (rewritten !== c[field]) mappedToMirror++
    cloned[field] = rewritten as never
  }
  if (mappedToMirror === 0) return null  // nothing mirrored participates (an axis-only or external pair)

  if (c.kind === 'horizontal' || c.kind === 'vertical') {
    const remapped = axisAlignedKind(c.kind, mirrorAxisAngleDeg(plan.axis))
    if (remapped === null) {
      warn('mirror_entities: horizontal/vertical does not survive this axis angle, dropped', { id: c.id, kind: c.kind })
      return null
    }
    cloned.kind = remapped
  }
  if (c.sign !== undefined && SIGN_FLIP_KINDS.has(c.kind)) cloned.sign = -c.sign
  if (c.kind === 'fixed') {
    if (c.x !== undefined) cloned.x = round(mirrorPoint([c.x ?? 0, c.y ?? 0], plan.axis)[0])
    if (c.y !== undefined) cloned.y = round(mirrorPoint([c.x ?? 0, c.y ?? 0], plan.axis)[1])
  }
  if (c.pos !== undefined) {
    const [px, py] = mirrorVector(c.pos, plan.axis)
    cloned.pos = [round(px), round(py)]
  }
  cloned.id = uniqueConstraintId(constraints, cloned.kind)
  return cloned
}

/**
 * mirror_entities: clone `sourceIds` of the sketch `featureId` as mirrored
 * authored geometry across the line entity `line`. Fresh deterministic ids;
 * mirrored initial blocks; constraints carried per the policy at the top of
 * this file. The axis is the axis: it is never mirrored itself, and projected
 * entities (whose geometry re-projects from their source) are not mirrored.
 */
export function applyMirrorEntities(
  doc: PartDoc,
  featureId: string,
  sourceIds: string[],
  lineId: string,
): void {
  const feature = resolveSketch(doc, featureId, 'entities', 'initial', 'constraints')
  if (!feature) return

  const axisDef = feature.entities.find(e => e.id === lineId)
  if (axisDef === undefined || axisDef.kind !== 'line') {
    warn('mirror_entities: line must name a line entity in the sketch', { featureId, lineId })
    return
  }
  const axis = mirrorAxisFromLineParams(feature.initial[lineId] ?? [])
  if (axis === null) {
    warn('mirror_entities: the axis line is degenerate or non-finite', { featureId, lineId })
    return
  }

  const copies: { srcId: string; def: PartEntityDef; params: number[] }[] = []
  const seen = new Set<string>()
  for (const id of sourceIds) {
    if (id === lineId || seen.has(id)) continue  // the axis mirrors nothing; a listed twice mirrors once
    seen.add(id)
    const def = feature.entities.find(e => e.id === id)
    if (def === undefined) {
      warn('mirror_entities: source id names no entity in the sketch', { featureId, id })
      continue
    }
    if (def.source !== undefined) {
      warn('mirror_entities: projected entities are not mirrored', { featureId, id })
      continue
    }
    const params = mirrorEntityParams(def.kind, feature.initial[id] ?? [], axis, def.handles)
    if (params === null) {
      warn('mirror_entities: entity block cannot be mirrored', { featureId, id, kind: def.kind })
      continue
    }
    copies.push({ srcId: id, def, params })
  }
  if (copies.length === 0) return

  const newIds = freshEntityIds(feature.entities, copies.length)
  const idMap = new Map<string, string>()
  copies.forEach((copy, i) => {
    const newId = newIds[i]
    idMap.set(copy.srcId, newId)
    const def: PartEntityDef = { id: newId, kind: copy.def.kind }
    if (copy.def.construction) def.construction = true
    if (copy.def.handles !== undefined) def.handles = copy.def.handles
    feature.entities.push(def)
    feature.initial[newId] = copy.params
  })

  const plan: MirrorPlan = {
    axis,
    axisId: lineId,
    idMap,
    entityById: new Map(feature.entities.map(e => [e.id, e])),
    initial: feature.initial,
  }
  // Iterate a snapshot: the clones must not feed the loop that made them.
  for (const c of [...feature.constraints]) {
    const cloned = cloneMirrorConstraint(c, plan, feature.constraints)
    if (cloned !== null) feature.constraints.push(cloned)
  }
}
