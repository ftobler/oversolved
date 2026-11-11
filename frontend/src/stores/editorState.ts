// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
//
// L2 editor state: the one owner of the part editor's rollback/editing FSM
// (rollbackPosition, pickBoundary, editingFeatureId), the sketch editor's
// selection/tool/draw state and the derived viewport fields that are not solve
// results. Solve results, bodies, timings and validation are session/solver
// data and live in their own publication store (partEditorStore); nothing here
// copies them. The store is vanilla (zustand/vanilla) so L1-adjacent code and
// tests can drive it without React; the React binding lives in
// hooks/useEditorState.ts, and the historical name `useSketchEditorStore` is a
// re-export of that binding from stores/sketchEditorStore.ts.
import { createStore } from 'zustand/vanilla'
import type { FilletCorner, Mutation, PartDoc, PartStyleEntry, SelectionDomain } from '@/types/cad'
import type { DimensionPick } from '@/registry'
import { resolveDimension, dimensionTargets, CONSTRAINT_BY_KIND } from '@/registry'
import { computeNaturalDimensionValue, computeAnchorRelativePos, resolveDimPoints, computeDimensionSign, computeAnglePlacementIsSupplement } from '@/utils/geometry/dimensionNaturalValue'
import { deriveSelectionDomain, devOnly, testMode, failLoud } from './stateInvariants'
import { isDrawingTool } from '@/registry/toolRegistry'
import { getToolPickConfig } from '@/registry/toolPickConfig'
import { planBrepDimensionPick, planProjectedOperand, classifyBrepOperand, refreshProjectedPickKinds, type PlannedProjection, type ProjectedEntityMutation } from '@/tools/operandProjection'
import { commitDrawGesture } from '@/tools/commitDrawGesture'
import { computeDrawFinish } from '@/utils/geometry/drawFinish'
import { randomId, canonicalLineDistanceTargets, isPointLikeEntityKind, pointDistanceZeroProblem } from '@/utils/yamlMutations/helpers'
import { dimensionValueRule } from '@/utils/core/dimensionValueRules'
import { isConstraintKindName } from '@/wasm-kernel/codec'
import type { DialogState, FilletCornerMap, SketchEditorState } from './sketchEditorTypes'
import { sketchCallbacks, requireMutation, dispatchWithheldDelete, pickProjectionEntityId, CANNOT_APPLY_TITLE, type PendingConstraint } from './sketchEditorCallbacks'
import { samePoint, validateWithRepair, prunePickClaims } from './sketchEditorHelpers'
import { activateTool, deactivateTool } from './sketchEditorToolLifecycle'
import { clampRollbackPosition } from '@/session/DocSession'
import { refusalText } from '@/utils/core/statusMark'
import { cannotEvaluate, positive } from '@/utils/core/valueRules'

// The value dialog is UI-store state (sketchEditorStore registers the ports at
// module scope). A headless consumer of this store that never imported the UI
// store has no port; a silent `?.()` would drop the prompt with nothing shown.
// Fail loud instead (dev/test harness tier: throws in test, warns in dev).
// Closing stays deliberately optional: aborting a gesture is safe when no
// dialog can have been opened, and a loud close would break headless aborts.
function openDialogOrFail(dialog: DialogState): void {
  if (!sketchCallbacks.openDialog) {
    failLoud('[editorState] openDialog: no dialog port registered, the value dialog cannot open (import stores/sketchEditorStore in the editor build)')
    return
  }
  sketchCallbacks.openDialog(dialog)
}

// The sketch-half of a Delete selection: entity, vertex and constraint targets
// that belong to the active sketch. deleteSelected consumes exactly these and
// ignores the rest, so `@feature`/body ids in a mixed selection survive here for
// another consumer. Exported so the page's Delete handler can compute the same
// half -- to fold a mixed sketch + 3D delete into a single undo entry -- without
// re-deriving the prefix/split rules. Keep this and deleteSelected's own use of
// it as one definition.
export function sketchOwnedDeleteTargets(selection: Set<string>, activeFeatureId: string | null): string[] {
  return [...selection].filter(target => {
    if (target.startsWith('entity:') || target.startsWith('vertex:') || target.startsWith('constraint:')) {
      return target.split(':')[1] === activeFeatureId
    }
    return false
  })
}

// The selection contract of mirror_entities: the selected entities are the
// sources and one selected line is the axis. A lone selected line is the axis;
// when the sources hold lines too (a half profile), the axis is the one
// selected construction line, the centerline convention. Vertex and constraint
// selections ride along untouched; the plan speaks in bare entity ids, the
// shape the mutation takes. Exported so the command's `enabled` verdict and the
// store action read one definition and cannot drift apart.
export interface MirrorSelectionPlan {
  axis: string
  sourceIds: string[]
}

export function mirrorSelectionPlan(
  selection: Set<string>,
  activeFeatureId: string | null,
  entityKindMap: Record<string, string>,
  // The construction entities as `entity:<sketch>:<id>` keys, the kind map's
  // key shape (constructionEntityKeys in the store).
  constructionKeys: ReadonlySet<string> = new Set(),
): MirrorSelectionPlan | { reason: string } {
  if (!activeFeatureId || selection.size === 0) return { reason: 'no entities selected' }
  const ids = [...selection]
    .filter(t => t.startsWith('entity:') && t.split(':')[1] === activeFeatureId)
    .map(t => t.split(':')[2])
  if (ids.length === 0) return { reason: 'no entities selected' }
  const lines = ids.filter(id => entityKindMap[`entity:${activeFeatureId}:${id}`] === 'line')
  if (lines.length === 0) return { reason: 'mirror needs a selected line to mirror across' }
  let axis = lines[0]
  if (lines.length > 1) {
    const centerlines = lines.filter(id => constructionKeys.has(`entity:${activeFeatureId}:${id}`))
    if (centerlines.length !== 1) {
      return { reason: 'with several lines selected, mirror needs exactly one construction line among them as the axis' }
    }
    axis = centerlines[0]
  }
  const sourceIds = ids.filter(id => id !== axis)
  // The axis alone is nothing to mirror; the drive boundary refuses the empty
  // sourceIds the same way, so the gate refuses it here too instead of letting
  // the mutation dispatch and do nothing.
  if (sourceIds.length === 0) return { reason: 'mirror needs an entity to mirror besides the axis line' }
  return { axis, sourceIds }
}

// The selection contract of pattern_entities: every selected entity of the
// active sketch is a source. A vertex or constraint selection names no entity
// to copy, so a selection holding only those is refused rather than read as
// "the entity under the vertex". Exported so the command's `enabled` verdict
// and the store action read one definition.
export function patternSelectionPlan(
  selection: Set<string>,
  activeFeatureId: string | null,
): { sourceIds: string[] } | { reason: string } {
  if (!activeFeatureId) return { reason: 'no active sketch' }
  const inSketch = [...selection].filter(t => t.split(':')[1] === activeFeatureId)
  const sourceIds = inSketch.filter(t => t.startsWith('entity:')).map(t => t.split(':')[2])
  if (sourceIds.length > 0) return { sourceIds }
  if (inSketch.some(t => t.startsWith('vertex:'))) {
    return { reason: 'pattern copies whole entities; select the entities, not their vertices' }
  }
  return { reason: 'select one or more entities of the active sketch to pattern' }
}

