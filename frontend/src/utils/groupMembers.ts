// The Group command's reading of a selection. A group holds whole entities or
// single points, and a marker clicked next to its own entity (a circle's centre,
// a line's endpoints) is a duplicate the user did not mean to add. The rules
// live here rather than in the store so the command is unit-tested without one:
//
//  - a vertex whose owner entity is also selected is dropped as a duplicate;
//  - an uncovered vertex becomes a point member;
//  - a Point entity's `xy` is the entity, so it becomes a whole member;
//  - the origin, dock/isect handles and projected geometry are skipped before
//    the command plans any projection, because they are not group members;
//  - a lone point holds nothing (its own pair is the translation), so it is
//    refused with one sentence.

const TOO_SMALL = 'Group needs at least two points, or one whole entity.'

export type GroupMembersResult = { targets: string[] } | { reason: string }

/** Split `vertex:<feature>:<entity>:<key>`; null for any other shape. */
function parseVertexPick(pick: string): { featureId: string; entityId: string; key: string } | null {
  if (!pick.startsWith('vertex:')) return null
  const parts = pick.split(':')
  if (parts.length !== 4 || !parts[1] || !parts[2] || !parts[3]) return null
  return { featureId: parts[1], entityId: parts[2], key: parts[3] }
}

/** Split `entity:<feature>:<entity>`; null for any other shape. */
function parseEntityPick(pick: string): { featureId: string; entityId: string } | null {
  if (!pick.startsWith('entity:')) return null
  const parts = pick.split(':')
  if (parts.length !== 3 || !parts[1] || !parts[2]) return null
  return { featureId: parts[1], entityId: parts[2] }
}

/**
 * The group members a selection names, or the sentence that refuses it.
 * `entityKindMap` is the editor's `entity:<feature>:<entity>` -> kind map (a
 * missing entry only means the Point promotion cannot be recognised; the
 * applier still normalizes `xy` on a Point). `projectedIds` are the sketch's
 * projected entities, which a group cannot hold.
 */
export function groupMembersFromSelection(
  selection: Iterable<string>,
  featureId: string,
  entityKindMap: Readonly<Record<string, string>>,
  projectedIds: ReadonlySet<string>,
): GroupMembersResult {
  const picks = [...selection]
  const order: string[] = []
  const wholeByEntity = new Map<string, string>()  // local entity id -> target
  const pointKeys = new Set<string>()
  let sawProjected = false
  let sawOrigin = false
  const isProjected = (entityId: string) => projectedIds.has(entityId)
  for (const pick of picks) {
    if (pick === '@builtin_origin') {
      sawOrigin = true
      continue
    }
    if (pick.startsWith('dock:') || pick.startsWith('isect:')) continue
    const entity = parseEntityPick(pick)
    if (entity !== null) {
      if (isProjected(entity.entityId)) {
        sawProjected = true
        continue
      }
      if (!wholeByEntity.has(entity.entityId)) {
        wholeByEntity.set(entity.entityId, pick)
        order.push(pick)
      }
      continue
    }
    const vertex = parseVertexPick(pick)
    if (vertex === null) continue
    if (isProjected(vertex.entityId)) {
      sawProjected = true
      continue
    }
    // A marker on an entity that is already a member adds rows that duplicate
    // the entity's own: the pick is kept, the marker dropped.
    if (wholeByEntity.has(vertex.entityId)) continue
    const kind = entityKindMap[`entity:${featureId}:${vertex.entityId}`]
    if (kind === 'point') {
      // `vertex:<P>:xy` is the whole Point primitive, and `$P` is how a whole
      // member is stored. Two picks cannot both name it.
      const whole = `entity:${vertex.featureId}:${vertex.entityId}`
      wholeByEntity.set(vertex.entityId, whole)
      order.push(whole)
      continue
    }
    if (!pointKeys.has(pick)) {
      pointKeys.add(pick)
      order.push(pick)
    }
  }
  // A whole pick may arrive after a marker on the same entity (a set keeps the
  // click order), so the covered-marker rule runs once the whole set is known.
  const targets = order.filter(pick => {
    const vertex = parseVertexPick(pick)
    return vertex === null || !wholeByEntity.has(vertex.entityId)
  })
  if (targets.length === 0) {
    if (sawProjected) return { reason: 'Group cannot hold projected geometry; select an authored entity or point.' }
    if (sawOrigin) return { reason: 'Group cannot hold the origin; select an authored entity or point.' }
    return { reason: TOO_SMALL }
  }
  if (targets.length === 1 && parseVertexPick(targets[0]) !== null) return { reason: TOO_SMALL }
  return { targets }
}
