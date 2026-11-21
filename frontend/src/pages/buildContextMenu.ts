import type { PartFeature } from '@/types/cad'
import type { ContextMenuItem } from '@/components/dialogs/RightClickMenu'
import { builtinSelectionId } from '@/components/Geometry3D/utils'
import { hasFeatureVisibilityToggle } from '@/components/layout/featureVisibilityKinds'
import { partDisplayName } from '@/utils/core/partDisplayName'

import contextRebuildIcon from '@/assets/icons/context-rebuild.svg'
import contextHideIcon from '@/assets/icons/context-hide.svg'
import contextExitIcon from '@/assets/icons/context-exit.svg'
import contextCameraIcon from '@/assets/icons/context-camera.svg'
import contextDeleteIcon from '@/assets/icons/context-delete.svg'
import contextColorIcon from '@/assets/icons/context-color.svg'
import iconRenameIcon from '@/assets/icons/rename.svg'
import featureExportIcon from '@/assets/icons/icon-download.svg'
import constraintTileIcon from '@/assets/icons/constraint-coincident.svg'
import constraintFixedIcon from '@/assets/icons/constraint-fixed.svg'
import constraintProjectionIcon from '@/assets/icons/constraint-projection.svg'
import featureSketchIcon from '@/assets/icons/feature-sketch.svg'
import type { FreezeProjectionMode } from '@/utils/yamlMutations/freezeProjection'

// The dangling-content cleanup's label is long on purpose: it names both things
// the one command removes, and the row is the only place either is mentioned.
const DANGLING_LABEL = 'Remove dangling projections / superfluous constraints'

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

