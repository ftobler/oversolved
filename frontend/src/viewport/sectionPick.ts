// Translating one normal selection pick into a section plane source. Kept out
// of the dispatcher so the "which picks may name a section plane" rule is
// testable without a canvas or an ID buffer.
import { FACE_LAYER_NAME, PLANE_LAYER_NAME } from '@/picking/layerNames'
import type { BuiltinSectionPlaneId, SectionPlaneSource } from '@/viewport/sectionPlane'

export interface SectionPickCandidate {
  layer: string
  entityKey: string
}

// The builtin reference planes are not solve results, so a viewport pick on one
// has to become a builtin source rather than a query that would not resolve.
const BUILTIN_PLANE_QUERIES: Record<string, BuiltinSectionPlaneId> = {
  builtin_plane_front: 'front',
  builtin_plane_top: 'top',
  builtin_plane_right: 'right',
}

/**
 * A B-rep face or a reference/user plane names a section plane; every other
 * pickable (an edge, a vertex, sketch geometry, a handle) does not.
 */
export function sectionPickSource(hit: SectionPickCandidate): SectionPlaneSource | null {
  if (hit.layer === FACE_LAYER_NAME) return { kind: 'query', query: hit.entityKey }
  if (hit.layer === PLANE_LAYER_NAME) {
    const name = hit.entityKey.replace(/^@/, '')
    const builtin = BUILTIN_PLANE_QUERIES[name]
    if (builtin) return { kind: 'builtin', id: builtin }
    // A user-defined plane's selection id is `@<featureId>`; the solve result
    // is keyed by the bare feature id.
    return { kind: 'query', query: name }
  }
  return null
}
