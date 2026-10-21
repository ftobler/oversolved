// Which document features each Show group owns, and whether the group reads as
// shown. The dropdown's check state has to come from the same derivation the
// viewport draws from (docVisibleFeatureIds), not from the raw `visible` flag:
// a sketch consumed by a body is auto-hidden and must read as hidden here too.
import type { PartFeature } from '@/types/cad'
import { isPlaneVisibilityTarget } from '@/utils/featureVisibility'
import { isSketchClassFeature } from '@/utils/sketchClass'

export type ShowGroup = 'planes' | 'sketches' | 'origin'

export const SHOW_GROUPS: readonly ShowGroup[] = ['planes', 'sketches', 'origin']

/**
 * The ids a group toggles. Planes uses the same `isPlaneVisibilityTarget` set
 * as the tree, the keyboard toggle and the first-sketch hide (never the origin
 * marker); sketches covers every sketch-class feature, helixes included, so the
 * row agrees with the tree eye and the `y` toggle; origin is the marker alone.
 */
export function showGroupIds(features: readonly PartFeature[], group: ShowGroup): string[] {
  switch (group) {
    case 'planes':
      return features.filter(isPlaneVisibilityTarget).map(f => f.id)
    case 'sketches':
      return features.filter(isSketchClassFeature).map(f => f.id)
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

export interface VisibilityMutation {
  type: 'set_feature_visibility'
  featureId: string
  visible: boolean
}

/**
 * The mutations a Show row commits. An unchecked row (not every member drawn)
 * shows every member; a checked row hides them all. This is deliberately not
 * the keyboard plane toggle's "any visible hides all": with one plane hidden
 * by the tree eye, that would hide the rest instead of bringing it back.
 */
export function showGroupToggleMutations(
  features: readonly PartFeature[],
  visibleIds: ReadonlySet<string>,
  group: ShowGroup,
): VisibilityMutation[] {
  const visible = !showGroupState(features, visibleIds, group).visible
  return showGroupIds(features, group).map(featureId => ({ type: 'set_feature_visibility' as const, featureId, visible }))
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