// The selection contract of fillet_corners: every selected vertex is one
// corner, and its partner comes from the corner map Geometry3D publishes for
// the active sketch. A selected vertex with no single line partner, or with a
// T-junction, is refused with the map's own reason so the gate and the drive
// boundary say the same thing. Exported so the command's `enabled` verdict and
// the store action read one definition.
export interface FilletSelectionPlan {
  corners: FilletCorner[]
}

export function filletSelectionPlan(
  selection: Set<string>,
  activeFeatureId: string | null,
  cornerMap: FilletCornerMap,
): FilletSelectionPlan | { reason: string } {
  if (!activeFeatureId) return { reason: 'no active sketch' }
  const vertices = [...selection].filter(target =>
    target.startsWith('vertex:') && target.split(':')[1] === activeFeatureId)
  if (vertices.length === 0) return { reason: 'select one or more sketch vertices to fillet' }

  const corners: FilletCorner[] = []
  const seen = new Set<string>()
  for (const target of vertices) {
    const parts = target.split(':')
    const entityId = parts[2]
    const vertexKey = parts[3]
    if (vertexKey !== 'start' && vertexKey !== 'end') {
      return { reason: `vertex "${entityId}:${vertexKey}" is not a line endpoint` }
    }
    const entry = cornerMap[target]
    if (entry === undefined) {
      return { reason: `vertex "${entityId}:${vertexKey}" has no line partner in this sketch` }
    }
    if ('reason' in entry) return { reason: entry.reason }
    const pairKey = [
      `${entityId}:${vertexKey}`,
      `${entry.partner.entityId}:${entry.partner.vertexKey}`,
    ].sort().join('|')
    if (seen.has(pairKey)) continue
    seen.add(pairKey)
    corners.push({
      a: entityId,
      aVertex: vertexKey,
      b: entry.partner.entityId,
      bVertex: entry.partner.vertexKey,
      ...(entry.side !== undefined && { side: entry.side }),
    })
  }
  if (corners.length === 0) return { reason: 'select one or more sketch vertices to fillet' }
  return { corners }
}

// The user-facing reason for an add the redundancy gate refuses. Shared by the
// command path (applyConstraint returns it to the caller, which raises the
// cannot-apply message) and the dimension confirm path (which raises the
// message itself through the showMessage port), so both say the same thing.
function overconstrainReason(kind: string): string {
  const label = CONSTRAINT_BY_KIND.get(kind)?.label ?? kind
  return `This would overconstrain the sketch: the ${label.toLowerCase()} is already implied by the existing constraints.`
}

// The part-side editor FSM fields this store owns. Declared here rather than in
// sketchEditorTypes.ts because they are not sketch state: they are the
// rollback/edit contract the page and the session's editor facts read.
export interface PartEditorFsm {
  rollbackPosition: number | null
  pickBoundary: number | null
  editingFeatureId: string | null
  setRollbackPosition: (pos: number | null) => void
  setPickBoundary: (pos: number | null) => void
  setEditingFeatureId: (id: string | null) => void
}

// Derived viewport inputs that are not solve results: the page computes them
// from the live doc and edit session and publishes them here so the viewport
// reads one owner instead of a React mirror. Solve results, bodies and timings
// stay in their own store; they are never copied into this one.
export interface ViewportDerivedState {
  ghostMode: boolean
  partColors: Record<string, string>
  partStyle: Record<string, PartStyleEntry>
  activeSketchFeatureId: string | null
  setViewportDerived: (derived: { ghostMode: boolean; partColors: Record<string, string>; partStyle: Record<string, PartStyleEntry> }) => void
  setActiveSketchFeatureId: (id: string | null) => void
}

export interface EditorState extends SketchEditorState, PartEditorFsm, ViewportDerivedState {
  // A history restore rewound the doc: the bar clamps to the restored feature
  // list, and the open editor the move consumed comes down. One unit, so an
  // undo can never leave a stale editing id over a restored doc.
  restoreHistory: (doc: PartDoc) => void
  // The unmount reset: drops every field this store owns that describes the
  // previous document, leaving the sketch-transient reset to resetTransientState.
  resetEditorState: () => void
}

// The rollback bar after a restore, clamped to the restored feature list exactly
// as the page clamps a loaded doc. Pure, so the L2 handling below and its tests
// derive the value from an event doc without a store in hand.
export function clampRollback(doc: PartDoc): number {
  return clampRollbackPosition(doc)
}

// A whole-document seam (open, recovery restore, a swap) carries its own parked
// bar. Write it into the store BEFORE the first solve: reSolve reads the store
// live, and on a fresh session a null there means "bar at the end", which would
// rebuild the very features the document rolled back.
export function syncRollbackFromDoc(doc: PartDoc): void {
  editorState.getState().setRollbackPosition(clampRollback(doc))
}

// The values the unmount reset restores for the part-side fields.
export const DEFAULT_EDITOR_STATE = {
  rollbackPosition: null,
  pickBoundary: null,
  editingFeatureId: null,
  ghostMode: false,
  partColors: {} as Record<string, string>,
  partStyle: {} as Record<string, PartStyleEntry>,
  activeSketchFeatureId: null,
} as const

