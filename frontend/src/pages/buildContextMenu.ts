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

function findPlaneByQuery(
  query: string,
  features: PartFeature[],
  builtInIds: Set<string>,
): PartFeature | undefined {
  return features.find(f => f.kind === 'plane' && planeQuery(f.id, builtInIds) === query)
}

// Point the camera down the plane's normal. Planes are named by feature id here
// (not by query) because the caller resolves the transform from the solve result,
// which is keyed by feature id.
function normalToPlaneItem(featureId: string, callbacks: BuildContextMenuCallbacks): ContextMenuItem {
  return {
    label: 'Normal to',
    icon: contextCameraIcon,
    onClick: () => callbacks.onNormalToPlane(featureId),
  }
}

// A rename gesture only names its subject here. Collecting the new label is the
// owner's job, so this module stays free of both DOM and dialog state.
export interface RenameTarget {
  kind: 'feature' | 'body'
  id: string
  currentName: string
}

export interface BuildContextMenuInput {
  pos: [number, number]
  targetId: string | undefined
  hoveredSelectionId: string | null
  hoveredFaceNormal: [number, number, number] | null
  hoveredFaceCenter: [number, number, number] | null
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
    features,
    visibleFeatures,
    activeSketchFeatureId,
    showConstraintTiles,
    partLabels,
    builtInIds,
    hasDanglingContent,
  } = input

  // Creating a sketch enters its edit session, which cannot nest inside the
  // one an active sketch already holds. Exit first.
  const canStartSketch = !activeSketchFeatureId

  // Only a viewport right-click has no targetId. The feature tree always names
  // its target, and must not be hijacked by whatever the pointer last hovered
  // in the viewport (hover is not cleared when the pointer leaves the canvas).
  const hoveredInViewport = targetId ? null : hoveredSelectionId

  // A plane hovered in the viewport carries no face geometry, so it never
  // reaches the face branch below.
  const hoveredPlane = hoveredInViewport
    ? findPlaneByQuery(hoveredInViewport, features, builtInIds)
    : undefined
  if (hoveredPlane) {
    const items: ContextMenuItem[] = []
    if (canStartSketch) {
      items.push({
        label: 'New Sketch',
        icon: featureSketchIcon,
        onClick: () => callbacks.onNewSketchOnPlane(planeQuery(hoveredPlane.id, builtInIds)),
      })
    }
    items.push(normalToPlaneItem(hoveredPlane.id, callbacks))
    return { items }
  }

  if (hoveredInViewport && hoveredFaceNormal && hoveredFaceCenter) {
    return {
      items: [
        {
          label: 'Normal to',
          icon: contextCameraIcon,
          onClick: () => callbacks.onAlignToFace(hoveredFaceNormal, hoveredFaceCenter),
        },
      ],
    }
  }

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

  const featureId = targetId
  const items: ContextMenuItem[] = [
    {
      label: 'Rebuild',
      icon: contextRebuildIcon,
      onClick: callbacks.onRebuild,
    },
  ]
  // Cleanup is explicit and undoable: the solve path no longer writes the
  // flagged content out of the doc, so this command is the only way to remove
  // it, and undo restores it without a re-solve re-deleting. Only offered
  // outside a sketch edit, where the solve cannot remove what is being edited.
  if (hasDanglingContent && !activeSketchFeatureId) {
    items.push({
      label: 'Remove dangling projections / superfluous constraints',
      icon: contextRebuildIcon,
      onClick: callbacks.onRemoveDanglingContent,
    })
  }

  if (activeSketchFeatureId) {
    const target = features.find(f => f.id === activeSketchFeatureId)
    const isVisible = target && visibleFeatures.has(target.id)
    if (isVisible) {
      items.push({
        label: 'Hide',
        icon: contextHideIcon,
        onClick: () => callbacks.onToggleVisibility(activeSketchFeatureId),
      })
    }
    items.push({
      label: 'Edit',
      icon: contextEditIcon,
      onClick: () => callbacks.onEnterEditSketch(activeSketchFeatureId),
    })
    items.push({
      label: 'Exit Sketch',
      icon: contextExitIcon,
      onClick: callbacks.onExitSketch,
    })
    if (featureId === activeSketchFeatureId) {
      items.push({
        label: 'Align camera',
        icon: contextCameraIcon,
        onClick: callbacks.onAlignCameraToSketchPlane,
      })
    }
    items.push({
      label: showConstraintTiles ? 'Hide Constraints' : 'Show Constraints',
      icon: constraintTileIcon,
      onClick: callbacks.onToggleConstraintTiles,
    })
  }

  if (featureId && featureId !== activeSketchFeatureId) {
    const target = features.find(f => f.id === featureId)
    if (target?.kind === 'plane') {
      if (canStartSketch) {
        items.push({
          label: 'New Sketch',
          icon: featureSketchIcon,
          onClick: () => callbacks.onNewSketchOnPlane(planeQuery(target.id, builtInIds)),
        })
      }
      items.push(normalToPlaneItem(target.id, callbacks))
      if (!builtInIds.has(target.id)) {
        items.push({
          label: 'Edit',
          icon: contextEditIcon,
          onClick: () => callbacks.onEnterEditSketch(target.id),
        })
        items.push({
          label: visibleFeatures.has(target.id) ? 'Hide' : 'Show',
          icon: contextHideIcon,
          onClick: () => callbacks.onToggleVisibility(target.id),
        })
      }
    } else if (target?.kind === 'sketch') {
      if (!builtInIds.has(target.id)) {
        items.push({
          label: 'Edit',
          icon: contextEditIcon,
          onClick: () => callbacks.onEnterEditSketch(target.id),
        })
      }
      if (visibleFeatures.has(target.id)) {
        items.push({
          label: 'Hide',
          icon: contextHideIcon,
          onClick: () => callbacks.onToggleVisibility(target.id),
        })
      }
    }
    if (!builtInIds.has(featureId)) {
      const target = features.find(f => f.id === featureId)
      items.push({
        label: target?.suppressed ? 'Unsuppress' : 'Suppress',
        icon: contextHideIcon,
        onClick: () => callbacks.onToggleSuppression(featureId, !target?.suppressed),
      })
      items.push({
        label: 'Rename',
        icon: iconRenameIcon,
        onClick: () => callbacks.onRequestRename({
          kind: 'feature',
          id: featureId,
          currentName: target?.label || featureId,
        }),
      })
      items.push({
        label: 'Delete',
        icon: contextDeleteIcon,
        onClick: () => callbacks.onDeleteFeature(featureId),
        className: 'right-click-menu-item--delete',
      })
    }
  }

  return { items }
}
