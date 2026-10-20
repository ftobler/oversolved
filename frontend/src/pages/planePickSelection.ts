import type { PartFeature } from '@/types/cad'

export interface ActivePickFieldShape {
  featureId: string
  field: string
}

/**
 * The sketch-on-face FSM only reacts to a sketch's plane field being picked.
 * The id is looked up in the feature list, so a consumer that is not a feature
 * (the bug report's `bug-report:<setId>` pick field) never matches and leaves
 * the FSM untouched even when its field happens to be called `plane`.
 */
export function planeSelectionFeatureId(
  activePickField: ActivePickFieldShape | null,
  features: readonly PartFeature[],
): string | null {
  if (activePickField?.field !== 'plane') return null
  return features.find(f => f.id === activePickField.featureId)?.kind === 'sketch'
    ? activePickField.featureId
    : null
}
