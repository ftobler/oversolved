// The pattern_entities applier: repeat a set of sketch entities as ordinary
// authored geometry, along a line, over a grid, around a centre, or as one
// transformed copy (optionally into another sketch on the same plane). The
// math lives in utils/geometry/sketchPattern; this file owns the plan every
// caller shares (the drive rule refuses by the same reasons) and the one-pass
// document write, so a 63-tooth row is one mutation and one undo entry.
//
// Carry policy (feature/sketch-entity-pattern.md, the mirror's minus the axis):
// - A constraint is cloned only when every operand names a source entity (or a
//   vertex of one); the clone names the copy of that source in the SAME
//   instance. Anything reaching outside the source set (another entity, another
//   feature, an n-ary sugar list) stays on the source alone: the copies are a
//   row of profiles, not live children of the source. A `group` follows the
//   same rule over all its members and copies as one group per instance.
// - Values and `sign` carry unchanged: a rigid motion keeps lengths, angles and
//   handedness. The orientation-bound kinds follow the instance's rotation:
//   horizontal/vertical and point_distance_x/y swap at a quarter turn and drop
//   at any angle that is not a multiple of 90, a midpoint's x/y axis likewise,
//   and a one-coordinate `fixed` swaps or drops the same way while a two-
//   coordinate one moves as a point. Label `pos` offsets rotate.
// - Ids are minted in one block, instance-major then sourceIds order, and never
//   derived from the source ids.

import type { PartConstraint, PartDoc, PartEntityDef, SketchFeature } from '@/types/cad'
import {
  warn, round, findSketchFeature, resolveSketch, freshEntityIds, uniqueConstraintId,
  CONSTRAINT_REF_FIELDS,
} from './helpers'
import { isVertexPointKey } from '@/types/vertexKeys'
import { CARRY_KINDS } from './sketchMirror'
import { resolveBarePlaneId } from '@/kernel/solverConstants'
import {
  instanceTransforms, transformEntityParams, transformVertexKey, transformVector,
  rotatedAxisKind, rotatedAxisDistance, rotatedConstraintAxis, transformFixedOverride,
  MAX_SKETCH_ENTITIES, type SketchPatternFields, type SketchTransform,
} from '@/utils/geometry/sketchPattern'

/** The authored step, as the Mutation variant carries it. */
export type PatternEntitiesStep = SketchPatternFields & {
  featureId: string
  sourceIds: string[]
  targetFeatureId?: string
}

/** Everything the write needs, computed and checked before any write. */
export interface PatternEntitiesPlan {
  targetId: string
  // params[k] is the source's block moved by transforms[k].
  sources: { def: PartEntityDef; params: number[][] }[]
  transforms: SketchTransform[]
  carried: CarryTemplate[]
}

export type PatternEntitiesRefusal = { reason: string; code: 'invalid' | 'unknown-target' }

/** One constraint the copies may carry: its operand fields resolved once to
 *  the source each names and the vertex suffix, so each instance only
 *  substitutes ids. */
interface CarryTemplate {
  constraint: PartConstraint
  // prefix is the stored ref's own leading `$` (or nothing for a bare id),
  // kept so the clone is spelled like its source.
  operands: { field: keyof PartConstraint; sourceId: string; key: string; prefix: string }[]
  /** A group's member refs, in anchor-first order, with each member's point key
   *  so the copy names the transformed image. Pooled separately from `operands`
   *  because a group has no single-ref field: each member is one entry of its
   *  `refs` array. */
  groupRefs?: { sourceId: string; key: string; prefix: string }[]
}

/** A sketch's plane ref in one spelling: `Front`, `builtin_plane_front` and
 *  `@builtin_plane_front` are one plane, as are `pl1` and `@pl1`. A face query
 *  (`?`) compares as the exact stored string, since the mutation layer has no
 *  solve to resolve it. An absent plane is its own value. */
function normalizedPlane(plane: string | undefined): string {
  if (plane === undefined || plane === '') return ''
  if (plane.includes('?')) return plane
  const bare = plane.startsWith('@') ? plane.slice(1) : plane
  return '@' + (resolveBarePlaneId(bare) ?? bare)
}

/** Which source a stored operand names, with its vertex suffix, or null when
 *  it names anything else (another feature, an entity outside the set). */
function operandSource(ref: string, sourceIds: readonly string[]): { sourceId: string; key: string; prefix: string } | null {
  if (ref.startsWith('@')) return null
  const prefix = ref.startsWith('$') ? ref.slice(0, 1) : ''
  const body = ref.slice(prefix.length)
  for (const id of sourceIds) {
    if (body === id) return { sourceId: id, key: '', prefix }
    // Exact id plus a known vertex suffix, as refMatchesEntity reads it, so
    // `l10` is never taken for a vertex of `l1`.
    if (body.startsWith(id) && isVertexPointKey(body.slice(id.length))) {
      return { sourceId: id, key: body.slice(id.length), prefix }
    }
  }
  return null
}

