// PURE LOGIC -- no Three.js, no React, no store.
// Builds the moved set for a drag that starts on an element of the current
// selection. The drag state carries one element; when the press lands on a
// selected entity or vertex the whole in-sketch selection moves with it, and
// the release commits it as one move_sketch_group.
import type { DragMember } from '@/types/drag'

export interface GroupDragStart {
  type: 'vertex' | 'edge'
  entityId: string
  vertexKey: string
}

/** A selection id as the local element it names, or null for anything that is
 *  not a sketch entity/vertex of `featureId` (a constraint, another sketch, a
 *  body pick). Entity ids are colon-free, so the slice recovers the owner. */
function localSelectionRef(
  id: string,
  featureId: string,
): { kind: 'entity' | 'vertex'; entityId: string; vertexKey?: string } | null {
  const parts = id.split(':')
  if (parts[0] === 'entity' && parts.length >= 3 && parts[1] === featureId) {
    return { kind: 'entity', entityId: parts.slice(2).join(':') }
  }
  if (parts[0] === 'vertex' && parts.length >= 4 && parts[1] === featureId) {
    return {
      kind: 'vertex',
      entityId: parts.slice(2, -1).join(':'),
      vertexKey: parts[parts.length - 1],
    }
  }
  return null
}

/**
 * The members a drag starting on `start` moves, or undefined for a single drag.
 *
 * "Part of the selection" means the pressed element is selected: the entity, or
 * a vertex of it, or the vertex itself. A group is every selected entity of the
 * active sketch moved whole, plus every selected vertex whose entity is not
 * already whole, moved as that point only. Vertices subsumed by a whole entity
 * collapse into it, so pressing a selected corner of a selected line does not
 * move that corner twice.
 *
 * Undefined when the press is not on the selection (today's single drag), and
 * when the result would be just the pressed element (again the single drag it
 * already is). Constraints, dimensions and other sketches' ids are ignored.
 */
export function groupDragMembers(
  selection: ReadonlySet<string>,
  featureId: string,
  start: GroupDragStart,
): DragMember[] | undefined {
  const wholeEntities: string[] = []
  const points: Array<{ entityId: string; vertexKey: string }> = []
  for (const id of selection) {
    const ref = localSelectionRef(id, featureId)
    if (ref === null) continue
    if (ref.kind === 'entity') wholeEntities.push(ref.entityId)
    else if (ref.vertexKey !== undefined) points.push({ entityId: ref.entityId, vertexKey: ref.vertexKey })
  }

  const startSelected = wholeEntities.includes(start.entityId)
    || (start.type === 'vertex'
      && points.some(p => p.entityId === start.entityId && p.vertexKey === start.vertexKey))
  if (!startSelected) return undefined

  const whole = new Set(wholeEntities)
  const members: DragMember[] = []
  const seen = new Set<string>()
  for (const entityId of wholeEntities) {
    const key = `e:${entityId}`
    if (seen.has(key)) continue
    seen.add(key)
    members.push({ entityId, vertexKey: 'edge' })
  }
  for (const point of points) {
    if (whole.has(point.entityId)) continue
    const key = `v:${point.entityId}:${point.vertexKey}`
    if (seen.has(key)) continue
    seen.add(key)
    members.push(point)
  }

  // One member is the pressed element alone: the caller keeps the plain vertex
  // or edge gesture, with its snap effects and its narrower mutation.
  return members.length > 1 ? members : undefined
}