// Whether an authored feature exposes its management verbs (Rename, Delete,
// Suppress). A built-in has no author and no place in the doc to change. The
// sketch under edit is left out on purpose: renaming or deleting it mid-session
// would fight the edit that owns it. The open editor card asks this same
// question before drawing its Rename button, so the menu and the card agree.
export function canManageFeature(
  featureId: string | undefined,
  builtInIds: Set<string>,
  activeSketchFeatureId: string | undefined,
): boolean {
  return !!featureId && !builtInIds.has(featureId) && featureId !== activeSketchFeatureId
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

// The part a body command acts on. Resolved here from the `body:` target the
// parts list names, or the `targetPartId` the page resolved from a viewport
// pick. Its label and visibility are read here so the items need no store.
interface PartTarget {
  partId: string
  currentName: string
  visible: boolean
}

export interface BuildContextMenuInput {
  pos: [number, number]
  targetId: string | undefined
  // The single part a viewport right-click resolves to, or null when the pick
  // names none or several. Ignored whenever `targetId` names a tree row: that
  // row's own Hide already covers the parts its feature made.
  targetPartId: string | null
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
  // Part ids in store order, for the `part N` fallback when a body has no
  // stored label. Absent in unit tests, where the label map supplies the order.
  orderedPartIds?: string[]
  builtInIds: Set<string>
  // Part visibility as the list reads it: undefined means nothing is hidden.
  visibleParts: Set<string> | undefined
  // Whether the last solve flagged any dangling projections or superfluous
  // constraints; gates the cleanup item so an empty command is never offered.
  hasDanglingContent: boolean
  // The selection ids of the projected entities and projection tiles the
  // right-click acts on, resolved by the caller from the picked entity/tile
  // first and then the current selection. Empty greys the freeze pair; the
  // command selects these before it runs.
  projectedTargetIds: readonly string[]
}

export interface BuildContextMenuCallbacks {
  onRebuild: () => void
  onRemoveDanglingContent: () => void
  onToggleVisibility: (featureId: string) => void
  onToggleSuppression: (featureId: string, suppressed: boolean) => void
  onExitSketch: () => void
  onDeleteFeature: (featureId: string) => void
  onRequestRename: (target: RenameTarget) => void
  onAlignToFace: (normal: [number, number, number], center: [number, number, number]) => void
  onNormalToPlane: (featureId: string) => void
  onAlignCameraToSketchPlane: () => void
  onToggleConstraintTiles: () => void
  onSetPartColorPopover: (opts: { partId: string; position: [number, number] } | null) => void
  onExportPart: (partId: string, name: string) => void
  onTogglePartVisibility: (partId: string, visible: boolean) => void
  onNewSketchOnPlane: (planeQuery: string) => void
  onFreezeProjection: (mode: FreezeProjectionMode, targets: readonly string[]) => void
}

export interface BuildContextMenuOutput {
  items: ContextMenuItem[]
}

// The part editor has exactly two boards, and which one shows depends only on
// whether a sketch edit owns the viewport. Each board is a fixed list: every
// command keeps its slot and an unusable one is greyed rather than dropped, so
// the menu never shifts or changes height under the pointer. There is no third
// body board: a `body:` target is the body target of the part board.
export function buildContextMenu(
  input: BuildContextMenuInput,
  callbacks: BuildContextMenuCallbacks,
): BuildContextMenuOutput {
  return input.activeSketchFeatureId
    ? buildSketchBoard(input, callbacks)
    : buildPartBoard(input, callbacks)
}

/**
 * The board for everything outside a sketch edit. A tree row, a viewport
 * surface and a body are all reachable from it; the surface keeps New Sketch and
 * Normal to, the body keeps Hide/Color/Export/Rename, and one item can be live
 * for both at once (a hovered face of a body).
 */
export function buildPartBoard(
  input: BuildContextMenuInput,
  callbacks: BuildContextMenuCallbacks,
): BuildContextMenuOutput {
  const featureId = input.targetId
  const target = featureId ? input.features.find(f => f.id === featureId) : undefined
  const surfaceTarget = resolveSurfaceTarget(input, target)
  const part = resolvePartTarget(input)

  // The tree row wins the one Hide/Show slot over a part under the pointer:
  // hiding a feature hides the parts it made, so the row is the wider command.
  // The row needs an eye (the origin has none) and a built-in does not lose it,
  // because the tree offers the same eye on a built-in plane.
  const featureEye = target !== undefined && hasFeatureVisibilityToggle(target.kind)
  const visibilityIsOn = featureEye ? input.visibleFeatures.has(target.id) : !!part?.visible
  const canToggleVisibility = featureEye || part !== null
  // A `body:` target has no feature at all, so the feature verbs need a real
  // target as well as the authored-id rule.
  const canManage = target !== undefined
    && canManageFeature(featureId, input.builtInIds, input.activeSketchFeatureId)

  const featureRename: RenameTarget | null = canManage && featureId
    ? { kind: 'feature', id: featureId, currentName: target?.label || featureId }
    : null
  const rename = featureRename ?? (part
    ? { kind: 'body' as const, id: part.partId, currentName: part.currentName }
    : null)

  return {
    items: [
      {
        label: 'New Sketch',
        icon: featureSketchIcon,
        disabled: !surfaceTarget,
        onClick: () => {
          if (surfaceTarget) callbacks.onNewSketchOnPlane(surfaceTarget.query)
        },
      },
      {
        label: 'Normal to',
        icon: contextCameraIcon,
        disabled: !surfaceTarget,
        onClick: () => {
          if (!surfaceTarget) return
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
        label: DANGLING_LABEL,
        icon: contextRebuildIcon,
        disabled: !input.hasDanglingContent,
        onClick: () => {
          if (input.hasDanglingContent) callbacks.onRemoveDanglingContent()
        },
      },
      {
        label: visibilityIsOn ? 'Hide' : 'Show',
        icon: contextHideIcon,
        disabled: !canToggleVisibility,
        onClick: () => {
          if (featureEye) callbacks.onToggleVisibility(target.id)
          else if (part) callbacks.onTogglePartVisibility(part.partId, !part.visible)
        },
      },
      {
        label: 'Color',
        icon: contextColorIcon,
        disabled: part === null,
        onClick: () => {
          if (part) callbacks.onSetPartColorPopover({ partId: part.partId, position: input.pos })
        },
      },
      {
        label: 'Export',
        icon: featureExportIcon,
        disabled: part === null,
        onClick: () => {
          if (part) callbacks.onExportPart(part.partId, part.currentName)
        },
      },
      {
        label: target?.suppressed ? 'Unsuppress' : 'Suppress',
        icon: contextHideIcon,
        disabled: !canManage,
        onClick: () => {
          if (canManage && featureId) callbacks.onToggleSuppression(featureId, !target?.suppressed)
        },
      },
      {
        label: 'Rename',
        icon: iconRenameIcon,
        disabled: rename === null,
        onClick: () => {
          if (rename) callbacks.onRequestRename(rename)
        },
      },
      {
        label: 'Delete',
        icon: contextDeleteIcon,
        className: 'right-click-menu-item--delete',
        disabled: !canManage,
        onClick: () => {
          if (canManage && featureId) callbacks.onDeleteFeature(featureId)
        },
      },
    ],
  }
}

/**
 * The board while a sketch edit is open: the session verbs, the freeze pair on
 * a projected pick, and Normal to. It is the whole menu even for a tree row
 * clicked during the edit; the row's own eye and double-click rename stay on
 * the row, and leaving the session is what brings the part board back.
 */
export function buildSketchBoard(
  input: BuildContextMenuInput,
  callbacks: BuildContextMenuCallbacks,
): BuildContextMenuOutput {
  const featureId = input.targetId
  const target = featureId ? input.features.find(f => f.id === featureId) : undefined
  const surfaceTarget = resolveSurfaceTarget(input, target)
  // buildContextMenu picks this board only when a sketch edit is open, so the id
  // is always there; the guards keep a direct caller honest rather than acting
  // the edited-sketch commands on an empty id.
  const sketchId = input.activeSketchFeatureId
  const sketchVisible = !!sketchId && input.visibleFeatures.has(sketchId)
  const canFreeze = input.projectedTargetIds.length > 0
  const targets = input.projectedTargetIds

  return {
    items: [
      {
        label: 'Exit Sketch',
        icon: contextExitIcon,
        onClick: callbacks.onExitSketch,
      },
      {
        label: 'Normal to sketch',
        icon: contextCameraIcon,
        onClick: callbacks.onAlignCameraToSketchPlane,
      },
      {
        label: 'Normal to',
        icon: contextCameraIcon,
        disabled: !surfaceTarget,
        onClick: () => {
          if (!surfaceTarget) return
          if (surfaceTarget.kind === 'plane') callbacks.onNormalToPlane(surfaceTarget.featureId)
          else callbacks.onAlignToFace(surfaceTarget.normal, surfaceTarget.center)
        },
      },
      {
        label: sketchVisible ? 'Hide' : 'Show',
        icon: contextHideIcon,
        onClick: () => {
          if (sketchId) callbacks.onToggleVisibility(sketchId)
        },
      },
      {
        label: input.showConstraintTiles ? 'Hide Constraints' : 'Show Constraints',
        icon: constraintTileIcon,
        onClick: callbacks.onToggleConstraintTiles,
      },
      {
        label: 'Convert to fixed',
        icon: constraintFixedIcon,
        disabled: !canFreeze,
        onClick: () => {
          if (canFreeze) callbacks.onFreezeProjection('fixed', targets)
        },
      },
      {
        label: 'Break link (keep free)',
        icon: constraintProjectionIcon,
        disabled: !canFreeze,
        onClick: () => {
          if (canFreeze) callbacks.onFreezeProjection('free', targets)
        },
      },
      {
        label: 'Rebuild',
        icon: contextRebuildIcon,
        onClick: callbacks.onRebuild,
      },
    ],
  }
}

/**
 * The single part a right-click acts on, or null. A `body:` target names it
 * directly; a viewport click carries the id the page resolved from the hover and
 * the selection. A tree feature target resolves no part: it names a feature, and
 * the feature's own Hide is the broader command for the parts it made.
 */
function resolvePartTarget(input: BuildContextMenuInput): PartTarget | null {
  const partId = input.targetId?.startsWith('body:')
    ? input.targetId.slice('body:'.length)
    : input.targetId
      ? null
      : input.targetPartId
  if (!partId) return null
  const ordered = [...(input.orderedPartIds ?? Object.keys(input.partLabels))]
  if (!ordered.includes(partId)) ordered.push(partId)
  return {
    partId,
    currentName: partDisplayName(partId, input.partLabels, ordered),
    visible: input.visibleParts === undefined || input.visibleParts.has(partId),
  }
}

/**
 * The surface the New Sketch and Normal to items act on, resolved from the tree
 * target, then the viewport hover, then the selection. A tree plane wins, then a
 * plane hovered in the viewport, then a flat face hovered there (a plane carries
 * no face frame, a curved face carries none either, so each drops out of the
 * other's branch). Only a bare viewport right-click falls back to the selection,
 * and only outside a sketch edit, where the edited sketch's own plane is the
 * view already offered.
 */
function resolveSurfaceTarget(
  input: BuildContextMenuInput,
  target: PartFeature | undefined,
): SurfaceTarget | null {
  const {
    targetId,
    hoveredSelectionId,
    hoveredFaceNormal,
    hoveredFaceCenter,
    selectedNormalTarget,
    features,
    activeSketchFeatureId,
    builtInIds,
  } = input

  // Only a viewport right-click has no targetId. The feature tree always names
  // its target, and must not be hijacked by whatever the pointer last hovered
  // in the viewport (hover is not cleared when the pointer leaves the canvas).
  const hoveredInViewport = targetId ? null : hoveredSelectionId

  if (target?.kind === 'plane') {
    return { kind: 'plane', featureId: target.id, query: planeQuery(target.id, builtInIds) }
  }
  if (hoveredInViewport) {
    const hoveredPlane = findPlaneByQuery(hoveredInViewport, features, builtInIds)
    if (hoveredPlane) {
      return { kind: 'plane', featureId: hoveredPlane.id, query: planeQuery(hoveredPlane.id, builtInIds) }
    }
    if (hoveredFaceNormal && hoveredFaceCenter) {
      return {
        kind: 'face',
        query: hoveredInViewport,
        normal: hoveredFaceNormal,
        center: hoveredFaceCenter,
      }
    }
    return null
  }
  if (!targetId && !activeSketchFeatureId && selectedNormalTarget) {
    return selectedNormalTarget.kind === 'plane'
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
  return null
}
