import type { PartFeature } from '@/types/cad'
import { parseQuery } from '@/utils/query'

function extractFeatureId(ancestorId: string): string | null {
  const m = ancestorId.match(/^@(\w+?)(face\d+|edge\d+|vertex\d+)?$/)
  return m ? m[1] : null
}

function entityTypeFromRestriction(typeRestriction: string | undefined): string {
  if (!typeRestriction) return 'Entity'
  if (typeRestriction === 'flatface' || typeRestriction === 'cylinderface') return 'Face'
  if (typeRestriction === 'straightedge' || typeRestriction === 'edge') return 'Edge'
  if (typeRestriction === 'vertex') return 'Vertex'
  return 'Entity'
}

function findFeature(featureId: string, features: PartFeature[]): PartFeature | undefined {
  return features.find(f => f.id === featureId)
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

  try {
    const parsed = parseQuery(query)

    switch (parsed.kind) {
      case 'absolute': {
        if (partLabels) {
          if (partLabels[parsed.featureId]) return partLabels[parsed.featureId]!
          if (partLabels[query]) return partLabels[query]!
        }

        const feature = findFeature(parsed.featureId, features)
        if (feature) return feature.label || feature.id

        return parsed.featureId
      }

      case 'ancestry': {
        const lastId = parsed.ids[parsed.ids.length - 1]
        const featureId = extractFeatureId(lastId)
        const entityType = entityTypeFromRestriction(parsed.typeRestriction)

        if (featureId) {
          const feature = findFeature(featureId, features)
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
