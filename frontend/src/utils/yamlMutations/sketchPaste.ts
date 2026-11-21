// The paste_sketch_entities applier: write one clipboard clip into a sketch as
// ordinary authored geometry. The clip is self-contained (utils/clipboard owns
// its format and the carry rule that built it), so this is a pure document
// write: fresh ids, unit conversion, one offset, and the carried constraints
// rewritten onto the new entities. One paste is one mutation and one undo
// entry, in the same document or another, on the same plane or another.

import type { PartConstraint, PartDoc, PartEntityDef, SketchEntitiesClip } from '@/types/cad'
import {
  findSketchFeature, resolveSketch, freshEntityIds, uniqueConstraintId,
  MutationRefusal, round, CONSTRAINT_REF_FIELDS,
} from './helpers'
import { isVertexPointKey } from '@/types/vertexKeys'
import { MM_PER_LENGTH_UNIT, lengthUnitOf } from '@/utils/lengthUnit'
import { MAX_SKETCH_ENTITIES, scaleEntityParams, transformEntityParams } from '@/utils/geometry/sketchPattern'
import { validateClip, PASTE_NEEDS_SKETCH } from '@/utils/clipboard/sketchClipboard'

/** The constraint kinds whose `value` is a length, so a cross-unit paste
 *  converts it. `angle` is degrees and every other carried kind has no value. */
const LENGTH_VALUE_KINDS: ReadonlySet<string> = new Set([
  'length', 'radius', 'diameter', 'radius_difference',
  'point_distance', 'point_distance_x', 'point_distance_y', 'line_distance',
])

function sameSketchRef(ref: string, clipId: string): string | null {
  const prefix = ref.startsWith('$') ? '$' : ''
  const bare = ref.slice(prefix.length)
  if (bare === clipId) return prefix
  if (bare.startsWith(clipId) && isVertexPointKey(bare.slice(clipId.length))) return prefix
  return null
}

/** Rewrite one stored clip ref onto its pasted entity, keeping the `$` prefix
 *  and the vertex suffix the source spelled. */
function rewriteRef(ref: string, idMap: ReadonlyMap<string, string>): string {
  for (const [clipId, newId] of idMap) {
    const prefix = sameSketchRef(ref, clipId)
    if (prefix === null) continue
    const bare = ref.slice(prefix.length)
    return prefix + newId + bare.slice(clipId.length)
  }
  // validateClip has already refused a ref outside the clip; reaching here is a
  // bug in the map, not a user state, so the applier refuses loudly.
  throw new MutationRefusal(`The clipboard names ${ref}, which is not in the copied geometry.`)
}

function finiteOffset(offset: readonly number[] | undefined): [number, number] {
  if (offset === undefined) return [0, 0]
  if (offset.length !== 2 || offset.some(v => !Number.isFinite(v))) {
    throw new MutationRefusal('The paste offset must be a finite [x, y] point.')
  }
  return [offset[0], offset[1]]
}

/**
 * Paste one clip into the sketch `featureId`, offset by `offset` in the target
 * document unit. Throws a MutationRefusal (with the exact sentence the toast
 * shows) on anything the clipboard cannot be: no open sketch, a malformed clip,
 * a unit it does not read, or a sketch too full for the rows. A refusal leaves
 * the document untouched.
 */
export function applyPasteSketchEntities(
  doc: PartDoc,
  m: { featureId: string; clip: SketchEntitiesClip; offset?: [number, number] | number[] },
): void {
  if (findSketchFeature(doc, m.featureId) === undefined) throw new MutationRefusal(PASTE_NEEDS_SKETCH)

  const checked = validateClip(m.clip)
  if ('reason' in checked) throw new MutationRefusal(checked.reason)

  const target = resolveSketch(doc, m.featureId, 'entities', 'initial', 'constraints')
  if (!target) throw new MutationRefusal(PASTE_NEEDS_SKETCH)

  const holding = target.entities.length
  if (holding + checked.entities.length > MAX_SKETCH_ENTITIES) {
    throw new MutationRefusal(
      `would add ${checked.entities.length} entities to the ${holding} already in sketch ${target.id}; `
      + `the sketch holds at most ${MAX_SKETCH_ENTITIES}`,
    )
  }

  const [ox, oy] = finiteOffset(m.offset)
  const factor = MM_PER_LENGTH_UNIT[checked.length_unit] / MM_PER_LENGTH_UNIT[lengthUnitOf(doc.length_unit)]
  const ids = freshEntityIds(target.entities, checked.entities.length)
  const idMap = new Map<string, string>()
  checked.entities.forEach((entity, index) => idMap.set(entity.id, ids[index]))

  const carried: PartConstraint[] = []
  for (const entity of checked.entities) {
    const newId = idMap.get(entity.id)!
    const params = scaleEntityParams(entity.kind, checked.initial[entity.id], factor, entity.handles)
    if (params === null) {
      throw new MutationRefusal(`Entity ${entity.id} in the clipboard is not valid: its parameters cannot be pasted.`)
    }
    const moved = transformEntityParams(
      entity.kind, params,
      { angleDeg: 0, cx: 0, cy: 0, tx: ox, ty: oy },
      entity.handles,
    )
    if (moved === null) {
      throw new MutationRefusal(`Entity ${entity.id} in the clipboard is not valid: its parameters cannot be pasted.`)
    }
    const def: PartEntityDef = { id: newId, kind: entity.kind }
    if (entity.construction) def.construction = true
    if (entity.handles !== undefined) def.handles = entity.handles
    target.entities.push(def)
    target.initial[newId] = moved
  }

  for (const source of checked.constraints) {
    const cloned: PartConstraint = { ...source }
    for (const field of CONSTRAINT_REF_FIELDS) {
      const ref = cloned[field]
      if (typeof ref === 'string') cloned[field] = rewriteRef(ref, idMap) as never
    }
    if (Array.isArray(cloned.refs)) cloned.refs = cloned.refs.map(ref => rewriteRef(ref, idMap))
    if (typeof cloned.circle === 'string') cloned.circle = rewriteRef(cloned.circle, idMap)
    if (cloned.value !== undefined && LENGTH_VALUE_KINDS.has(cloned.kind)) {
      cloned.value = round(cloned.value * factor)
    }
    if (cloned.pos !== undefined) {
      // `pos` is the label's offset from the constraint's own anchor, not a
      // sketch position: the paste translation must not move it, or the label
      // would jump a whole paste away from its dimension. Only the unit
      // conversion scales the vector.
      cloned.pos = [round(cloned.pos[0] * factor), round(cloned.pos[1] * factor)]
    }
    cloned.id = uniqueConstraintId(target.constraints, cloned.kind)
    carried.push(cloned)
  }
  target.constraints.push(...carried)
}
