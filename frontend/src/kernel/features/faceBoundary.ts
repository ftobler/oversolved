// The real-kernel half of face projection membership: which edges bound a face
// this solve. The sketch leaf has no OCC module and the body store carries no
// render mesh, so the builder injects this lookup into the sketch solve; the
// returned data is plain strings, keeping the solve itself blind to OCC.

import type { OccModule } from '@/kernel/occ/occTypes'
import type { HandleTable } from '@/kernel/occ/handleTable'
import type { Body } from '@/kernel/types3d'
import type { Repository } from '@/kernel/query'
import { solidToEdges, solidToFaceEdgeQueries } from '@/kernel/occ/tessellation'
import { newIndexSets } from '@/kernel/occ/modifierAttribution'
import { edgeUuidToken, type FaceBoundary, type FaceBoundaryEdge } from './projectionMembers'

/** Resolve a face query to its current boundary edges, or null when the face
 *  (or its body) does not resolve this solve. */
export type FaceBoundaryLookup = (source: string) => FaceBoundary | null

interface BodyBoundary {
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
  bodyStore: Record<string, Body>,
  repo: Repository,
): FaceBoundaryLookup {
  const cache = new Map<string, BodyBoundary | null>()

  const boundaryOf = (body: Body): BodyBoundary | null => {
    if (body.shape === null) return null
    const edges = solidToEdges(oc, table, body.shape, {
      createdBy: body.created_by || '',
      bodyId: body.id,
      profileQueries: body.profile_queries ?? [],
      edgeAncestry: body.edge_ancestry ?? null,
      edgeUuids: body.edge_uuids ?? null,
      edgeOwner: body.edge_owner ?? null,
      newElements: newIndexSets(body.brep_new, body.shape),
      modifiedBy: body.modified_by ?? [],
    })
    const faceData = solidToFaceEdgeQueries(oc, table, body.shape, edges.edge_queries)
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
    let bodyId: string | null = null
    let faceIndex = -1
    try {
      const resolved = repo.query(source, null) as { body_id?: unknown; face_index?: unknown } | null
      if (resolved && typeof resolved.body_id === 'string') bodyId = resolved.body_id
      if (resolved && typeof resolved.face_index === 'number') faceIndex = resolved.face_index
    } catch {
      // A malformed or ambiguous query still gets the body scan below; the
      // caller reports the miss as an unresolved projection.
    }
    const body = bodyId !== null
      ? bodyStore[bodyId]
      : Object.values(bodyStore).find((candidate) => candidate.face_uuids?.includes(token.slice(2)) === true)
    if (!body) return null
    let data = cache.get(body.id)
    if (data === undefined) {
      try {
        data = boundaryOf(body)
      } catch {
        data = null
      }
      cache.set(body.id, data)
    }
    if (data === null) return null
    if (faceIndex < 0) {
      const uuid = token.slice(2)
      faceIndex = body.face_uuids?.indexOf(uuid) ?? -1
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
