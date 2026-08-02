import type { Mutation, SketchData } from '@/types/cad'

// Mutations that remove content from the model invalidate the affected
// feature's last-known solve result. Pruning it optimistically keeps stale
// geometry off screen between mutation-apply and solve-landing. Only a
// whole-feature removal (delete_feature) carries a restorable snapshot: a
// partial delete's snapshot holds geometry for entities the doc no longer has,
// so restoring it after a failing solve would draw them as ghosts. Partial
// deletes stay pruned and the viewport's doc-driven fallback renders correctly.
function featureIdsTouched(m: Mutation): string[] {
  if (m.type === 'delete') {
    // delete targets are wire refs like 'entity:S1:l2' or 'constraint:S1:c1';
    // the feature id is always the second segment.
    return [...new Set(m.targets.map(t => t.split(':')[1]).filter(Boolean))]
  }
  switch (m.type) {
    case 'delete_feature':
    case 'add_delete_body':
    case 'set_feature_suppression':
    case 'remove_delete_body_ref':
    case 'remove_extrude_profile':
    case 'remove_revolve_profile':
    case 'remove_sweep_profile':
    case 'remove_sweep_path':
    case 'remove_fillet_edge':
    case 'remove_chamfer_edge':
    case 'remove_boolean_tool':
    case 'remove_transform_body':
      return [m.featureId]
    default:
      return []
  }
}

export function pruneSolveResults(
  m: Mutation,
  prev: Record<string, SketchData>,
): { next: Record<string, SketchData>; restorable: Record<string, SketchData> | null } {
  const wholeFeatureRemoval = m.type === 'delete_feature'
  let next = prev
  const restorable: Record<string, SketchData> = {}
  for (const featureId of featureIdsTouched(m)) {
    if (!(featureId in prev)) continue
    if (wholeFeatureRemoval) restorable[featureId] = prev[featureId]
    if (next === prev) next = { ...prev }
    delete next[featureId]
  }
  return { next, restorable: Object.keys(restorable).length > 0 ? restorable : null }
}
