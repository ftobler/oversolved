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
  warn, round, findFeature, findSketchFeature, resolveSketch, freshEntityIds, uniqueConstraintId,
} from './helpers'
import { carryConstraints, type CarryTemplate } from './sketchCarry'
import { resolveBarePlaneId } from '@/kernel/solverConstants'
import { entityDisplayName, entityKindWord, featureDisplayName } from '@/utils/core/displayNames'
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
  const rows = doc.features ?? []
  const source = findSketchFeature(doc, step.featureId)
  if (source === undefined) {
    const other = findFeature(doc, step.featureId)
    return {
      reason: other === undefined
        ? 'names no feature in this document'
        : `${featureDisplayName(other, rows)} is not a sketch`,
      code: 'unknown-target',
    }
  }

  let target: SketchFeature = source
  if (step.targetFeatureId !== undefined && step.targetFeatureId !== step.featureId) {
    if (step.mode !== 'copy') {
      return { reason: `targetFeatureId is a copy-mode field; a ${step.mode} pattern repeats inside its own sketch`, code: 'invalid' }
    }
    const other = findSketchFeature(doc, step.targetFeatureId)
    if (other === undefined) {
      const named = findFeature(doc, step.targetFeatureId)
      return {
        reason: named === undefined
          ? 'targetFeatureId names no feature in this document'
          : `targetFeatureId names ${featureDisplayName(named, rows)}, which is not a sketch`,
        code: 'unknown-target',
      }
    }
    if (normalizedPlane(source.plane) !== normalizedPlane(other.plane)) {
      return {
        reason: `cannot map between different sketch planes (${JSON.stringify(source.plane ?? '')} and ${JSON.stringify(other.plane ?? '')}); `
          + 'author the geometry in the target or use add_projected_entity for a part edge',
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
        reason: `the picked source names no entity in ${featureDisplayName(source, rows)}; use a bare entity id from that sketch`,
        code: 'unknown-target',
      }
    }

    const block = source.initial?.[id] ?? []
    const params: number[][] = []
    for (const t of transforms) {
      const moved = transformEntityParams(def.kind, block, t, def.handles)
      if (moved === null) {
        return {
          reason: `${entityDisplayName(source, id) ?? 'the picked source'} `
            + `(a ${entityKindWord(def.kind) ?? 'curve'}) has no copyable parameter block`,
          code: 'invalid',
        }
      }
      params.push(moved)
    }
    sources.push({ def, params })
  }

  const adding = transforms.length * sources.length
  const holding = (target.entities ?? []).length
  if (holding + adding > MAX_SKETCH_ENTITIES) {
    return {
      reason: `would add ${adding} entities to the ${holding} already in ${featureDisplayName(target, rows)}; the sketch holds at most ${MAX_SKETCH_ENTITIES}`,
      code: 'invalid',
    }
  }

  const carried = carryConstraints(source.constraints ?? [], [...seen], 'pattern', 'pattern_entities').templates
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
