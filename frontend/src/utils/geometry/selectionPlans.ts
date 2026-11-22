// The selection contracts behind mirror_entities, pattern_entities and
// fillet_corners. They are pure: the command's `enabled` verdict and the store
// action read one definition, and the core command table can import them
// without reaching into the editor store.
import type { FilletCorner } from '@/types/cad'
import type { FilletCornerMap } from '@/utils/geometry/filletCorner'

// The selection contract of mirror_entities: the selected entities are the
// sources and one selected line is the axis. A lone selected line is the axis;
// when the sources hold lines too (a half profile), the axis is the one
// selected construction line, the centerline convention. Vertex and constraint
// selections ride along untouched; the plan speaks in bare entity ids, the
// shape the mutation takes.
export interface MirrorSelectionPlan {
  axis: string
  sourceIds: string[]
}

export function mirrorSelectionPlan(
  selection: Set<string>,
  activeFeatureId: string | null,
  entityKindMap: Record<string, string>,
  // The construction entities as `entity:<sketch>:<id>` keys, the kind map's
  // key shape (constructionEntityKeys in the store).
  constructionKeys: ReadonlySet<string> = new Set(),
): MirrorSelectionPlan | { reason: string } {
  if (!activeFeatureId || selection.size === 0) return { reason: 'no entities selected' }
  const ids = [...selection]
    .filter(t => t.startsWith('entity:') && t.split(':')[1] === activeFeatureId)
    .map(t => t.split(':')[2])
  if (ids.length === 0) return { reason: 'no entities selected' }
  const lines = ids.filter(id => entityKindMap[`entity:${activeFeatureId}:${id}`] === 'line')
  if (lines.length === 0) return { reason: 'mirror needs a selected line to mirror across' }
  let axis = lines[0]
  if (lines.length > 1) {
    const centerlines = lines.filter(id => constructionKeys.has(`entity:${activeFeatureId}:${id}`))
    if (centerlines.length !== 1) {
      return { reason: 'with several lines selected, mirror needs exactly one construction line among them as the axis' }
    }
    axis = centerlines[0]
  }
  const sourceIds = ids.filter(id => id !== axis)
  // The axis alone is nothing to mirror; the drive boundary refuses the empty
  // sourceIds the same way, so the gate refuses it here too instead of letting
  // the mutation dispatch and do nothing.
  if (sourceIds.length === 0) return { reason: 'mirror needs an entity to mirror besides the axis line' }
  return { axis, sourceIds }
}

// The selection contract of pattern_entities: every selected entity of the
// active sketch is a source. A vertex or constraint selection names no entity
// to copy, so a selection holding only those is refused rather than read as
// "the entity under the vertex".
export function patternSelectionPlan(
  selection: Set<string>,
  activeFeatureId: string | null,
): { sourceIds: string[] } | { reason: string } {
  if (!activeFeatureId) return { reason: 'no active sketch' }
  const inSketch = [...selection].filter(t => t.split(':')[1] === activeFeatureId)
  const sourceIds = inSketch.filter(t => t.startsWith('entity:')).map(t => t.split(':')[2])
  if (sourceIds.length > 0) return { sourceIds }
  if (inSketch.some(t => t.startsWith('vertex:'))) {
    return { reason: 'pattern copies whole entities; select the entities, not their vertices' }
  }
  return { reason: 'select one or more entities of the active sketch to pattern' }
}

// The selection contract of fillet_corners: every selected vertex is one
// corner, and its partner comes from the corner map Geometry3D publishes for
// the active sketch. A selected vertex with no single line partner, or with a
// T-junction, is refused with the map's own reason so the gate and the drive
// boundary say the same thing.
export interface FilletSelectionPlan {
  corners: FilletCorner[]
}

export function filletSelectionPlan(
  selection: Set<string>,
  activeFeatureId: string | null,
  cornerMap: FilletCornerMap,
): FilletSelectionPlan | { reason: string } {
  if (!activeFeatureId) return { reason: 'no active sketch' }
  const vertices = [...selection].filter(target =>
    target.startsWith('vertex:') && target.split(':')[1] === activeFeatureId)
  if (vertices.length === 0) return { reason: 'select one or more sketch vertices to fillet' }

  const corners: FilletCorner[] = []
  const seen = new Set<string>()
  for (const target of vertices) {
    const parts = target.split(':')
    const entityId = parts[2]
    const vertexKey = parts[3]
    if (vertexKey !== 'start' && vertexKey !== 'end') {
      return { reason: `vertex "${entityId}:${vertexKey}" is not a line endpoint` }
    }
    const entry = cornerMap[target]
    if (entry === undefined) {
      return { reason: `vertex "${entityId}:${vertexKey}" has no line partner in this sketch` }
    }
    if ('reason' in entry) return { reason: entry.reason }
    const pairKey = [
      `${entityId}:${vertexKey}`,
      `${entry.partner.entityId}:${entry.partner.vertexKey}`,
    ].sort().join('|')
    if (seen.has(pairKey)) continue
    seen.add(pairKey)
    corners.push({
      a: entityId,
      aVertex: vertexKey,
      b: entry.partner.entityId,
      bVertex: entry.partner.vertexKey,
      ...(entry.side !== undefined && { side: entry.side }),
    })
  }
  if (corners.length === 0) return { reason: 'select one or more sketch vertices to fillet' }
  return { corners }
}