/** The carry templates for the source sketch's constraints, dropping (with
 *  one warn each) what the policy never carries. */
function carryTemplates(constraints: readonly PartConstraint[], sourceIds: readonly string[]): CarryTemplate[] {
  const out: CarryTemplate[] = []
  for (const c of constraints) {
    if (c.kind === 'projection') continue
    // A group copies as one group per instance, over that instance's copies of
    // its members, and only when every member is a source. A member may be a
    // whole entity or a single point of one; the point key rides along so the
    // copy names the transformed point (a rigid motion keeps a named point in
    // its slot).
    if (c.kind === 'group') {
      const refs = Array.isArray(c.refs) ? c.refs : []
      const groupRefs: { sourceId: string; key: string; prefix: string }[] = []
      let outside = refs.length === 0
      for (const ref of refs) {
        const hit = typeof ref === 'string' ? operandSource(ref, sourceIds) : null
        if (hit === null) { outside = true; break }
        groupRefs.push({ sourceId: hit.sourceId, key: hit.key, prefix: hit.prefix })
      }
      if (outside) {
        warn('pattern_entities: group has a member outside the source set, left on the source', { id: c.id })
        continue
      }
      out.push({ constraint: c, operands: [], groupRefs })
      continue
    }
    const operandFields = CONSTRAINT_REF_FIELDS.filter(f => typeof c[f] === 'string')
    if (operandFields.length === 0) {
      // A refs-only sugar constraint (ngon) has no single-ref operand to map;
      // say so when it reaches a source, as the mirror does.
      const refs = Array.isArray(c.refs) ? c.refs : []
      if (refs.some(ref => typeof ref === 'string' && operandSource(ref, sourceIds) !== null)) {
        warn('pattern_entities: n-ary (sugar) constraint dropped', { id: c.id, kind: c.kind })
      }
      continue
    }
    const operands: CarryTemplate['operands'] = []
    let outside = false
    for (const field of operandFields) {
      const hit = operandSource(c[field] as string, sourceIds)
      if (hit === null) { outside = true; break }
      operands.push({ field, ...hit })
    }
    // A constraint that names no source at all is not the pattern's business;
    // only one that straddles the set and the rest of the sketch is a drop.
    if (outside) {
      if (operands.length > 0) warn('pattern_entities: constraint reaches outside the source set, left on the source', { id: c.id, kind: c.kind })
      continue
    }
    if (!CARRY_KINDS.has(c.kind)) {
      warn('pattern_entities: constraint kind carries no copied form, dropped', { id: c.id, kind: c.kind })
      continue
    }
    if (Array.isArray(c.refs) && c.refs.length > 0) {
      warn('pattern_entities: n-ary (sugar) constraint dropped', { id: c.id, kind: c.kind })
      continue
    }
    out.push({ constraint: c, operands })
  }
  return out
}

/** One template written for one instance, or null when the instance's
 *  rotation leaves the constraint no image (a horizontal turned by 30 deg). */
function instantiate(
  template: CarryTemplate,
  idMap: ReadonlyMap<string, string>,
  kindOf: ReadonlyMap<string, string>,
  t: SketchTransform,
): PartConstraint | null {
  const c = template.constraint
  const cloned: PartConstraint = { ...c }
  if (template.groupRefs !== undefined) {
    cloned.refs = template.groupRefs.map(g => {
      const key = g.key === '' ? '' : transformVertexKey(kindOf.get(g.sourceId) ?? '', g.key)
      return g.prefix + idMap.get(g.sourceId)! + key
    })
  }
  for (const op of template.operands) {
    const key = op.key === '' ? '' : transformVertexKey(kindOf.get(op.sourceId) ?? '', op.key)
    cloned[op.field] = (op.prefix + idMap.get(op.sourceId)! + key) as never
  }
  if (c.kind === 'horizontal' || c.kind === 'vertical') {
    const kind = rotatedAxisKind(c.kind, t.angleDeg)
    if (kind === null) return null
    cloned.kind = kind
  }
  if (c.kind === 'point_distance_x' || c.kind === 'point_distance_y') {
    const rotated = rotatedAxisDistance(c.kind, c.sign, t.angleDeg)
    if (rotated === null) return null
    cloned.kind = rotated.kind
    if (rotated.sign !== undefined) cloned.sign = rotated.sign
  }
  if (c.axis !== undefined) {
    const axis = rotatedConstraintAxis(c.axis, t.angleDeg)
    if (axis === null) return null
    if (axis !== undefined) cloned.axis = axis
  }
  if (c.kind === 'fixed') {
    const override = transformFixedOverride(c.x, c.y, t)
    if (override === null) return null
    delete cloned.x
    delete cloned.y
    Object.assign(cloned, override)
  }
  if (c.pos !== undefined) {
    const [px, py] = transformVector(c.pos, t)
    cloned.pos = [round(px), round(py)]
  }
  return cloned
}

