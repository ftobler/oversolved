import type { PartFeature } from '@/types/cad'
import type { ContextMenuItem } from '@/components/dialogs/RightClickMenu'
import { builtinSelectionId } from '@/components/Geometry3D/utils'
import { hasFeatureVisibilityToggle } from '@/components/layout/featureVisibilityKinds'
import { partDisplayName } from '@/utils/core/partDisplayName'
import { featureDisplayName } from '@/utils/core/displayNames'

import contextRebuildIcon from '@/assets/icons/context-rebuild.svg'
import contextHideIcon from '@/assets/icons/context-hide.svg'
import contextShowIcon from '@/assets/icons/context-show.svg'
import contextCleanupIcon from '@/assets/icons/context-cleanup.svg'
import contextSuppressIcon from '@/assets/icons/context-suppress.svg'
import contextUnsuppressIcon from '@/assets/icons/context-unsuppress.svg'
import contextExitIcon from '@/assets/icons/context-exit.svg'
import contextCameraIcon from '@/assets/icons/context-camera.svg'
import contextNormalSketchIcon from '@/assets/icons/context-normal-sketch.svg'
import contextConstraintsShowIcon from '@/assets/icons/context-constraints-show.svg'
import contextConstraintsHideIcon from '@/assets/icons/context-constraints-hide.svg'
import contextDeleteIcon from '@/assets/icons/context-delete.svg'
import contextColorIcon from '@/assets/icons/context-color.svg'
import iconRenameIcon from '@/assets/icons/rename.svg'
import featureExportIcon from '@/assets/icons/icon-download.svg'
import constraintFixedIcon from '@/assets/icons/constraint-fixed.svg'
import constraintProjectionIcon from '@/assets/icons/constraint-projection.svg'
import constraintDimensionIcon from '@/assets/icons/constraint-dimension.svg'
import featureSketchIcon from '@/assets/icons/feature-sketch.svg'
import type { FreezeProjectionMode } from '@/utils/yamlMutations/freezeProjection'

// The dangling-content cleanup's label is long on purpose: it names both things
// the one command removes, and the row is the only place either is mentioned.
const DANGLING_LABEL = 'Remove dangling projections / superfluous constraints'

// Which board the page wants. Set explicitly by the caller instead of derived
// from targetId, so a future viewport path that also sets a target cannot switch
// boards by accident.
export type ContextMenuSurface = 'tree' | 'parts' | 'viewport'

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

// Whether an authored feature exposes the verbs that fight the open sketch
// session (Delete, Suppress). A built-in has no author and no place in the doc
// to change. Rename is deliberately not one of those verbs: it only changes a
// label, so it has its own gate below and the open sketch can be renamed.
export function canManageFeature(
  featureId: string | undefined,
  builtInIds: Set<string>,
  activeSketchFeatureId: string | undefined,
): boolean {
  return !!featureId && !builtInIds.has(featureId) && featureId !== activeSketchFeatureId
}

// Rename only needs an authored id. Unlike Delete and Suppress it does not touch
// the sketch's geometry, so the open sketch keeps its Rename entry on both the
// card and the sketch board. builtInIds is the whole refusal: a built-in plane
// has no row in the document to carry a new label.
export function canRenameFeature(
  featureId: string | undefined,
  builtInIds: Set<string>,
): boolean {
  return !!featureId && !builtInIds.has(featureId)
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
  // The board to build. An open sketch edit always shows the sketch board;
  // otherwise this picks between the tree row, parts row and viewport boards.
  surface: ContextMenuSurface
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
  // Whether the named sketch's last solve flagged anything the cleanup would
  // remove. The page answers for the open sketch only, so another sketch's
  // flags cannot light this item.
  hasDanglingContent: (sketchId: string) => boolean
  // The selection ids of the projected entities and projection tiles the
  // right-click acts on, resolved by the caller from the picked entity/tile
  // first and then the current selection. Empty greys the freeze pair; the
  // command selects these before it runs.
  projectedTargetIds: readonly string[]
  // The dimension a right-click can flip between driving and reference. The
  // page resolves it from the picked tile plus the current selection; absent
  // greys the toggle item rather than adding a second board.
  drivenTarget?: { featureId: string; constraintId: string; driven: boolean }
}