export const editorState = createStore<EditorState>((set, get) => ({
  // Part-side FSM
  ...DEFAULT_EDITOR_STATE,
  // Sketch editor state moved from stores/sketchEditorStore.ts. UI prefs
  // (showConstraintTiles, ngonSides) and the pending value dialog
  // stay in that store; entityKindMap is here because applyConstraint reads it.
  normalSelection: new Set(),
  selectedPicks: new Map(),
  selectionDomain: 'sketch_2d',
  hoveredSelectionId: null,
  hoveredPickKey: null,
  isPointerDown: false,
  alignmentSnapPoint: null,
  alignmentSnapKind: null,
  drag: null,
  dragStartClient: null,
  dragPending: null,
  dragSnap: null,
  isRotating: false,
  entityKindMap: {},
  constructionEntityKeys: new Set(),
  filletCornerMap: {},
  hoveredConstraintEntityIds: new Set(),
  hoveredVertexId: null,
  hoveredFaceNormal: null,
  hoveredFaceCenter: null,
  hoveredVertexPosition: null,
  hoveredSnapKind: null,
  activeTool: null,
  activeFeatureId: null,
  activeOriginLocal: [0, 0],
  drawPoints: [],
  drawHover: null,
  drawSnapRefs: [],
  dimensionPicks: [],
  pendingBrepProjectionIds: [],
  dimensionCursorWorld: null,
  modeStack: [],
  activePickField: null,
  chipOwnedSelection: new Set(),

  pushMode: (kind: string) => set(s => ({
    modeStack: [...s.modeStack, kind],
  })),

  popMode: (expectedKind?: string) => {
    const state = get()
    if (state.modeStack.length === 0) {
      failLoud(`[popMode] stack is empty${expectedKind ? ` (expected '${expectedKind}')` : ''}`)
      return
    }
    const top = state.modeStack[state.modeStack.length - 1]
    if (expectedKind !== undefined && top !== expectedKind) {
      failLoud(`[popMode] expected '${expectedKind}' but top is '${top}'`)
    }
    const next = state.modeStack.slice(0, -1)
    set({ modeStack: next })
    // When stack becomes empty, validate all transient state is clean
    if (next.length === 0 && (devOnly || testMode)) {
      validateWithRepair(get, set)
    }
  },

  setHoveredSelectionId: (id) => set(s => {
    if (s.hoveredSelectionId === id) return s
    return { hoveredSelectionId: id }
  }),

  setHoveredPickKey: (key) => set(s => {
    if (s.hoveredPickKey === key) return s
    return { hoveredPickKey: key }
  }),

  setIsPointerDown: (down: boolean) => set({ isPointerDown: down }),

  clearNormalSelection: () => set({ normalSelection: new Set(), selectedPicks: new Map(), chipOwnedSelection: new Set(), selectionDomain: 'sketch_2d' }),

  // The post-delete wipe, shared by every path that removes entities so their
  // post-conditions cannot drift: the store's own deleteSelected and the page's
  // mixed Delete handler (Part.handleDeleteSelectedFeatures) both land here.
  // clearNormalSelection covers the selection half only; deleting an entity
  // also retires the constraint-tile hover that names it, and the mixed branch
  // used to stop short of that, stranding hoveredConstraintEntityIds on
  // geometry that had just been deleted.
  clearSelectionAfterDelete: () => set({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    chipOwnedSelection: new Set(),
    selectionDomain: 'sketch_2d',
    hoveredConstraintEntityIds: new Set(),
  }),

  clearSelectionAndHover: () => set({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    chipOwnedSelection: new Set(),
    selectionDomain: 'sketch_2d',
    hoveredSelectionId: null,
    hoveredPickKey: null,
    hoveredConstraintEntityIds: new Set(),
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    hoveredFaceNormal: null,
    hoveredFaceCenter: null,
  }),

  // Guarded so a solve that has nothing to clear does not mint a fresh map and
  // notify subscribers: this runs on every applied solve, and most solves carry
  // no claims at all.
  clearSelectedPicks: () => {
    if (get().selectedPicks.size === 0) return
    set({ selectedPicks: new Map() })
  },

  // Delegates the drag/pointer fields to clearDragState so the two lists
  // cannot drift apart the way applyUndoRedo's hand-listed reset once did
  // (see useAssemblyUndoRedo.ts) -- this is the canonical list they both draw
  // from.
  resetTransientState: () => {
    get().clearDragState()
    get().clearSelectionAndHover()
    set({
      activeTool: null,
      activeFeatureId: null,
      drawPoints: [],
      drawHover: null,
      drawSnapRefs: [],
      dimensionPicks: [],
      pendingBrepProjectionIds: [],
      dimensionCursorWorld: null,
      modeStack: [],
      activePickField: null,
      // Derived from the open document, so it belongs to the wipe for the same
      // reason the selection does: a remount or a fresh harness must not read
      // the previous document's entity kinds.
      entityKindMap: {},
      constructionEntityKeys: new Set(),
      filletCornerMap: {},
    })
  },

  // The unit of selection is one PRIMITIVE, not one query. When the click
  // carries a pickKey the (query, pickKey) pair is what toggles, so two distinct
  // primitives that share an ancestral query hold independent selection state
  // instead of evicting each other. The query stays in normalSelection until its
  // last claiming primitive is deselected.
  toggleNormalSelection: (id, pickKey) =>
    set(s => {
      const next = new Set(s.normalSelection)
      const nextPicks = new Map(s.selectedPicks)
      const claims = nextPicks.get(id)

      // No per-primitive identity (sketch entities, planes, origin), or a
      // query-only selection left over from a re-solve: the query IS the whole
      // selection, so toggle it wholesale.
      if (pickKey === undefined || (next.has(id) && claims === undefined)) {
        if (next.has(id)) {
          next.delete(id)
          nextPicks.delete(id)
        } else {
          next.add(id)
        }
        return { normalSelection: next, selectedPicks: nextPicks, selectionDomain: deriveSelectionDomain(next) }
      }

      if (claims === undefined) {
        next.add(id)
        nextPicks.set(id, new Set([pickKey]))
      } else if (claims.has(pickKey)) {
        const remaining = new Set(claims)
        remaining.delete(pickKey)
        // The durable entry outlives an individual primitive: it only leaves
        // normalSelection once nothing claims it any more.
        if (remaining.size === 0) {
          nextPicks.delete(id)
          next.delete(id)
        } else {
          // Re-assert the query on any outcome short of a full deselect, the
          // way the colliding-sibling branch below does: a multi-key claim left
          // behind by another writer must heal back into normalSelection rather
          // than shrink under a query nobody has selected.
          next.add(id)
          nextPicks.set(id, remaining)
        }
      } else {
        // A colliding sibling: additive, never a replacement. This is the click
        // that used to silently un-select whatever already held this query.
        // Re-assert the query too, so a claim left behind by another writer (an
        // orphan) cannot grow under a query that is no longer selected.
        next.add(id)
        nextPicks.set(id, new Set(claims).add(pickKey))
      }
      return { normalSelection: next, selectedPicks: nextPicks, selectionDomain: deriveSelectionDomain(next) }
    }),

  // Add-only selection mutation. Puts `id` into normalSelection and touches
  // nothing else: selectedPicks is left standing, so a pick persisted earlier
  // is not evicted. Pair it with clearNormalSelection when the caller wants
  // replace semantics (callers today: Constraints.tsx).
  addToNormalSelection: (id) =>
    set(s => {
      if (s.normalSelection.has(id)) return s
      const next = new Set(s.normalSelection)
      next.add(id)
      return { normalSelection: next, selectionDomain: deriveSelectionDomain(next) }
    }),

  // Replace semantics for a fresh rubber band. Unlike toggleNormalSelection a
  // box never deselects a covered entity and never accumulates outside it: the
  // boxed set IS the whole selection. Claims are dropped the way
  // clearNormalSelection drops them, because a box resolves queries without
  // pickKeys and the old per-primitive claims would otherwise resurrect as
  // ghost highlights (see computeHighlight).
  setNormalSelection: (ids) =>
    set(s => {
      const next = new Set(ids)
      // No-change guard: a box covering exactly the current selection with no
      // claims or chip-owned entries standing must not mint fresh maps and
      // notify. Returning `s` lets zustand skip the update entirely, like
      // addToNormalSelection's guard. The selectionDomain is a pure function of
      // the boxed set, so it is already consistent when the content matches.
      const sameSelection = next.size === s.normalSelection.size
        && [...next].every(v => s.normalSelection.has(v))
      if (sameSelection && s.selectedPicks.size === 0 && s.chipOwnedSelection.size === 0) {
        return s
      }
      return {
        normalSelection: next,
        selectedPicks: new Map(),
        chipOwnedSelection: new Set(),
        selectionDomain: deriveSelectionDomain(next),
      }
    }),

  setAlignmentSnap: (point, kind) => set({ alignmentSnapPoint: point, alignmentSnapKind: kind }),

  setDrag: (drag) => set({ drag }),
  setDragStartClient: (pos) => set({ dragStartClient: pos }),
  setDragPending: (pending) => set({ dragPending: pending }),
  setDragSnap: (snap) => set({ dragSnap: snap }),

  clearDragState: () => set({
    drag: null,
    dragPending: null,
    dragStartClient: null,
    dragSnap: null,
    alignmentSnapPoint: null,
    alignmentSnapKind: null,
    isPointerDown: false,
    isRotating: false,
  }),

  setIsRotating: (rotating: boolean) => set({ isRotating: rotating }),

  setActiveTool: (tool) => {
    const prevTool = get().activeTool

    // Switching tools abandons any in-flight brep dimension gesture: the
    // projections it materialised were scratch work for that gesture. Cancelled
    // before the deactivate below, the order setActivePickField already uses, so
    // the pending bookkeeping is empty by the time the old tool's mode entry
    // pops and the store revalidates on an empty stack.
    if (get().pendingBrepProjectionIds.length > 0) {
      get().cancelBrepProjectionGesture()
    }

    // Deactivate previous tool (lifecycle hook)
    deactivateTool(get, set, prevTool)

    // Entering a tool that doesn't conflict with an open pick field (currently
    // only the passive select/drag tool) must not steal the field: leave
    // activeTool exactly as it is (null while a pick is open) and skip arming
    // the tool, so the chip keeps routing face clicks through usePickField even
    // after the user clicks empty canvas. Drawing/dimension tools still reset it.
    const cur = get()
    const keepsPickField = tool !== null && cur.activePickField !== null && !isDrawingTool(tool) && !getToolPickConfig(tool).clearsSelectionOnEnter

    set(state => {
      const updates: Record<string, unknown> = {
        activeTool: keepsPickField ? cur.activeTool : tool,
        drawPoints: [],
        drawHover: null,
        drawSnapRefs: [],
      }
      // Reset leftover dimension placement state on every tool switch so the
      // first click in any tool starts a fresh gesture.
      updates.dimensionPicks = []
      updates.dimensionCursorWorld = null
      // A tool whose config requests it (currently only dimension) wipes the
      // current normal selection on enter so the picks the user makes inside
      // the tool aren't contaminated by a pre-existing selection. (Spec: "user
      // clicks 'd', everything de-selects.") Driven by ToolPickConfig so the
      // per-tool rule lives with the tool's policy, not buried here.
      if (getToolPickConfig(tool).clearsSelectionOnEnter) {
        updates.normalSelection = new Set<string>()
        updates.selectedPicks = new Map<string, Set<string>>()
      }
      // Clear stale pick-field state when entering a tool, but only for tools
      // that genuinely conflict with an open pick field. The passive select
      // (drag) tool must leave activePickField intact so a face click after
      // wandering the canvas still routes through usePickField. Drawing tools
      // and the dimension tool (clearsSelectionOnEnter) still reset it.
      if (tool !== null && state.activePickField !== null && (isDrawingTool(tool) || getToolPickConfig(tool).clearsSelectionOnEnter)) {
        updates.activePickField = null
        updates.chipOwnedSelection = new Set<string>()
        const baseNormal = (updates.normalSelection as Set<string> | undefined) ?? state.normalSelection
        const nextNormal = new Set(baseNormal)
        for (const v of state.chipOwnedSelection) nextNormal.delete(v)
        updates.normalSelection = nextNormal
        // Prune by the surviving queries rather than wiping wholesale, matching
        // syncChipSelection/clearChipSelection: an entry that outlives the
        // switch keeps the claim that names which primitive it is.
        updates.selectedPicks = prunePickClaims(state.selectedPicks, nextNormal)
        if (state.modeStack[state.modeStack.length - 1] === 'pick') {
          updates.modeStack = state.modeStack.slice(0, -1)
        }
      }
      // The domain is a pure function of normalSelection, so whichever branch
      // above rewrote it owes a fresh derivation. Doing it once here keeps the
      // two branches from each having to remember.
      if (updates.normalSelection !== undefined) {
        updates.selectionDomain = deriveSelectionDomain(updates.normalSelection as Set<string>)
      }
      return updates
    })

    // Activate new tool (lifecycle hook). Skipped when the field is kept, since
    // arming the drag tool would push a 'tool:drag' mode that conflicts with the
    // open pick field's 'pick' mode.
    if (!keepsPickField) {
      activateTool(get, tool)
    }

    if (devOnly || testMode) {
      validateWithRepair(get, set)
    }
  },

  setActiveFeatureId: (id) => {
    const state = get()
    // Leaving the sketch abandons any in-flight brep dimension gesture, same
    // as a tool switch. Runs outside the set updater below because it
    // dispatches a delete mutation (a side effect, and StrictMode must not
    // replay it).
    if (state.activeFeatureId !== null && id === null && state.pendingBrepProjectionIds.length > 0) {
      state.cancelBrepProjectionGesture()
    }
    // Leaving the sketch disarms the tool through its lifecycle hook rather than
    // by nulling the field below: a plain write strands the tool's `tool:<id>`
    // entry on the mode stack, and since the store outlives the editor mount the
    // leak accumulates over enter/exit cycles.
    if (state.activeFeatureId !== null && id === null) {
      deactivateTool(get, set, get().activeTool)
    }
    // Entering/exiting a sketch is never a continuation of a drag gesture (the
    // active feature does not change mid-drag), so any leftover drag/dragPending
    // here is stuck state from a lost gesture -- e.g. a load race that remounts
    // the DragPlane mid-press and loses its pointerup cleanup. Orbit is derived
    // as `!drag && !dragPending` (SceneController), so clearing it on every real
    // edit transition guarantees the camera re-enables the instant you press Edit.
    // Delegated to clearDragState rather than an inline field list so the reset
    // cannot drift from the canonical one when its field set grows.
    if (state.activeFeatureId !== id) {
      get().clearDragState()
    }
    // Leaving a feature retires its selection and hover. A sketch-scoped query
    // (entity:S1:l1) that outlives the sketch resolves against nothing:
    // deleteSelected filters on parts[1] === activeFeatureId (now null) so
    // Delete silently no-ops and, dispatching no mutation, does not even clear
    // the selection as a side effect; a stale hovered face normal could still
    // feed the "Normal to" context-menu item for a face that is gone.
    // Unconditional for the same reason the undo path routes through
    // resetTransientState: re-resolving every query against the new context on
    // each exit is worse than a clean slate. A null -> feature transition is
    // exempt: a selection made in part view before pressing Edit is a valid
    // carry-in.
    if (state.activeFeatureId !== null && state.activeFeatureId !== id) {
      get().clearSelectionAndHover()
    }
    set(state => {
      if (state.activeFeatureId !== null && id === null) {
        return { activeFeatureId: id, activeTool: null, drawPoints: [], drawHover: null, drawSnapRefs: [], activeOriginLocal: [0, 0] }
      }
      return { activeFeatureId: id }
    })
  },

  setEntityKindMap: (map) => set({ entityKindMap: map }),
  setConstructionEntityKeys: (keys) => set({ constructionEntityKeys: keys }),
  setFilletCornerMap: (map) => set({ filletCornerMap: map }),

  // Reflects the document origin in the active sketch's local frame. Published by
  // Geometry3D while its feature is being edited, and cleared back to [0,0] when
  // the sketch is left so a stale plane origin can never outlive its sketch.
  setActiveOriginLocal: (p) => set({ activeOriginLocal: p }),

  // Both hover setters return the state object untouched when nothing changes,
  // which makes zustand skip the notification entirely. Load-bearing for pointer
  // performance: every pointer move tears the hover down before applying the new
  // one, so without the guard each move woke every subscriber in the scene (and
  // clearAllBodyHover did it once per registered body) to re-deliver null.
  setHoveredVertex: (id, position, snapKind) => set(s => {
    const kind = snapKind ?? null
    if (s.hoveredVertexId === id && s.hoveredSnapKind === kind
      && samePoint(s.hoveredVertexPosition, position)) return s
    return { hoveredVertexId: id, hoveredVertexPosition: position, hoveredSnapKind: kind }
  }),
  setHoveredConstraintEntities: (ids) => set({ hoveredConstraintEntityIds: ids }),
  setHoveredFaceGeometry: (normal, center) => set(s => {
    if (samePoint(s.hoveredFaceNormal, normal) && samePoint(s.hoveredFaceCenter, center)) return s
    return { hoveredFaceNormal: normal, hoveredFaceCenter: center }
  }),

  applyConstraint: (kind) => {
    const { normalSelection: selection, activeFeatureId, entityKindMap } = get()
    const onMutation = requireMutation('applyConstraint')
    if (!onMutation) return null
    if (selection.size === 0 || !activeFeatureId) return null
    // A B-rep vertex/edge pick is a constraint operand too; it is projected
    // into the sketch below rather than dropped by the sketch-only filter.
    // `apply_projection` is the one exception: its own command is what authors
    // the held entity, so projecting a non-sketch operand first would leave a
    // source-less second projection.
    const projectableOperand = (t: string): { isVertex: boolean } | null => {
      if (kind === 'projection') return null
      return t === '@builtin_origin' ? { isVertex: true } : classifyBrepOperand(t)
    }
    const picked = [...selection].filter(t =>
      t.startsWith('entity:') || t.startsWith('vertex:') || t.startsWith('constraint:') || t.startsWith('@builtin_') || t.startsWith('dock:') || t.startsWith('isect:')
      || projectableOperand(t) !== null
    )
    if (picked.length === 0) return null

    // A constraint can only name sketch operands. The origin and a B-rep
    // vertex/edge are projected into the active sketch and the constraint names
    // the projection: the sketch keeps a visible, deletable entity instead of a
    // hidden external reference. The projected targets replace their operands
    // in place, so operand order survives (line_distance reads line first).
    const sketch = sketchCallbacks.getSketch?.(activeFeatureId) ?? null
    const recorded = sketchCallbacks.getProjectedSources?.(activeFeatureId) ?? undefined
    const planned: PlannedProjection[] = []
    const projections: ProjectedEntityMutation[] = []
    const kindByTarget = new Map<string, string>()
    const resolved = picked.map(t => {
      const brep = projectableOperand(t)
      if (brep === null) return t
      const plan = planProjectedOperand({
        query: t,
        featureId: activeFeatureId,
        sketch,
        recorded,
        pending: planned,
        isVertexPick: brep.isVertex,
        sourceKind: brep.isVertex ? null : sketchCallbacks.resolveEdgeKind?.(t) ?? null,
        newEntityId: () => randomId(12),
      })
      projections.push(...plan.mutations)
      planned.push(plan)
      kindByTarget.set(plan.target, plan.kind)
      return plan.target
    })

    // A projected target is not in entityKindMap yet; the plan's kind stands in
    // for the operator checks below.
    const kindOf = (target: string): string | undefined =>
      entityKindMap[target] ?? kindByTarget.get(target)

    // The redundancy probe and the mutation both see the canonical order, so a
    // point-first line_distance is tested (and stored) as line-first.
    const targets = canonicalLineDistanceTargets(kind, resolved, t => {
      if (t.startsWith('vertex:')) return 'point'
      if (!t.startsWith('entity:')) return undefined
      const ek = kindOf(t)
      return ek === 'line' ? 'line' : isPointLikeEntityKind(ek) ? 'point' : undefined
    })

    // Reject operand kinds the constraint cannot represent before authoring it.
    // A parallel between two arcs (or a concentric on a line) otherwise lands in
    // the doc as a constraint the solver can't satisfy and the canvas can't
    // render -- leaving it stuck and undeletable. The registry's
    // `entityKindGroups` is the single source of truth: every entity operand's
    // kind must fall in one common group. An unknown kind (not in entityKindMap
    // yet) is tolerated so this never blocks on a transient/empty map.
    const def = CONSTRAINT_BY_KIND.get(kind)
    const label = def?.label ?? kind
    if (def?.entityKindGroups) {
      const groups = def.entityKindGroups
      const kinds = targets
        .filter(t => t.startsWith('entity:'))
        .map(t => kindOf(t))
        .filter((k): k is string => k !== undefined)
      const allOk = groups.some(g => kinds.every(k => g.includes(k)))
      if (!allOk) {
        return `${label} cannot be applied to those entity kinds (${kinds.join(', ')}).`
      }
    }

    if (kind === 'horizontal' || kind === 'vertical') {
      if (targets.length === 1) {
        const entityTargets = targets.filter(t => t.startsWith('entity:'))
        if (entityTargets.length === 1) {
          const ek = kindOf(entityTargets[0])
          if (ek !== undefined && ek !== 'line') {
            return `${label} applies to a line; the selected entity is a ${ek}.`
          }
        }
      }
    }

    if (kind === 'midpoint') {
      const entityTargets = targets.filter(t => t.startsWith('entity:'))
      const vertexTargets = targets.filter(t => t.startsWith('vertex:'))
      const validLinePoint = entityTargets.length === 1 && vertexTargets.length === 1
      const validThreeVertex = vertexTargets.length === 3 && entityTargets.length === 0
      if (!validLinePoint && !validThreeVertex) {
        return 'Midpoint needs a line and a point, or three points.'
      }
    }

    // Refuse a constraint that would make the set redundant, the "this would
    // overconstrain" of most CAD. The port runs the real solver on a draft copy
    // (Part.tsx owns the doc and the probe), so no mutation is created when the
    // add is refused; existing redundancy in a document is a solve fact, not an
    // error, and is flagged there instead. The planned projections ride along as
    // a prelude, or the probe sees a target that does not exist yet.
    const pending: PendingConstraint = { featureId: activeFeatureId, kind, targets }
    if (projections.length > 0) pending.prelude = projections
    const verdict = sketchCallbacks.checkRedundantAdd?.(pending)
    if (verdict === true) return overconstrainReason(kind)
    // The probe drafted the prelude and the add together and found the add
    // would append nothing (a malformed operand set). Emit neither, or the
    // projection would be stranded without its constraint.
    if (verdict === null) return null

    const constraint: Mutation = { type: 'add_constraint', featureId: activeFeatureId, kind, targets }
    if (projections.length === 0) {
      onMutation(constraint)
    } else if (sketchCallbacks.onMutationBatch) {
      // Projection + constraint as one undo entry; a refused add above emitted
      // nothing, so no orphan projection is ever left in the sketch.
      sketchCallbacks.onMutationBatch([...projections, constraint])
    } else {
      // A headless port set without the batch seam: still one document act, two
      // history entries. The editor build always registers onMutationBatch.
      if (devOnly) console.warn('[editorState] applyConstraint: no onMutationBatch port; the projection and its constraint are two history entries.')
      for (const m of projections) onMutation(m)
      onMutation(constraint)
    }
    return null
  },

  // Offset the selected sketch entities by a signed distance. Each selected
  // entity is cloned and tied to its source by an `offset` constraint (lowered
  // to parallel/concentric + distance before solving). Negative = inward/other
  // side. A no-op when nothing solvable is selected.
  applyOffset: (distance) => {
    const { normalSelection: selection, activeFeatureId } = get()
    const onMutation = requireMutation('applyOffset')
    if (!onMutation) return
    if (selection.size === 0 || !activeFeatureId) return
    const sourceIds = [...selection]
      .filter(t => t.startsWith('entity:') && t.split(':')[1] === activeFeatureId)
      .map(t => t.split(':')[2])
    if (sourceIds.length === 0) return
    onMutation({ type: 'apply_offset', featureId: activeFeatureId, sourceIds, distance })
  },

  // Mirror the selected sketch entities across the one selected line, as
  // authored geometry (one mutation, sources and axis decided by
  // mirrorSelectionPlan). Returns the human-readable reason when the selection
  // cannot carry the mirror; null when it was authored or there was nothing
  // to act on, exactly as applyConstraint spells it.
  mirrorSelection: () => {
    const { normalSelection: selection, activeFeatureId, entityKindMap, constructionEntityKeys } = get()
    const plan = mirrorSelectionPlan(selection, activeFeatureId, entityKindMap, constructionEntityKeys)
    if ('reason' in plan) return plan.reason
    const onMutation = requireMutation('mirrorSelection')
    if (!onMutation) return null
    onMutation({ type: 'mirror_entities', featureId: activeFeatureId!, sourceIds: plan.sourceIds, line: plan.axis })
    return null
  },

  // Pattern the selection along +X in one mutation, so the whole row is one
  // undo entry. The other modes are drive-first; this is the dialog's linear
  // case. Returns the reason the selection cannot carry it, or null.
  patternEntities: (count, pitch) => {
    const { normalSelection: selection, activeFeatureId } = get()
    const plan = patternSelectionPlan(selection, activeFeatureId)
    if ('reason' in plan) return plan.reason
    const onMutation = requireMutation('patternEntities')
    if (!onMutation) return null
    onMutation({
      type: 'pattern_entities', featureId: activeFeatureId!, sourceIds: plan.sourceIds,
      mode: 'linear', count, pitch,
    })
    return null
  },

  // Fillet every selected corner in one mutation, so a four-corner rectangle is
  // one undo entry. Returns the human-readable reason when the selection cannot
  // carry the fillet; null when it was authored or there was nothing to act on.
  filletCorners: (radius) => {
    const { normalSelection: selection, activeFeatureId, filletCornerMap } = get()
    const plan = filletSelectionPlan(selection, activeFeatureId, filletCornerMap)
    if ('reason' in plan) return plan.reason
    const onMutation = requireMutation('filletCorners')
    if (!onMutation) return null
    onMutation({ type: 'fillet_corners', featureId: activeFeatureId!, radius, corners: plan.corners })
    return null
  },

  toggleConstruction: () => {
    const { normalSelection: selection } = get()
    const onMutation = requireMutation('toggleConstruction')
    if (!onMutation) return
    if (selection.size === 0) return
    const targets = [...selection].filter(t => t.startsWith('entity:'))
    if (targets.length === 0) return
    onMutation({ type: 'toggle_construction', targets })
  },

  deleteSelected: () => {
    const { normalSelection: selection, activeFeatureId } = get()
    const onMutation = requireMutation('deleteSelected')
    if (!onMutation) return
    if (selection.size === 0) return
    const targets = sketchOwnedDeleteTargets(selection, activeFeatureId)
    if (targets.length === 0) return
    onMutation({ type: 'delete', targets })
    get().clearSelectionAfterDelete()
  },

  addDrawPoint: (pt) => set(s => ({ drawPoints: [...s.drawPoints, pt] })),
  setDrawPoints: (pts) => set({ drawPoints: pts }),
  setDrawHover: (pt) => set({ drawHover: pt }),
  setDrawSnap: (refs) => set({ drawSnapRefs: refs }),
  clearDraw: () => {
    set({ drawPoints: [], drawHover: null, drawSnapRefs: [] })
    if (devOnly || testMode) {
      validateWithRepair(get, set)
    }
  },

  finishDraw: () => {
    const { activeTool, activeFeatureId, drawPoints, drawSnapRefs } = get()
    if (!activeTool || !activeFeatureId) return false
    const result = computeDrawFinish(activeTool, drawPoints, drawSnapRefs, activeFeatureId, () => randomId(12))
    // The same commit path a click-built gesture takes: one undo batch, the
    // buffer reset, and the tool's own arming policy.
    return commitDrawGesture(result, {
      onMutation: sketchCallbacks.onMutation,
      onMutationBatch: sketchCallbacks.onMutationBatch,
      clearDraw: get().clearDraw,
      disarm: () => get().setActiveTool(null),
      staysArmedAfterCommit: getToolPickConfig(activeTool).staysArmedAfterCommit,
    }, '[editorState] finishDraw')
  },

  addDimensionPick: (pick: DimensionPick) => {
    const { dimensionPicks, activeFeatureId, pendingBrepProjectionIds } = get()
    // Cap at 2 picks: a third entity click replaces the second (lets the user
    // swap their second pick without restarting the gesture).
    const next = dimensionPicks.length >= 2
      ? [dimensionPicks[0], pick]
      : [...dimensionPicks, pick]

    // Replacing the second pick orphans the projection that pick materialised
    // on the sketch: delete it with no undo entry so neither the projection
    // nor its cleanup survives in the history. Only a projection THIS gesture
    // created is eligible -- a pick that reused a projection a committed
    // dimension already owns (the reuse path emits no mutation, so it never
    // joined pendingBrepProjectionIds) must not be deleted, or the committed
    // constraint dangles.
    if (dimensionPicks.length >= 2 && activeFeatureId) {
      const replaced = dimensionPicks[1]
      const eid = pickProjectionEntityId(replaced, activeFeatureId)
      if (eid && pendingBrepProjectionIds.includes(eid)) {
        dispatchWithheldDelete([`entity:${activeFeatureId}:${eid}`])
        set({ pendingBrepProjectionIds: pendingBrepProjectionIds.filter(id => id !== eid) })
      }
    }
    set({ dimensionPicks: next })
  },

  // A dimension constraint can only name sketch elements, so a body edge or
  // vertex picked with the dimension tool is projected into the active sketch
  // first and the pick targets that projection.
  addBrepDimensionPick: (query, { isVertexPick, sourceKind }) => {
    const { activeFeatureId, dimensionPicks } = get()
    if (!activeFeatureId) return
    const onMutation = requireMutation('addBrepDimensionPick')
    if (!onMutation) return
    const sketch = sketchCallbacks.getSketch?.(activeFeatureId) ?? null
    const { mutations, pick } = planBrepDimensionPick({
      query,
      featureId: activeFeatureId,
      sketch,
      picks: dimensionPicks,
      isVertexPick,
      sourceKind,
      newEntityId: () => randomId(12),
    })
    if (mutations.length > 0) {
      // A new projection: its undo entry waits for the dimension commit (or a
      // compensating delete on cancel), so pick and commit read as one step.
      sketchCallbacks.beginBrepProjection?.()
      for (const m of mutations) onMutation(m)
      const newIds: string[] = []
      for (const m of mutations) {
        if (m.type === 'add_projected_entity' && m.entityId) newIds.push(m.entityId)
      }
      if (newIds.length > 0) {
        set({ pendingBrepProjectionIds: [...get().pendingBrepProjectionIds, ...newIds] })
      }
    }
    get().addDimensionPick(pick)
  },

  clearDimensionPicks: () => set({ dimensionPicks: [] }),

  cancelBrepProjectionGesture: () => {
    const { pendingBrepProjectionIds, activeFeatureId } = get()
    const targets = activeFeatureId
      ? pendingBrepProjectionIds.map(id => `entity:${activeFeatureId}:${id}`)
      : []
    // The delete is withheld so the aborted gesture leaves neither the
    // projections nor the cleanup in the undo history.
    dispatchWithheldDelete(targets)
    // The gesture is over for real: null the withhold's captured doc too, or a
    // dimension committed later would restore a stale pre-gesture world.
    sketchCallbacks.cancelBrepProjection?.()
    // The value prompt this gesture opened must not outlive it. This is the one
    // funnel every abort already goes through -- a tool switch, leaving the
    // sketch, arming a pick field -- and each of them just deleted the
    // projections the prompt was measuring, so a prompt that survived would let
    // Enter commit an add_constraint naming an entity the doc no longer has
    // (dangling, and flagged unresolved by the solver). Closed without running
    // its onCancel: this action IS that cancel for the dimension dialog, and
    // re-entering it from here would dispatch the withheld delete twice. The
    // other producers (apply_offset, the feature-handle value editor, a dim
    // label's edit prompt) own no gesture state to unwind, so dropping the
    // prompt whole is all they need. The port is optional by design: a headless
    // abort with no dialog open is a no-op, not a fault.
    sketchCallbacks.closeDialog?.()
    set({ pendingBrepProjectionIds: [] })
  },

  // Drops the brep gesture bookkeeping without touching the doc: used where the
  // doc is already being replaced (undo), so a compensating delete would only
  // chase entities that are already gone.
  clearBrepProjectionState: () => {
    sketchCallbacks.cancelBrepProjection?.()
    set({ pendingBrepProjectionIds: [] })
  },

  setDimensionCursorWorld: (p) => set({ dimensionCursorWorld: p }),

  finalizeDimensionPlacement: (clientPos) => {
    const { activeFeatureId, dimensionCursorWorld } = get()
    if (!activeFeatureId || get().dimensionPicks.length === 0) return
    const sketch = sketchCallbacks.getSketch?.(activeFeatureId) ?? null
    // A projection picked before its solve landed carries the kind it was
    // declared with, which the lowerer may since have promoted (tilted circle
    // -> ellipse). Take the solved kind so the dim resolves against the real
    // geometry.
    const dimensionPicks = refreshProjectedPickKinds(get().dimensionPicks, sketch, activeFeatureId)
    const resolved = resolveDimension(dimensionPicks, sketch ?? undefined, activeFeatureId)
    if (!resolved) {
      // Vertex-only or otherwise undimensionable: silently drop and let the
      // user keep picking. Do not deactivate the tool.
      return
    }
    const onMutation = requireMutation('finalizeDimensionPlacement')
    if (!onMutation) return
    const featureId = activeFeatureId
    let constraintKind = resolved.constraintKind
    // Canonicalise before the natural value, the sign and the placement all
    // read the render: a point-first line_distance otherwise resolved no value
    // at all. Two-line picks keep their order.
    const pickKinds = new Map(dimensionPicks.map(p => [p.target, p.entityKind ?? undefined]))
    // The dim self-deduplicates if a same entity was clicked twice.
    const targets = canonicalLineDistanceTargets(
      constraintKind,
      dimensionTargets(dimensionPicks),
      t => {
        if (t.startsWith('vertex:') || t === '@builtin_origin') return 'point'
        const ek = pickKinds.get(t)
        return ek === 'line' ? 'line' : isPointLikeEntityKind(ek) ? 'point' : undefined
      },
    )

    // Snapshot the placement anchor BEFORE clearing -- the cursorWorld field
    // is cleared on tool exit but we want the dispatched pos to point at where
    // the click happened, not at a later cursor position.
    const placementWorld = dimensionCursorWorld

    // Two-vertex point_distance dims: detect the user's drag direction from
    // the placement point and switch the constraint kind accordingly.
    //   - vertical drag (up/down)  → point_distance_x (horizontal measurement)
    //   - horizontal drag (left/right) → point_distance_y (vertical measurement)
    //   - balanced / no drag → point_distance (euclidean distance)
    // Once placed the type stays (future label drags only move `pos`).
    if (constraintKind === 'point_distance' && placementWorld && sketch && targets.length >= 2) {
      const pts = resolveDimPoints(constraintKind, targets, sketch, featureId)
      if (pts) {
        const [pa, pb] = pts
        const anchorX = (pa[0] + pb[0]) / 2
        const anchorY = (pa[1] + pb[1]) / 2
        const ox = placementWorld[0] - anchorX
        const oy = placementWorld[1] - anchorY
        if (Math.abs(oy) > Math.abs(ox) && Math.abs(oy) > 0.001) {
          constraintKind = 'point_distance_x'
        } else if (Math.abs(ox) > Math.abs(oy) && Math.abs(ox) > 0.001) {
          constraintKind = 'point_distance_y'
        }
      }
    }

    // Clear picks immediately so the next pointer event can't double-fire the
    // dialog, but stay in the dimension tool until OK / Cancel resolves.
    set({ dimensionPicks: [], dimensionCursorWorld: null })

    // Pre-fill the dialog with the current measured value so Enter accepts
    // it unchanged. Falls back to empty when the sketch isn't available
    // (e.g. tests without getSketch registered) or the geometry can't be
    // resolved.
    const naturalValue = sketch
      ? computeNaturalDimensionValue(constraintKind, targets, sketch, featureId)
      : null
    // An angle label placed in a supplement quadrant shows (and edits against)
    // 180 - theta. The constraint still stores theta, but the dialog must
    // pre-fill and commit the displayed supplement so the prompt matches the
    // live preview label. The transform is its own inverse (used both to
    // display and to encode back). Mirrors AngleDimension's encodeValue hook.
    const isSupplement = (constraintKind === 'angle' && sketch)
      ? computeAnglePlacementIsSupplement(targets, sketch, featureId, placementWorld)
      : false
    const toDisplay = (v: number) => isSupplement ? 180 - v : v
    const displayedNatural = naturalValue !== null ? toDisplay(naturalValue) : null
    const defaultValue = displayedNatural !== null
      ? (Number.isInteger(displayedNatural) ? String(displayedNatural) : displayedNatural.toFixed(2))
      : undefined

    // The value dialog is UI store state; the port is registered by
    // stores/sketchEditorStore.ts, the module that owns it.
    openDialogOrFail({
      position: clientPos,
      label: 'Dimension value',
      defaultValue,
      // Cancelling the value dialog abandons the gesture: the projections it
      // materialised were scratch work and are removed with no undo entries.
      onCancel: () => get().cancelBrepProjectionGesture(),
      // A plain number, not an expression: onConfirm commits parseFloat.
      validate: (input) => {
        const val = parseFloat(input)
        if (isNaN(val)) return refusalText('Value', cannotEvaluate(input))
        // The rule follows the dimension kind: zero is a real constraint for
        // the axis distances and the radial gap, and a coincident hint for a
        // euclidean point_distance.
        const rule = isConstraintKindName(constraintKind) ? dimensionValueRule(constraintKind) : positive
        return refusalText('Value', rule(val))
      },
      onConfirm: (input) => {
        // Accepting the rounded default unchanged commits the exact measured
        // value, so an already-satisfied dimension is not nudged by the
        // display rounding. Any edit commits the typed value.
        // The displayed (supplement-adjusted) value is encoded back to the
        // stored theta via the self-inverse 180 - v before commit.
        const value = (naturalValue !== null && input === defaultValue)
          ? naturalValue
          : toDisplay(parseFloat(input))
        // The pos written by the placement click anchors the dim label where
        // the user clicked instead of the renderer's default offset. Compute
        // it relative to the dim's natural anchor so the LinearDimension /
        // RadiusDimension / DiameterDimension / AngleDimension components,
        // which interpret pos as an anchor-relative offset, render it at the
        // requested world point.
        const pos = (placementWorld && sketch)
          ? computeAnchorRelativePos(constraintKind, targets, sketch, featureId, placementWorld)
          : null
        // Pin the side/handedness the user drew so the solver cannot mirror the
        // geometry to the other (equally valid) solution. Directional dims only;
        // null for length/radius/diameter/euclidean distance.
        const sign = sketch
          ? computeDimensionSign(constraintKind, targets, sketch, featureId)
          : null
        // The same authoring gate applyConstraint runs, now with the value the
        // dialog collected: without it a duplicate dimension could never be
        // seen (a value-less dimension contributes no solver rows), and the
        // dimension tool would be the one door around the refusal. The reason
        // rides the same cannot-apply message as a command rejection, and the
        // gesture's projections are scratch work, so a refusal cleans them up
        // like any other abort instead of leaving them in the doc.
        // A zero euclidean distance asks for two coincident points: the one
        // row has no direction there and would remove no degree of freedom.
        // The dialog's validate already refuses it with the coincident hint;
        // this is the belt for a confirm path that bypasses the shell. The
        // gesture's projections are scratch work and are cleaned up like any
        // other aborted authoring.
        const zeroProblem = isConstraintKindName(constraintKind)
          ? pointDistanceZeroProblem(constraintKind, value)
          : null
        if (zeroProblem !== null) {
          sketchCallbacks.showMessage?.({
            title: CANNOT_APPLY_TITLE,
            message: zeroProblem,
            variant: 'error',
          })
          get().cancelBrepProjectionGesture()
          return
        }
        const pending: PendingConstraint = {
          featureId, kind: constraintKind, targets, value,
          ...(pos && { pos }),
          ...(sign !== null && { sign }),
        }
        const verdict = sketchCallbacks.checkRedundantAdd?.(pending)
        if (verdict === true) {
          sketchCallbacks.showMessage?.({
            title: CANNOT_APPLY_TITLE,
            message: overconstrainReason(constraintKind),
            variant: 'error',
          })
          get().cancelBrepProjectionGesture()
          return
        }
        // The probe found the add would append nothing: drop the gesture (and
        // its scratch projections) without authoring a dead constraint.
        if (verdict === null) {
          get().cancelBrepProjectionGesture()
          return
        }
        onMutation({
          type: 'add_constraint',
          featureId, kind: constraintKind, targets, value,
          ...(pos && { pos }),
          ...(sign !== null && { sign }),
        })
        // The projections are now part of the committed dimension, so nothing
        // is pending cleanup any more; the withhold was consumed by the
        // constraint's undo push.
        get().clearBrepProjectionState()
        // The dimension tool stays armed so the user can place several dims
        // without re-pressing 'd'. They exit explicitly (Escape / different
        // tool / tool button), matching standard CAD behaviour.
      },
    })
  },

  setActivePickField: (field) => {
    // Leaving any prior pick: drop its mode and chip-owned mirror. The field is
    // cleared before the pop for the same reason deactivateTool clears the tool:
    // popMode revalidates on an empty stack and an armed pick field with no
    // 'pick' entry is a violation. The chip mirror is cleared before the pop
    // too: repair runs when the stack empties, and it must see a consistent
    // state instead of a transient chip-owned set it would prune with a
    // spurious set().
    const prev = get().activePickField
    if (prev !== null) {
      set({ activePickField: null })
      get().clearChipSelection()
      if (get().modeStack[get().modeStack.length - 1] === 'pick') {
        get().popMode('pick')
      }
    }

    if (field === null) {
      set({ activePickField: null })
      if (devOnly || testMode) validateWithRepair(get, set)
      return
    }

    // Entering a pick abandons any in-flight brep dimension gesture, same as a
    // tool switch: the projections it materialised were scratch work for that
    // gesture, and leaving them armed would let the next unrelated mutation be
    // swallowed as "the projection". Cancel it before deactivating the tool so
    // the pending bookkeeping is empty when popMode re-validates the store.
    if (get().pendingBrepProjectionIds.length > 0) {
      get().cancelBrepProjectionGesture()
    }

    // Entering a pick: deactivate any active tool first. Unguarded, like every
    // other deactivate path: an armed tool always owns the top of the stack (the
    // invariant says so), and a desync is a bug we want popMode to report rather
    // than skip silently.
    deactivateTool(get, set, get().activeTool)

    // Activating a pick field clears the existing normal selection so a stray
    // prior selection is not instantly consumed as a pick.
    set({
      activePickField: field,
      activeTool: null,
      drawPoints: [],
      drawHover: null,
      drawSnapRefs: [],
      normalSelection: new Set<string>(),
      selectedPicks: new Map<string, Set<string>>(),
      chipOwnedSelection: new Set<string>(),
      selectionDomain: 'sketch_2d' as SelectionDomain,
    })
    get().pushMode('pick')

    if (devOnly || testMode) {
      validateWithRepair(get, set)
    }
  },

  syncChipSelection: (values) => {
    const s = get()
    const nextOwned = new Set(values)
    // Bail if the set hasn't changed to avoid infinite re-render loops when
    // callers pass a fresh array reference each render. This deliberately
    // compares only against chipOwnedSelection: a chip-owned id missing from
    // normalSelection is the re-click toggle-off signal, and the chip's sync
    // effect runs before its host's consumer effect, so healing it here would
    // erase the signal before usePickField ever sees it.
    if (s.chipOwnedSelection.size === nextOwned.size
        && [...s.chipOwnedSelection].every(v => nextOwned.has(v))) {
      return
    }
    const next = new Set(s.normalSelection)
    for (const v of s.chipOwnedSelection) {
      if (!nextOwned.has(v)) next.delete(v)
    }
    for (const v of nextOwned) next.add(v)
    set({
      normalSelection: next,
      chipOwnedSelection: nextOwned,
      selectedPicks: prunePickClaims(s.selectedPicks, next),
      selectionDomain: deriveSelectionDomain(next),
    })
  },

  clearChipSelection: () => {
    const s = get()
    if (s.chipOwnedSelection.size === 0) return
    const next = new Set(s.normalSelection)
    for (const v of s.chipOwnedSelection) next.delete(v)
    set({
      normalSelection: next,
      chipOwnedSelection: new Set(),
      selectedPicks: prunePickClaims(s.selectedPicks, next),
      selectionDomain: deriveSelectionDomain(next),
    })
  },

  // ─── Part FSM + derived viewport state ───

  setRollbackPosition: (pos) => set({ rollbackPosition: pos }),
  setPickBoundary: (pos) => set({ pickBoundary: pos }),
  setEditingFeatureId: (id) => set({ editingFeatureId: id }),
  setViewportDerived: ({ ghostMode, partColors, partStyle }) => set({ ghostMode, partColors, partStyle }),
  setActiveSketchFeatureId: (id) => set({ activeSketchFeatureId: id }),

  restoreHistory: (doc) => {
    // The restored doc is the authority: clamp the bar to its feature list and
    // bring the editor the move consumed down (the undo path used to write
    // these three fields from the adapter; the store owns them now).
    set({
      rollbackPosition: clampRollback(doc),
      pickBoundary: null,
      editingFeatureId: null,
    })
  },

  resetEditorState: () => set({ ...DEFAULT_EDITOR_STATE }),
}))
