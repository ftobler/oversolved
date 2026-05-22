import type { PartFeature } from '@/types/cad'
import type { ContextMenuItem } from '@/components/RightClickMenu'

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
}

export interface BuildContextMenuCallbacks {
  onRebuild: () => void
  onToggleVisibility: (featureId: string) => void
  onToggleSuppression: (featureId: string, suppressed: boolean) => void
  onEnterEditSketch: (featureId: string) => void
  onExitSketch: () => void
  onDeleteFeature: (featureId: string) => void
  onFeatureRename: (featureId: string, label: string) => void
  onBodyRename: (bodyId: string, label: string) => void
  onAlignToFace: (normal: [number, number, number], center: [number, number, number]) => void
  onAlignCameraToSketchPlane: () => void
  onToggleConstraintTiles: () => void
  onSetPartColorPopover: (opts: { bodyId: string; position: [number, number] } | null) => void
  onExportBody: (bodyId: string, name: string) => void
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
  } = input

  if (hoveredSelectionId && hoveredFaceNormal && hoveredFaceCenter) {
    return {
      items: [
        {
          label: 'Align to Face',
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
          onClick: () => {
            const newLabel = window.prompt('Enter new name:', partLabels[bodyId] || bodyId)
            if (newLabel && newLabel.trim()) {
              callbacks.onBodyRename(bodyId, newLabel)
            }
          },
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
        onClick: () => {
          const newLabel = window.prompt('Enter new name:', target?.label || target?.id)
          if (newLabel && newLabel.trim()) {
            callbacks.onFeatureRename(featureId, newLabel.trim())
          }
        },
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
