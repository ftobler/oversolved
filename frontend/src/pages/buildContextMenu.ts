import type { PartFeature } from '@/types/cad'
import type { ContextMenuItem } from '@/components/dialogs/RightClickMenu'
import { builtinSelectionId } from '@/components/Geometry3D/utils'

import contextRebuildIcon from '@/assets/icons/context-rebuild.svg'
import contextHideIcon from '@/assets/icons/context-hide.svg'
import contextEditIcon from '@/assets/icons/context-edit.svg'
import contextExitIcon from '@/assets/icons/context-exit.svg'
import contextCameraIcon from '@/assets/icons/context-camera.svg'
import contextDeleteIcon from '@/assets/icons/context-delete.svg'
import contextColorIcon from '@/assets/icons/context-color.svg'
import iconRenameIcon from '@/assets/icons/rename.svg'
import featureExportIcon from '@/assets/icons/icon-download.svg'
import constraintTileIcon from '@/assets/icons/constraint-coincident.svg'
import featureSketchIcon from '@/assets/icons/feature-sketch.svg'

// The query a sketch stores to reference a plane. Built-in planes carry a fixed
// query id that differs from their feature id ('Front' -> '@builtin_plane_front').
function planeQuery(featureId: string, builtInIds: Set<string>): string {
  return builtInIds.has(featureId) ? builtinSelectionId(featureId) : `@${featureId}`
}

export function findPlaneByQuery(
  query: string,
  features: PartFeature[],
  builtInIds: Set<string>,
): PartFeature | undefined {
  return features.find(f => f.kind === 'plane' && planeQuery(f.id, builtInIds) === query)
}

// A rename gesture only names its subject here. Collecting the new label is the
// owner's job, so this module stays free of both DOM and dialog state.
export interface RenameTarget {
  kind: 'feature' | 'body'
  id: string
  currentName: string
}

export interface FaceFrame {
  normal: [number, number, number]
  center: [number, number, number]
}

// What the normal selection lets "Normal to" aim at, resolved by the caller
// (resolveSelectionNormalTarget) so this module never reads the store or the
// body registry. A plane is named by feature id for the same reason
// normalToPlaneItem is. A face carries its selection query for New Sketch.
export type NormalTarget =
  | { kind: 'plane'; featureId: string }
  | ({ kind: 'face'; query: string } & FaceFrame)

// The surface the New Sketch and Normal to items act on, resolved once from the
// tree target, the viewport hover, then the selection. `query` is what a sketch
// stores as its plane, the same string the plane pick field stores when that
// surface is picked there; a plane derives it from its feature id while a face
// carries the hovered/picked id unchanged.
type SurfaceTarget =
  | { kind: 'plane'; featureId: string; query: string }
  | ({ kind: 'face'; query: string } & FaceFrame)

export interface BuildContextMenuInput {
  pos: [number, number]
  targetId: string | undefined
  hoveredSelectionId: string | null
  hoveredFaceNormal: [number, number, number] | null
  hoveredFaceCenter: [number, number, number] | null
  // Null unless the selection is exactly one plane or one planar face.
  selectedNormalTarget: NormalTarget | null
  features: PartFeature[]
  visibleFeatures: Set<string>
  activeSketchFeatureId: string | undefined
  showConstraintTiles: boolean
  partLabels: Record<string, string>
  builtInIds: Set<string>
  // Whether the last solve flagged any dangling projections or superfluous
  // constraints; gates the cleanup item so an empty command is never offered.
  hasDanglingContent: boolean
}

export interface BuildContextMenuCallbacks {
  onRebuild: () => void
  onRemoveDanglingContent: () => void
  onToggleVisibility: (featureId: string) => void
  onToggleSuppression: (featureId: string, suppressed: boolean) => void
  onEnterEditSketch: (featureId: string) => void
  onExitSketch: () => void
  onDeleteFeature: (featureId: string) => void
  onRequestRename: (target: RenameTarget) => void
  onAlignToFace: (normal: [number, number, number], center: [number, number, number]) => void
  onNormalToPlane: (featureId: string) => void
  onAlignCameraToSketchPlane: () => void
  onToggleConstraintTiles: () => void
  onSetPartColorPopover: (opts: { bodyId: string; position: [number, number] } | null) => void
  onExportBody: (bodyId: string, name: string) => void
  onNewSketchOnPlane: (planeQuery: string) => void
  onShowContextMenu: (items: ContextMenuItem[], targetId?: string) => void
}