export interface BuildContextMenuCallbacks {
  onRebuild: () => void
  onRemoveDanglingContent: (sketchId: string) => void
  onToggleVisibility: (featureId: string) => void
  onToggleSuppression: (featureId: string, suppressed: boolean) => void
  onExitSketch: () => void
  onDeleteFeature: (featureId: string) => void
  // Starts the toolbar's add-and-edit flow for a delete_body seeded with this
  // part, so the menu and the toolbar share one insertion path.
  onDeletePart: (partId: string) => void
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
  onToggleConstraintDriven?: (featureId: string, constraintId: string, driven: boolean) => void
}

export interface BuildContextMenuOutput {
  items: ContextMenuItem[]
}

// The part editor has one board per surface, plus the sketch-edit board. Each
// board is a fixed list: every command keeps its slot and an unusable one is
// greyed rather than dropped, so the menu never shifts or changes height under
// the pointer. An open sketch edit owns the whole menu even for a tree row.
export function buildContextMenu(
  input: BuildContextMenuInput,
  callbacks: BuildContextMenuCallbacks,
): BuildContextMenuOutput {
  if (input.activeSketchFeatureId) return buildSketchBoard(input, callbacks)
  if (input.surface === 'tree') return buildTreeRowBoard(input, callbacks)
  if (input.surface === 'parts') return buildPartRowBoard(input, callbacks)
  return buildPartBoard(input, callbacks)
}

// The items below are the shared slots. Each board composes them in its own
// order; keeping the item bodies here means a command behaves the same on every
// board it appears on.
function newSketchItem(surfaceTarget: SurfaceTarget | null, callbacks: BuildContextMenuCallbacks): ContextMenuItem {
  return {
    label: 'New Sketch',
    icon: featureSketchIcon,
    disabled: !surfaceTarget,
    onClick: () => {
      if (surfaceTarget) callbacks.onNewSketchOnPlane(surfaceTarget.query)
    },
  }
}

function normalToItem(surfaceTarget: SurfaceTarget | null, callbacks: BuildContextMenuCallbacks): ContextMenuItem {
  return {
    label: 'Normal to',
    icon: contextCameraIcon,
    disabled: !surfaceTarget,
    onClick: () => {
      if (!surfaceTarget) return
      if (surfaceTarget.kind === 'plane') callbacks.onNormalToPlane(surfaceTarget.featureId)
      else callbacks.onAlignToFace(surfaceTarget.normal, surfaceTarget.center)
    },
  }
}

function rebuildItem(callbacks: BuildContextMenuCallbacks): ContextMenuItem {
  return { label: 'Rebuild', icon: contextRebuildIcon, onClick: callbacks.onRebuild }
}

function cleanupItem(
  sketchId: string | undefined,
  input: BuildContextMenuInput,
  callbacks: BuildContextMenuCallbacks,
): ContextMenuItem {
  const dirty = !!sketchId && input.hasDanglingContent(sketchId)
  return {
    label: DANGLING_LABEL,
    icon: contextCleanupIcon,
    disabled: !dirty,
    onClick: () => {
      if (sketchId && dirty) callbacks.onRemoveDanglingContent(sketchId)
    },
  }
}

interface BoardContext {
  featureId: string | undefined
  target: PartFeature | undefined
  surfaceTarget: SurfaceTarget | null
  part: PartTarget | null
  featureEye: boolean
  visibilityIsOn: boolean
  canToggleVisibility: boolean
  canManage: boolean
  rename: RenameTarget | null
}

// The part board and the tree-row board share one Hide/Show slot: the feature
// eye wins over a part under the pointer because hiding a feature also hides the
// parts it made. A `body:` target has no feature at all, so the feature verbs
// need a real target as well as the authored-id rule.
function resolveBoardContext(input: BuildContextMenuInput): BoardContext {
  const featureId = input.targetId
  const target = featureId ? input.features.find(f => f.id === featureId) : undefined
  const surfaceTarget = resolveSurfaceTarget(input, target)
  const part = resolvePartTarget(input)
  const featureEye = target !== undefined && hasFeatureVisibilityToggle(target.kind)
  // A suppressed feature is absent from the drawn set, so the eye reads the
  // stored flag: it is what takes effect again once unsuppressed.
  const visibilityIsOn = featureEye
    ? (target.suppressed === true ? target.visible !== false : input.visibleFeatures.has(target.id))
    : !!part?.visible
  const canToggleVisibility = featureEye || part !== null
  const canManage = target !== undefined
    && canManageFeature(featureId, input.builtInIds, input.activeSketchFeatureId)
  const canRename = target !== undefined && canRenameFeature(featureId, input.builtInIds)

  const featureRename: RenameTarget | null = canRename && featureId
    ? {
        kind: 'feature',
        id: featureId,
        currentName: target !== undefined && typeof target.label === 'string' && target.label.trim() !== ''
          ? target.label
          : featureDisplayName(target, input.features),
      }
    : null
  const rename = featureRename ?? (part
    ? { kind: 'body' as const, id: part.partId, currentName: part.currentName }
    : null)

  return {
    featureId, target, surfaceTarget, part, featureEye, visibilityIsOn,
    canToggleVisibility, canManage, rename,
  }
}

