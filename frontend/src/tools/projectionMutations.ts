// PURE LOGIC -- no Three.js, no React, no store reads.
// Lowers a pickable ID (body face/edge/vertex query, or a foreign sketch
// entity) into the `add_projected_entity` mutations that pull it onto the
// active sketch plane. Shared by the project tool's click path (drawLogic) and
// by the pre-selection path, so both agree on kind resolution and face-wire
// expansion.
import type { Mutation } from '@/types/cad'
import { parseQuery } from '@/utils/query'
import { projectedKindForEdge } from '@/tools/dimensionProjection'

/** Everything the pure lowering needs from the outside world, injected so the
 *  click path can answer from hover state and the selection path from the
 *  body/sketch registries. */
export interface ProjectionResolvers {
  // Geometric kind of a sketch entity, or null when it cannot be resolved.
  entityKind: (featureId: string, entityId: string) => string | null
  // Curve kind ('line'|'circle'|'arc'|'spline') of a body edge query.
  edgeKind: (query: string) => string | null
  // Projection sources of a body face query's boundary edges.
  faceEdges: (query: string) => { source: string; kind: string }[] | null
}

// The base entity kinds a projected curve can take. Anything else (an unknown
// or unresolved source) degrades to a line, which every downstream consumer
// can render.
const PROJECTABLE_KINDS = ['arc', 'circle', 'ellipse', 'spline', 'point']

/**
 * Mutations that project one pickable id onto `featureId`'s sketch plane.
 * Empty when the id is not projectable: an unknown id form, or an entity of the
 * active sketch itself (a sketch cannot project onto its own plane).
 */
export function projectionMutationsForId(
  id: string,
  featureId: string,
  resolvers: ProjectionResolvers,
): Mutation[] {
  // Sketch entity pick: entity:<featureId>:<entityId>
  if (id.startsWith('entity:')) {
    const parts = id.split(':')
    if (parts.length < 3) return []
    const sourceFeatureId = parts[1]
    const sourceEntityId = parts[2]
    if (sourceFeatureId === featureId) return []

    const source = `@${sourceFeatureId}/${sourceEntityId}`
    // Projection is carried by `source`, not by a distinct entity kind: emit
    // the base geometric kind of the source curve plus the source query.
    const ek = resolvers.entityKind(sourceFeatureId, sourceEntityId)
    const kind = ek && PROJECTABLE_KINDS.includes(ek) ? ek : 'line'
    return [{ type: 'add_projected_entity', featureId, kind, source }]
  }

  // Body geometry pick: ancestry query from face/edge/vertex layer
  if (id.startsWith('?')) {
    let kind = 'point'
    let isFace = false
    try {
      const q = parseQuery(id)
      if (q.kind === 'ancestry' && q.typeRestriction) {
        const tr = q.typeRestriction
        if (tr === 'edge' || tr === 'straightedge') {
          // The query alone can't tell a line from a circle/arc; the source
          // edge's curve kind (when known) selects the base entity kind.
          kind = projectedKindForEdge(resolvers.edgeKind(id))
        } else if (tr === 'face' || tr === 'flatface' || tr === 'cylinderface') {
          isFace = true
        }
      }
    } catch {  /* parse failure: keep default point */ }

    // A face pick projects its whole boundary as a closed wire: one projected
    // entity per boundary edge. Without resolved boundary edges (older body or
    // no topology) fall back to projecting the face centroid as a point.
    if (isFace) {
      const faceEdges = resolvers.faceEdges(id)
      if (faceEdges && faceEdges.length > 0) {
        return faceEdges.map(e => ({
          type: 'add_projected_entity', featureId, kind: e.kind, source: e.source,
        }))
      }
    }

    return [{ type: 'add_projected_entity', featureId, kind, source: id }]
  }

  return []
}

/** Mutations that project every projectable id of a selection, in selection
 *  order. Non-projectable ids (constraints, own entities, planes) are skipped
 *  silently so a mixed selection still projects what it can. */
export function projectionMutationsForSelection(
  ids: Iterable<string>,
  featureId: string,
  resolvers: ProjectionResolvers,
): Mutation[] {
  const mutations: Mutation[] = []
  for (const id of ids) mutations.push(...projectionMutationsForId(id, featureId, resolvers))
  return mutations
}
