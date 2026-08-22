import type { PartFeature } from '@/types/cad'
import { parseQuery } from '@/utils/query'

export function extractFeatureId(ancestorId: string): string | null {
  // Special tokens (@u|<uuid>, @cls_* classifiers, @gd*| descriptors, @g*_
  // geom-hash refs) are geometry identity, never feature refs: they must fall
  // through to the raw query string.
  if (
    ancestorId.startsWith("@u|") ||
    ancestorId.startsWith("@cls_") ||
    ancestorId.startsWith("@gdf|") ||
    ancestorId.startsWith("@gde|") ||
    ancestorId.startsWith("@gdv|") ||
    ancestorId.startsWith("@gface_") ||
    ancestorId.startsWith("@gedge_") ||
    ancestorId.startsWith("@gvertex_") ||
    ancestorId.startsWith("@gnormal_")
  ) {
    return null
  }

  // The candidate id lives in the segment before the first "/" for the current
  // slash-joined wire tokens (@body_ex1/face0, @extrude1/face/3).
  const slash = ancestorId.indexOf("/")
  const head = slash >= 0 ? ancestorId.slice(0, slash) : ancestorId

  // Legacy concatenated token "@<featureId>face0" glues the entity suffix to
  // the id, so the lazy regex yields the shortest id prefix. Feature ids are
  // randomId(18) base64url, which mints "-" and "_", so the id class must be
  // [-\w]: a \w-only class makes real ids like @body_ab-1/face0 fall through.
  const m = head.match(/^@([-\w]+?)(face\d+|edge\d+|vertex\d+)?$/)
  if (!m) return null
  let id = m[1]

  // Body tags are "body_<featureId>": the owning feature is the suffix.
  // Derived bodies (array/mirror/split siblings) mint "body_<feat>_<N>", so a
  // trailing numbered suffix belongs to the body scheme, not the feature id.
  if (id.startsWith("body_")) {
    id = id.slice("body_".length)
    id = id.replace(/_\d+$/, "")
  }
  return id.length ? id : null
}

function entityTypeFromRestriction(typeRestriction: string | null): string {
  if (!typeRestriction) return 'Entity'
  if (typeRestriction === 'flatface' || typeRestriction === 'cylinderface') return 'Face'
  if (typeRestriction === 'straightedge' || typeRestriction === 'edge') return 'Edge'
  if (typeRestriction === 'vertex') return 'Vertex'
  return 'Entity'
}

export function queryLabel(
  query: string,
  features: PartFeature[],
  partLabels?: Record<string, string>,
): string {
  if (!query || query === 'None') return 'None'

  if (query === '@builtin_plane_front') return 'Front'
  if (query === '@builtin_plane_top') return 'Top'
  if (query === '@builtin_plane_right') return 'Right'
  if (query === '@builtin_origin') return 'Origin'

  try {
    const parsed = parseQuery(query)

    switch (parsed.kind) {
      case 'absolute': {
        if (partLabels) {
          if (partLabels[parsed.featureId]) return partLabels[parsed.featureId]!
          if (partLabels[query]) return partLabels[query]!
        }

        const feature = features.find(f => f.id === parsed.featureId)
        if (feature) return feature.label || feature.id

        return parsed.featureId
      }

      case 'ancestry': {
        // Scan from the closest (last-in-chain) ancestor id backward toward the
        // root, since a trailing special token (classifier/geom-hash/uuid/
        // descriptor -- see extractFeatureId) resolves to null even when an
        // earlier id in the same chain names the owning feature.
        let featureId: string | null = null
        for (let i = parsed.ancestorIds.length - 1; i >= 0; i--) {
          featureId = extractFeatureId(parsed.ancestorIds[i])
          if (featureId) break
        }
        const entityType = entityTypeFromRestriction(parsed.typeRestriction)

        if (featureId) {
          const feature = features.find(f => f.id === featureId)
          if (feature) return `${entityType} of ${feature.label || feature.id}`
          return `${entityType} of ${featureId}`
        }

        return query
      }

      case 'local': {
        return parsed.eid
      }
    }
  } catch {
    return query
  }
}