function visibilityItem(ctx: BoardContext, callbacks: BuildContextMenuCallbacks): ContextMenuItem {
  return {
    label: ctx.visibilityIsOn ? 'Hide' : 'Show',
    icon: ctx.visibilityIsOn ? contextHideIcon : contextShowIcon,
    disabled: !ctx.canToggleVisibility,
    onClick: () => {
      if (ctx.featureEye && ctx.target) callbacks.onToggleVisibility(ctx.target.id)
      else if (ctx.part) callbacks.onTogglePartVisibility(ctx.part.partId, !ctx.part.visible)
    },
  }
}

function colorItem(ctx: BoardContext, input: BuildContextMenuInput, callbacks: BuildContextMenuCallbacks): ContextMenuItem {
  return {
    label: 'Color',
    icon: contextColorIcon,
    disabled: ctx.part === null,
    onClick: () => {
      if (ctx.part) callbacks.onSetPartColorPopover({ partId: ctx.part.partId, position: input.pos })
    },
  }
}

function exportItem(ctx: BoardContext, callbacks: BuildContextMenuCallbacks): ContextMenuItem {
  return {
    label: 'Export',
    icon: featureExportIcon,
    disabled: ctx.part === null,
    onClick: () => {
      if (ctx.part) callbacks.onExportPart(ctx.part.partId, ctx.part.currentName)
    },
  }
}

function suppressItem(ctx: BoardContext, callbacks: BuildContextMenuCallbacks): ContextMenuItem {
  const suppressed = ctx.target?.suppressed === true
  return {
    label: suppressed ? 'Unsuppress' : 'Suppress',
    icon: suppressed ? contextUnsuppressIcon : contextSuppressIcon,
    disabled: !ctx.canManage,
    onClick: () => {
      if (ctx.canManage && ctx.featureId) callbacks.onToggleSuppression(ctx.featureId, !suppressed)
    },
  }
}

function renameItem(rename: RenameTarget | null, callbacks: BuildContextMenuCallbacks): ContextMenuItem {
  return {
    label: 'Rename',
    icon: iconRenameIcon,
    disabled: rename === null,
    onClick: () => {
      if (rename) callbacks.onRequestRename(rename)
    },
  }
}

function deleteFeatureItem(ctx: BoardContext, callbacks: BuildContextMenuCallbacks): ContextMenuItem {
  return {
    label: 'Delete',
    icon: contextDeleteIcon,
    className: 'right-click-menu-item--delete',
    disabled: !ctx.canManage,
    onClick: () => {
      if (ctx.canManage && ctx.featureId) callbacks.onDeleteFeature(ctx.featureId)
    },
  }
}

function deletePartItem(ctx: BoardContext, callbacks: BuildContextMenuCallbacks): ContextMenuItem {
  return {
    label: 'Delete',
    icon: contextDeleteIcon,
    className: 'right-click-menu-item--delete',
    disabled: ctx.part === null,
    onClick: () => {
      if (ctx.part) callbacks.onDeletePart(ctx.part.partId)
    },
  }
}

/**
 * The viewport board when no sketch edit is open: the surface keeps New Sketch
 * and Normal to, the part under the pointer keeps Hide/Color/Export/Rename, and
 * one item can be live for both at once (a hovered face of a body). No cleanup:
 * that moved to the sketch board, where the sketch it would clean is open.
 */
