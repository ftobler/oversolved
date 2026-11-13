// The DXF profile writer: one mutation appends every parsed entity to a sketch
// as ordinary authored geometry, so the import is one undo entry and every
// entity is editable by the existing tools. The parser owns the file contract;
// this writer only guards the document boundary.

import type { PartDoc } from '@/types/cad'
import { parseDxfProfile } from '@/utils/dxfImport'
import { lengthUnitOf } from '@/utils/lengthUnit'
import { allFinite, mintEntityId, parseTarget, resolveSketch, round, uniqueConstraintId, warn } from './helpers'

/**
 * The DXF profile writer: one mutation appends every parsed entity to a sketch
 * as authored geometry, held by one Group constraint so the import arrives at
 * exactly its two translations of freedom. Deleting that one constraint hands
 * back free-form geometry; `group: false` imports without it for a client that
 * wants to constrain the rows itself. Either way the whole import is one undo
 * entry.
 */
export function applyImportDxf(
  doc: PartDoc,
  featureId: string,
  content: string,
  layers?: readonly string[],
  group?: boolean,
): void {
  let profile
  try {
    profile = parseDxfProfile(content, lengthUnitOf(doc.length_unit), layers === undefined ? undefined : { layers })
  } catch (e) {
    // The picker and the drive value rule report the refusal before dispatch;
    // a direct internal caller gets a loud no-op instead of a half import.
    warn('applyImportDxf: refusing DXF', e)
    return
  }
  // Parse before resolving the sketch: a refused file must not even create the
  // empty entity containers, which would turn a no-op into a real doc write.
  const feature = resolveSketch(doc, featureId, 'entities', 'initial')
  if (!feature) return
  const imported: string[] = []
  for (const entity of profile.entities) {
    // The parser checks each coordinate, so this is the same belt-and-braces
    // gate every seed writer has against a future parser slip.
    if (!allFinite(entity.params)) continue
    const entityId = mintEntityId(feature.entities)
    feature.entities.push({ id: entityId, kind: entity.kind })
    feature.initial[entityId] = entity.params.map(round)
    imported.push(entityId)
  }
  if (group === false || imported.length === 0) return
  // The group is created in the same mutation, so it is the same undo entry.
  // Its anchor is the first imported row, and every row is a whole entity the
  // import just authored.
  const constraints = feature.constraints ?? (feature.constraints = [])
  constraints.push({
    id: uniqueConstraintId(constraints, 'group'),
    kind: 'group',
    refs: imported.map(id => parseTarget(id, featureId)),
  })
}