/**
 * The checked plan for one step, or the reason it is refused. The drive rule
 * and the applier both call this, so a refusal at the boundary and a no-op in
 * the applier are the same verdict with the same words.
 */
export function planPatternEntities(doc: PartDoc, step: PatternEntitiesStep): PatternEntitiesPlan | PatternEntitiesRefusal {
  const source = findSketchFeature(doc, step.featureId)
  if (source === undefined) return { reason: `names no sketch feature ${JSON.stringify(step.featureId)}`, code: 'unknown-target' }

  let target: SketchFeature = source
  if (step.targetFeatureId !== undefined && step.targetFeatureId !== step.featureId) {
    if (step.mode !== 'copy') {
      return { reason: `targetFeatureId is a copy-mode field; a ${step.mode} pattern repeats inside its own sketch`, code: 'invalid' }
    }
    const other = findSketchFeature(doc, step.targetFeatureId)
    if (other === undefined) {
      return { reason: `targetFeatureId names no sketch feature ${JSON.stringify(step.targetFeatureId)}`, code: 'unknown-target' }
    }
    if (normalizedPlane(source.plane) !== normalizedPlane(other.plane)) {
      return {
        reason: `cannot map between different sketch planes (${JSON.stringify(source.plane ?? '')} and ${JSON.stringify(other.plane ?? '')}); `
          + 'author the geometry in the target or use add_projected_entity for a body edge',
        code: 'invalid',
      }
    }
    target = other
  }

  const built = instanceTransforms(step, { crossSketch: target !== source })
  if ('reason' in built) return { reason: built.reason, code: 'invalid' }
  const { transforms } = built

  if (!Array.isArray(step.sourceIds) || step.sourceIds.length === 0) {
    return { reason: 'sourceIds must name at least one entity', code: 'invalid' }
  }
  const byId = new Map((source.entities ?? []).map(e => [e.id, e]))
  const seen = new Set<string>()
  const sources: PatternEntitiesPlan['sources'] = []
  for (const id of step.sourceIds) {
    if (seen.has(id)) continue  // a source listed twice is copied once
    seen.add(id)
    const def = byId.get(id)
    if (def === undefined) {
      return {
        reason: `source id ${JSON.stringify(id)} names no entity in sketch ${step.featureId}; use a bare entity id from that sketch`,
        code: 'unknown-target',
      }
    }

    const block = source.initial?.[id] ?? []
    const params: number[][] = []
    for (const t of transforms) {
      const moved = transformEntityParams(def.kind, block, t, def.handles)
      if (moved === null) {
        return { reason: `source id ${JSON.stringify(id)} (a ${def.kind}) has no copyable parameter block`, code: 'invalid' }
      }
      params.push(moved)
    }
    sources.push({ def, params })
  }

  const adding = transforms.length * sources.length
  const holding = (target.entities ?? []).length
  if (holding + adding > MAX_SKETCH_ENTITIES) {
    return {
      reason: `would add ${adding} entities to the ${holding} already in sketch ${target.id}; the sketch holds at most ${MAX_SKETCH_ENTITIES}`,
      code: 'invalid',
    }
  }

  const carried = carryTemplates(source.constraints ?? [], [...seen])
  return { targetId: target.id, sources, transforms, carried }
}

/**
 * pattern_entities: copy `sourceIds` of the sketch `featureId` once per
 * instance transform as authored geometry, carrying the constraints among the
 * sources onto each copy. A refused step warns and leaves the document
 * untouched; the drive boundary is the user-visible refusal.
 */
export function applyPatternEntities(doc: PartDoc, step: PatternEntitiesStep): void {
  const plan = planPatternEntities(doc, step)
  if ('reason' in plan) {
    warn(`pattern_entities: ${plan.reason}`, { featureId: step.featureId })
    return
  }
  const target = resolveSketch(doc, plan.targetId, 'entities', 'initial', 'constraints')
  if (!target) return

  const perInstance = plan.sources.length
  const newIds = freshEntityIds(target.entities, plan.transforms.length * perInstance)
  const kindOf = new Map(plan.sources.map(s => [s.def.id, s.def.kind]))
  let dropped = 0
  plan.transforms.forEach((t, k) => {
    const idMap = new Map<string, string>()
    plan.sources.forEach((src, i) => {
      const newId = newIds[k * perInstance + i]
      idMap.set(src.def.id, newId)
      const def: PartEntityDef = { id: newId, kind: src.def.kind }
      if (src.def.construction) def.construction = true
      if (src.def.handles !== undefined) def.handles = src.def.handles
      target.entities.push(def)
      target.initial[newId] = src.params[k]
    })
    for (const template of plan.carried) {
      const cloned = instantiate(template, idMap, kindOf, t)
      if (cloned === null) { dropped++; continue }
      cloned.id = uniqueConstraintId(target.constraints, cloned.kind)
      target.constraints.push(cloned)
    }
  })
  if (dropped > 0) warn('pattern_entities: orientation-bound constraints have no image at a copy\'s angle, dropped', { dropped })
}