export interface BuildContextMenuOutput {
  items: ContextMenuItem[]
}

// The viewport/feature menu is a fixed board: every command keeps its slot and
// an unusable one is disabled rather than dropped, so the menu never shifts or
// changes length under the pointer. A body keeps its own three-item menu.
export function buildContextMenu(
  input: BuildContextMenuInput,
  callbacks: BuildContextMenuCallbacks,
): BuildContextMenuOutput {
  const {
    pos,
    targetId,
    hoveredSelectionId,
    hoveredFaceNormal,
    hoveredFaceCenter,
    selectedNormalTarget,
    features,
    visibleFeatures,
    activeSketchFeatureId,
    showConstraintTiles,
    partLabels,
    builtInIds,
    hasDanglingContent,
  } = input

  if (targetId?.startsWith('body:')) {
    const bodyId = targetId.slice('body:'.length)
    return {
      items: [
        {
          label: 'Rename',
          icon: iconRenameIcon,
          onClick: () => callbacks.onRequestRename({
            kind: 'body',
            id: bodyId,
            currentName: partLabels[bodyId] || bodyId,
          }),
        },
        {
          label: 'Color',
          icon: contextColorIcon,
          onClick: () => callbacks.onSetPartColorPopover({ bodyId, position: pos }),
        },
        {
          label: 'Export',
          icon: featureExportIcon,
          onClick: () => callbacks.onExportBody(bodyId, partLabels[bodyId] || bodyId),
        },
      ],
    }
  }

  // Creating a sketch enters its edit session, which cannot nest inside the
  // one an active sketch already holds. Exit first.
  const canStartSketch = !activeSketchFeatureId

  const featureId = targetId
  const target = featureId ? features.find(f => f.id === featureId) : undefined

  // Only a viewport right-click has no targetId. The feature tree always names
  // its target, and must not be hijacked by whatever the pointer last hovered
  // in the viewport (hover is not cleared when the pointer leaves the canvas).
  const hoveredInViewport = targetId ? null : hoveredSelectionId

  // A tree plane wins, then a plane hovered in the viewport, then a flat face
  // hovered there (a plane carries no face frame, a curved face carries none
  // either, so each drops out of the other's branch). Only a bare viewport
  // right-click falls back to the selection, and only outside a sketch edit,
  // where the edited sketch's own plane is the view already offered.
  let surfaceTarget: SurfaceTarget | null = null
  if (target?.kind === 'plane') {
    surfaceTarget = {
      kind: 'plane',
      featureId: target.id,
      query: planeQuery(target.id, builtInIds),
    }
  } else if (hoveredInViewport) {
    const hoveredPlane = findPlaneByQuery(hoveredInViewport, features, builtInIds)
    if (hoveredPlane) {
      surfaceTarget = {
        kind: 'plane',
        featureId: hoveredPlane.id,
        query: planeQuery(hoveredPlane.id, builtInIds),
      }
    } else if (hoveredFaceNormal && hoveredFaceCenter) {
      surfaceTarget = {
        kind: 'face',
        query: hoveredInViewport,
        normal: hoveredFaceNormal,
        center: hoveredFaceCenter,
      }
    }
  } else if (!targetId && !activeSketchFeatureId && selectedNormalTarget) {
    surfaceTarget = selectedNormalTarget.kind === 'plane'
      ? {
          kind: 'plane',
          featureId: selectedNormalTarget.featureId,
          query: planeQuery(selectedNormalTarget.featureId, builtInIds),
        }
      : {
          kind: 'face',
          query: selectedNormalTarget.query,
          normal: selectedNormalTarget.normal,
          center: selectedNormalTarget.center,
        }
  }

  const canNewSketch = canStartSketch && surfaceTarget !== null
  const canNormalTo = surfaceTarget !== null
  // Cleanup is explicit and undoable: the solve path no longer writes the
  // flagged content out of the doc, so this command is the only way to remove
  // it, and undo restores it without a re-solve re-deleting. Only offered
  // outside a sketch edit, where the solve cannot remove what is being edited.
  const canRemoveDangling = hasDanglingContent && !activeSketchFeatureId
  // A rename/Edit gesture names a tree feature. A built-in has no author to edit
  // and no place in the doc to rename or delete, so it is left out.
  const canEdit = !!featureId && !!target && !builtInIds.has(featureId)
    && (target.kind === 'plane' || target.kind === 'sketch')
  const canExitSketch = !!activeSketchFeatureId
  // The tree row of the edited sketch and a bare viewport right-click both
  // mean "this sketch"; a tree click on any other feature does not.
  const canNormalToSketch = !!activeSketchFeatureId
    && (!featureId || featureId === activeSketchFeatureId)
  // Hide/Show only ever touches a plane or a sketch, the two overlays the tree
  // draws. A tree target wins when it is one of those and is not the sketch
  // already under edit; otherwise the edited sketch is the thing on screen to
  // hide or show. With neither, the slot is greyed.
  const targetIsHideable = !!featureId && featureId !== activeSketchFeatureId
    && !!target && !builtInIds.has(featureId)
    && (target.kind === 'plane' || target.kind === 'sketch')
  const visibilityFeature = targetIsHideable
    ? target
    : activeSketchFeatureId
      ? features.find(f => f.id === activeSketchFeatureId)
      : undefined
  const canToggleVisibility = !!visibilityFeature
  const visibilityIsOn = !!visibilityFeature && visibleFeatures.has(visibilityFeature.id)
  const canToggleConstraints = !!activeSketchFeatureId
  // The sketch under edit keeps its commands: renaming it would fight the open
  // session and deleting it would pull the sketch out from under the edit.
  const canManageFeature = !!featureId && !builtInIds.has(featureId)
    && featureId !== activeSketchFeatureId

  const items: ContextMenuItem[] = [
    {
      label: 'New Sketch',
      icon: featureSketchIcon,
      disabled: !canNewSketch,
      onClick: () => {
        if (canNewSketch && surfaceTarget) callbacks.onNewSketchOnPlane(surfaceTarget.query)
      },
    },
    {
      label: 'Normal to',
      icon: contextCameraIcon,
      disabled: !canNormalTo,
      onClick: () => {
        if (!canNormalTo || !surfaceTarget) return
        if (surfaceTarget.kind === 'plane') callbacks.onNormalToPlane(surfaceTarget.featureId)
        else callbacks.onAlignToFace(surfaceTarget.normal, surfaceTarget.center)
      },
    },
    {
      label: 'Rebuild',
      icon: contextRebuildIcon,
      onClick: callbacks.onRebuild,
    },
    {
      label: 'Remove dangling projections / superfluous constraints',
      icon: contextRebuildIcon,
      disabled: !canRemoveDangling,
      onClick: () => {
        if (canRemoveDangling) callbacks.onRemoveDanglingContent()
      },
    },
    {
      label: 'Edit',
      icon: contextEditIcon,
      disabled: !canEdit,
      onClick: () => {
        if (canEdit && featureId) callbacks.onEnterEditSketch(featureId)
      },
    },
    {
      label: 'Exit Sketch',
      icon: contextExitIcon,
      disabled: !canExitSketch,
      onClick: () => {
        if (canExitSketch) callbacks.onExitSketch()
      },
    },
    {
      label: 'Normal to sketch',
      icon: contextCameraIcon,
      disabled: !canNormalToSketch,
      onClick: () => {
        if (canNormalToSketch) callbacks.onAlignCameraToSketchPlane()
      },
    },
    {
      label: visibilityIsOn ? 'Hide' : 'Show',
      icon: contextHideIcon,
      disabled: !canToggleVisibility,
      onClick: () => {
        if (canToggleVisibility && visibilityFeature) callbacks.onToggleVisibility(visibilityFeature.id)
      },
    },
    {
      label: showConstraintTiles ? 'Hide Constraints' : 'Show Constraints',
      icon: constraintTileIcon,
      disabled: !canToggleConstraints,
      onClick: () => {
        if (canToggleConstraints) callbacks.onToggleConstraintTiles()
      },
    },
    {
      label: target?.suppressed ? 'Unsuppress' : 'Suppress',
      icon: contextHideIcon,
      disabled: !canManageFeature,
      onClick: () => {
        if (canManageFeature && featureId) callbacks.onToggleSuppression(featureId, !target?.suppressed)
      },
    },
    {
      label: 'Rename',
      icon: iconRenameIcon,
      disabled: !canManageFeature,
      onClick: () => {
        if (!canManageFeature || !featureId) return
        callbacks.onRequestRename({
          kind: 'feature',
          id: featureId,
          currentName: target?.label || featureId,
        })
      },
    },
    {
      label: 'Delete',
      icon: contextDeleteIcon,
      className: 'right-click-menu-item--delete',
      disabled: !canManageFeature,
      onClick: () => {
        if (canManageFeature && featureId) callbacks.onDeleteFeature(featureId)
      },
    },
  ]

  return { items }
}