export function buildPartBoard(
  input: BuildContextMenuInput,
  callbacks: BuildContextMenuCallbacks,
): BuildContextMenuOutput {
  const ctx = resolveBoardContext(input)
  return {
    items: [
      newSketchItem(ctx.surfaceTarget, callbacks),
      normalToItem(ctx.surfaceTarget, callbacks),
      rebuildItem(callbacks),
      visibilityItem(ctx, callbacks),
      colorItem(ctx, input, callbacks),
      exportItem(ctx, callbacks),
      suppressItem(ctx, callbacks),
      renameItem(ctx.rename, callbacks),
      deleteFeatureItem(ctx, callbacks),
    ],
  }
}

/**
 * A feature-tree row: it names a feature, not a body, so there is no Color or
 * Export and no cleanup. New Sketch and Normal to stay as greyed slots for a
 * row that is not a plane; the management verbs keep the authored-id gate.
 */
export function buildTreeRowBoard(
  input: BuildContextMenuInput,
  callbacks: BuildContextMenuCallbacks,
): BuildContextMenuOutput {
  const ctx = resolveBoardContext(input)
  return {
    items: [
      newSketchItem(ctx.surfaceTarget, callbacks),
      normalToItem(ctx.surfaceTarget, callbacks),
      rebuildItem(callbacks),
      visibilityItem(ctx, callbacks),
      suppressItem(ctx, callbacks),
      renameItem(ctx.rename, callbacks),
      deleteFeatureItem(ctx, callbacks),
    ],
  }
}

/**
 * A Parts card row: it names a part, so the surface verbs and Suppress do not
 * apply. Delete starts the prefilled Delete Part edit card instead of deleting
 * a feature, while Color, Export and Rename act on the part as a body target.
 */
export function buildPartRowBoard(
  input: BuildContextMenuInput,
  callbacks: BuildContextMenuCallbacks,
): BuildContextMenuOutput {
  const ctx = resolveBoardContext(input)
  return {
    items: [
      rebuildItem(callbacks),
      visibilityItem(ctx, callbacks),
      colorItem(ctx, input, callbacks),
      exportItem(ctx, callbacks),
      renameItem(ctx.rename, callbacks),
      deletePartItem(ctx, callbacks),
    ],
  }
}

/**
 * The board while a sketch edit is open: the session verbs, Rename for the open
 * sketch, the freeze pair on a projected pick, the cleanup for the open sketch,
 * and Normal to. It is the whole menu even for a tree row clicked during the
 * edit; leaving the session is what brings the part board back.
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
  // Rename names the open sketch itself, not the right-click target: this board
  // is the whole sketch session even when a tree row was clicked. It uses the
  // same authored-id gate as the card, so the two cannot disagree.
  const sketchFeature = sketchId ? input.features.find(f => f.id === sketchId) : undefined
  const sketchRename: RenameTarget | null = sketchId && canRenameFeature(sketchId, input.builtInIds)
    ? {
        kind: 'feature',
        id: sketchId,
        currentName: sketchFeature && typeof sketchFeature.label === 'string' && sketchFeature.label.trim() !== ''
          ? sketchFeature.label
          : sketchFeature ? featureDisplayName(sketchFeature, input.features) : sketchId,
      }
    : null

  return {
    items: [
      {
        label: 'Exit Sketch',
        icon: contextExitIcon,
        onClick: callbacks.onExitSketch,
      },
      {
        label: 'Normal to sketch',
        icon: contextNormalSketchIcon,
        onClick: callbacks.onAlignCameraToSketchPlane,
      },
      normalToItem(surfaceTarget, callbacks),
      {
        label: sketchVisible ? 'Hide' : 'Show',
        icon: sketchVisible ? contextHideIcon : contextShowIcon,
        onClick: () => {
          if (sketchId) callbacks.onToggleVisibility(sketchId)
        },
      },
      renameItem(sketchRename, callbacks),
      {
        label: input.showConstraintTiles ? 'Hide Constraints' : 'Show Constraints',
        icon: input.showConstraintTiles ? contextConstraintsHideIcon : contextConstraintsShowIcon,
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
        label: input.drivenTarget?.driven ? 'Make dimension driving' : 'Make dimension driven',
        icon: constraintDimensionIcon,
        disabled: input.drivenTarget === undefined || callbacks.onToggleConstraintDriven === undefined,
        onClick: () => {
          const t = input.drivenTarget
          if (t) callbacks.onToggleConstraintDriven?.(t.featureId, t.constraintId, !t.driven)
        },
      },
      cleanupItem(sketchId, input, callbacks),
      rebuildItem(callbacks),
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
