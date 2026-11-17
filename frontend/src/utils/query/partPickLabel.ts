import type { PartFeature } from '@/types/cad'
import type { BodyResult } from '@/types/cad'
import { queryLabel } from './queryLabel'
import { partIdsOfPick } from './partIdOfPick'
import { partDisplayName } from '@/utils/core/partDisplayName'

export function partPickLabel(
  query: string,
  parts: Record<string, BodyResult> | null | undefined,
  partLabels?: Record<string, string>,
  features: PartFeature[] = [],
): string {
  const ids = partIdsOfPick(query, parts ?? {})
  if (ids.length === 1) {
    const ordered = Object.keys(parts ?? {})
    return partDisplayName(ids[0], partLabels, ordered)
  }
  if (ids.length > 1) {
    const featureId = (parts ?? {})[ids[0]]?.created_by
    const feature = featureId ? features.find((f) => f.id === featureId) : undefined
    const owner = feature ? (feature.label || feature.id) : (featureId ?? query)
    return `${owner} (all parts)`
  }
  return queryLabel(query, features, partLabels)
}
