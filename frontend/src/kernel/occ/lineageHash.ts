// Copy-stable geometry-hash keys for OCC faces and edges (per lineage-stable-keying.md).
// Lineage maps key on geometry, not the copy-fragile OCC subshape hash, so tokens survive the
// shape copies the build pipeline does. Shared by the lineage adapters (prismLineage,
// edgeModifier, booleanLineage) that all derived the same two helpers.

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'
import { faceCentroid, faceNormal, edgeToGeom } from './primitives'
import { faceGeometryHash, edgeGeometryHash } from '../geomHash'

/** Geometry-hash key for an OCC face. */
export function faceGh(oc: OccModule, scope: DisposeScope, face: OccShape): string {
  return faceGeometryHash(faceCentroid(oc, scope, face), faceNormal(oc, scope, face))
}

/** Geometry-hash key for an OCC edge (mirrors `_occ_edge_geom_hash`); null on failure. */
export function edgeGh(oc: OccModule, scope: DisposeScope, edge: OccShape): string | null {
  try {
    const { ed } = edgeToGeom(oc, scope, edge)
    return edgeGeometryHash(ed as unknown as Record<string, unknown>)
  } catch {
    return null
  }
}
