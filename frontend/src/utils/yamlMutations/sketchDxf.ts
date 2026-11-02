// The DXF profile writer: one mutation appends every parsed entity to a sketch
// as ordinary authored geometry, so the import is one undo entry and every
// entity is editable by the existing tools. The parser owns the file contract;
// this writer only guards the document boundary.

import type { PartDoc } from '@/types/cad'
import { parseDxfProfile } from '@/utils/dxfImport'
import { lengthUnitOf } from '@/utils/lengthUnit'
import { allFinite, mintEntityId, resolveSketch, round, warn } from './helpers'

export function applyImportDxf(doc: PartDoc, featureId: string, content: string): void {
  let profile
  try {
    profile = parseDxfProfile(content, lengthUnitOf(doc.length_unit))
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
  for (const entity of profile.entities) {
    // The parser checks each coordinate, so this is the same belt-and-braces
    // gate every seed writer has against a future parser slip.
    if (!allFinite(entity.params)) continue
    const entityId = mintEntityId(feature.entities)
    feature.entities.push({ id: entityId, kind: entity.kind })
    feature.initial[entityId] = entity.params.map(round)
  }
}
