// The real-kernel half of face projection membership: which edges bound a face
// this solve. The sketch leaf has no OCC module and the body store carries no
// render mesh, so the builder injects this lookup into the sketch solve; the
// returned data is plain strings, keeping the solve itself blind to OCC.

import type { OccModule } from '@/kernel/occ/occTypes'
import type { HandleTable } from '@/kernel/occ/handleTable'
import type { PartSolid } from '@/kernel/types3d'
import type { Repository } from '@/kernel/query'
import { solidToEdges, solidToFaceEdgeQueries } from '@/kernel/occ/tessellation'
import { newIndexSets } from '@/kernel/occ/modifierAttribution'
import { edgeUuidToken, type FaceBoundary, type FaceBoundaryEdge } from './projectionMembers'

/** Resolve a face query to its current boundary edges, or null when the face
 *  (or its body) does not resolve this solve. */
export type FaceBoundaryLookup = (source: string) => FaceBoundary | null

interface PartBoundary {
  // Boundary queries per mesh face index, aligned with `faceQueries`.
  faceQueries: string[][]
  seams: string[][]
  kindByQuery: Map<string, string>
}

/**
 * Build the lookup for one solve. Each body's boundary walk is cached for the
 * duration of the build: a sketch with several face projections, or a later
 * feature asking for the same body, pays for it once. The walk reads the same
 * `solidToEdges`/`solidToFaceEdgeQueries` path the render mesh does, so a member
 * query is exactly the query a direct edge pick would carry.
 */
export function faceBoundaryLookup(
  oc: OccModule,
  table: HandleTable,
  partStore: Record<string, PartSolid>,
  repo: Repository,
): FaceBoundaryLookup {
  const cache = new Map<string, PartBoundary | null>()

  const boundaryOf = (part: PartSolid): PartBoundary | null => {
    if (part.shape === null) return null
    const edges = solidToEdges(oc, table, part.shape, {
      createdBy: part.created_by || '',
      partId: part.id,
      profileQueries: part.profile_queries ?? [],
      edgeAncestry: part.edge_ancestry ?? null,
      edgeUuids: part.edge_uuids ?? null,
      edgeOwner: part.edge_owner ?? null,
      newElements: newIndexSets(part.brep_new, part.shape),
      modifiedBy: part.modified_by ?? [],
    })
    const faceData = solidToFaceEdgeQueries(oc, table, part.shape, edges.edge_queries)
    const kindByQuery = new Map<string, string>()
    edges.edge_queries.forEach((query, index) => {
      if (query !== '') kindByQuery.set(query, edges.edges[index]?.kind ?? 'line')
    })
    return {
      faceQueries: faceData.face_edge_queries,
      seams: faceData.face_seam_queries,
      kindByQuery,
    }
  }

  return (source: string): FaceBoundary | null => {
    const token = edgeUuidToken(source)
    if (token === null) return null
    let partId: string | null = null
    let faceIndex = -1
    try {
      const resolved = repo.query(source, null) as { body_id?: unknown; face_index?: unknown } | null
      if (resolved && typeof resolved.body_id === 'string') partId = resolved.body_id
      if (resolved && typeof resolved.face_index === 'number') faceIndex = resolved.face_index
    } catch {
      // A malformed or ambiguous query still gets the body scan below; the
      // caller reports the miss as an unresolved projection.
    }
    const part = partId !== null
      ? partStore[partId]
      : Object.values(partStore).find((candidate) => candidate.face_uuids?.includes(token.slice(2)) === true)
    if (!part) return null
    let data = cache.get(part.id)
    if (data === undefined) {
      try {
        data = boundaryOf(part)
      } catch {
        data = null
      }
      cache.set(part.id, data)
    }
    if (data === null) return null
    if (faceIndex < 0) {
      const uuid = token.slice(2)
      faceIndex = part.face_uuids?.indexOf(uuid) ?? -1
    }
    if (faceIndex < 0 || faceIndex >= data.faceQueries.length) return null
    const seams = data.seams[faceIndex] ?? []
    const seamSet = new Set(seams)
    const edges: FaceBoundaryEdge[] = []
    for (const query of data.faceQueries[faceIndex] ?? []) {
      if (seamSet.has(query)) continue
      const edgeToken = edgeUuidToken(query)
      if (edgeToken === null) continue
      edges.push({ token: edgeToken, query, kind: data.kindByQuery.get(query) ?? 'line' })
    }
    return { edges, seams }
  }
}
