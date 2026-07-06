// _build_face_query, _face_tokens, _edge_lineage_tokens). These bridge the geom-hash identity
// (shard 1) and the ancestry query format (shard 2) at the tessellation boundary; phase 2b left
// face_data carrying geometry only and deferred this wiring to 2c.

import { faceGeometryHash, edgeGeometryHash } from "./geomHash"
import { emitFaceDescriptor } from "./geomDescriptor"
import { ref, makeAncestryQuery } from "./query"

/** Ancestry query string for a face, or null if createdBy is absent. */
export function buildFaceQuery(
  createdBy: string | null | undefined,
  bodyId: string | null | undefined,
  faceIdx: number,
  centroid: number[],
  normal: number[],
  surfaceType: string,
  profileQueries: string[] | null = null,
  faceTokens: string[] | null = null,
  classifiers: string[] | null = null,
): string | null {
  if (!createdBy) return null
  if (bodyId) {
    // The descriptor token replaces the old gface_/gnormal_ digest pair: it
    // carries centroid+normal in the clear, so the resolver can match with
    // tolerance when the centroid drifts instead of going stale (see
    // geomDescriptor.ts). Digests remain the lineage-map keys only.
    const ids = [emitFaceDescriptor(centroid, normal), ref(createdBy), ref(bodyId)]
    if (faceTokens && faceTokens.length) ids.push(...faceTokens)
    else if (profileQueries && profileQueries.length) ids.push(...profileQueries)
    // Classifier tokens (spatial role) ride the id list; the resolver
    // partitions them into a separate tier above the geom hash.
    if (classifiers && classifiers.length) ids.push(...classifiers.map(ref))
    return makeAncestryQuery(ids, surfaceType)
  }
  const elementId = `face${faceIdx}`
  const absId = ref(createdBy) + "/" + elementId
  return makeAncestryQuery([absId, ref(createdBy)], surfaceType)
}

/** Per-face entity tokens from the lineage map, keyed on the copy-stable hash. */
export function faceTokens(
  centroid: number[],
  normal: number[],
  faceLineage: Record<string, string[]> | null,
): string[] {
  if (faceLineage === null || faceLineage === undefined) return []
  return faceLineage[faceGeometryHash(centroid, normal)] ?? []
}

/** Per-edge entity tokens from the lineage map, mirroring faceTokens. */
export function edgeLineageTokens(
  ed: Record<string, unknown>,
  edgeLineage: Record<string, string[]> | null,
): string[] {
  if (edgeLineage === null || edgeLineage === undefined) return []
  let key: string
  try {
    key = edgeGeometryHash(ed)
  } catch {
    return []
  }
  return edgeLineage[key] ?? []
}
