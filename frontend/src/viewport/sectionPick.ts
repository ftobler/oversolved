// Translating one normal selection pick into a section plane source. Kept out
// of the dispatcher so the "which picks may name a section plane" rule is
// testable without a canvas or an ID buffer.
import { FACE_LAYER_NAME, PLANE_LAYER_NAME } from '@/picking/layerNames'
import type { SectionPlaneSource } from '@/viewport/sectionPlane'

export interface SectionPickCandidate {
  layer: string
  entityKey: string
}

/**
 * A B-rep face or a reference/user plane names a section plane; every other
 * pickable (an edge, a vertex, sketch geometry, a handle) does not.
 */
export function sectionPickSource(hit: SectionPickCandidate): SectionPlaneSource | null {
  if (hit.layer === FACE_LAYER_NAME || hit.layer === PLANE_LAYER_NAME) {
    return { kind: 'query', query: hit.entityKey }
  }
  return null
}
