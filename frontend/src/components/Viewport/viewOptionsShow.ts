// Which document features each Show group owns, and whether the group reads as
// shown. The dropdown's check state has to come from the same derivation the
// viewport draws from (docVisibleFeatureIds), not from the raw `visible` flag:
// a sketch consumed by a body is auto-hidden and must read as hidden here too.
import type { PartFeature } from '@/types/cad'

export type ShowGroup = 'planes' | 'sketches' | 'origin'

export const SHOW_GROUPS: readonly ShowGroup[] = ['planes', 'sketches', 'origin']

const BUILTIN_PLANE_IDS: ReadonlySet<string> = new Set(['Top', 'Front', 'Right'])

/**
 * The ids a group toggles. Planes mirrors `applyTogglePlaneVisibility` (every
 * plane plus the three built-in planes, never the origin marker); sketches is
 * every sketch; origin is the marker alone.
 */
export function showGroupIds(features: readonly PartFeature[], group: ShowGroup): string[] {
  switch (group) {
    case 'planes':
      return features.filter(f => f.id !== 'Origin' && (f.kind === 'plane' || BUILTIN_PLANE_IDS.has(f.id))).map(f => f.id)
    case 'sketches':
      return features.filter(f => f.kind === 'sketch').map(f => f.id)
    case 'origin':
      return features.filter(f => f.id === 'Origin').map(f => f.id)
  }
}

export interface ShowGroupState {
  // Every member is drawn right now.
  visible: boolean
  // No member exists, so the row has nothing to toggle.
  disabled: boolean
}

export function showGroupState(
  features: readonly PartFeature[],
  visibleIds: ReadonlySet<string>,
  group: ShowGroup,
): ShowGroupState {
  const ids = showGroupIds(features, group)
  return {
    visible: ids.length > 0 && ids.every(id => visibleIds.has(id)),
    disabled: ids.length === 0,
  }
}

export function showGroupStates(
  features: readonly PartFeature[],
  visibleIds: ReadonlySet<string>,
): Record<ShowGroup, ShowGroupState> {
  return {
    planes: showGroupState(features, visibleIds, 'planes'),
    sketches: showGroupState(features, visibleIds, 'sketches'),
    origin: showGroupState(features, visibleIds, 'origin'),
  }
}
