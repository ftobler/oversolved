// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import { create } from 'zustand'
import type { ActiveTool, Mutation, SelectionDomain, Sketch } from '@/types/cad'
import type { SnapKind } from '@/registry'
import type { DimensionPick } from '@/registry'
import { resolveDimension, dimensionTargets, CONSTRAINT_BY_KIND } from '@/registry'
import { computeNaturalDimensionValue, computeAnchorRelativePos, resolveDimPoints, computeDimensionSign, computeAnglePlacementIsSupplement } from '@/utils/geometry/dimensionNaturalValue'
import type { SnapTarget } from '@/components/Geometry3D/snapDetection'
import { validateSketchEditorState, failLoud, repairSelectionState, devOnly, testMode, deriveSelectionDomain } from './stateInvariants'
import { toolRegistry } from '@/registry/toolRegistry'
import type { ToolId, ToolContext } from '@/registry/toolRegistry'
import { getToolPickConfig } from '@/registry/toolPickConfig'
import { planBrepDimensionPick, refreshProjectedPickKinds } from '@/tools/dimensionProjection'
import { randomId } from '@/utils/yamlMutations/helpers'

// Callbacks dispatched from pure-layer store actions back into React state.
// Registered by Part.tsx on mount via setSketchCallback(); torn down on unmount.
// Stored outside Zustand so function references don't pollute serializable snapshots.
// Invariant: onMutation/onRebuild/onExitSketch must be non-null while a sketch
// editing session is active; the remaining slots are optional hooks.
const _sketchCbs: {
  onMutation: ((m: Mutation) => void) | null
  onMutationBatch: ((ms: Mutation[]) => void) | null
  onRebuild: (() => void) | null
  onExitSketch: (() => void) | null
  getSketch: ((featureId: string) => Sketch | null) | null
  beginBrepProjection: (() => void) | null
  cancelBrepProjection: (() => void) | null
} = {
  onMutation: null,
  onMutationBatch: null,
  onRebuild: null,
  onExitSketch: null,
  getSketch: null,
  beginBrepProjection: null,
  cancelBrepProjection: null,
}

export function setSketchCallback(key: 'onMutation', cb: ((m: Mutation) => void) | null): void
export function setSketchCallback(key: 'onMutationBatch', cb: ((ms: Mutation[]) => void) | null): void
export function setSketchCallback(key: 'onRebuild' | 'onExitSketch', cb: (() => void) | null): void
export function setSketchCallback(key: 'getSketch', cb: ((featureId: string) => Sketch | null) | null): void
export function setSketchCallback(key: 'beginBrepProjection' | 'cancelBrepProjection', cb: (() => void) | null): void
export function setSketchCallback(key: keyof typeof _sketchCbs, cb: unknown): void {
  (_sketchCbs as Record<string, unknown>)[key] = cb
}

export function getSketchCallback<K extends keyof typeof _sketchCbs>(key: K): (typeof _sketchCbs)[K] {
  return _sketchCbs[key]
}

/** Coordinate-wise equality for the small tuples the hover setters carry, so a
 *  freshly built tuple holding the same numbers counts as "unchanged". */
function samePoint(a: readonly number[] | null, b: readonly number[] | null): boolean {
  if (a === b) return true
  if (a === null || b === null || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function requireMutation(name: string): ((m: Mutation) => void) | null {
  const onMutation = _sketchCbs.onMutation
  if (!onMutation) {
    if (devOnly) console.warn(`[sketchEditorStore] onMutation: callback not registered — ${name} will be a no-op.`)
  }
  return onMutation
}

// Deletes the given sketch entities with no undo entry. Used when a dimension
// gesture is aborted or a pick replaced: the projection was scratch work, so
// neither it nor the delete that removes it may appear in the history. The
// delete rides the brep withhold so it applies without pushing. No trailing
// cancelBrepProjection here: the replace path needs the withhold's captured doc
// to survive for the gesture's eventual commit, and the abort path nulls it
// explicitly after this returns.
function dispatchWithheldDelete(targets: string[]): void {
  const onMutation = _sketchCbs.onMutation
  if (!onMutation || targets.length === 0) return
  _sketchCbs.beginBrepProjection?.()
  onMutation({ type: 'delete', targets })
}

// Entity id of the projection a brep pick targets, from its wire target
// ('entity:<fid>:<eid>' or 'vertex:<fid>:<eid>:xy'). Only a brep pick carries
// the source query, which is what distinguishes it from a plain sketch pick.
function pickProjectionEntityId(pick: DimensionPick, featureId: string): string | null {
  if (!pick.source) return null
  const parts = pick.target.split(':')
  if (parts[1] !== featureId) return null
  if (parts[0] !== 'entity' && parts[0] !== 'vertex') return null
  return parts[2] ?? null
}

function validateWithRepair(get: () => SketchEditorState, set: (p: Partial<SketchEditorState>) => void): void {
  const state = get()
  const patches = repairSelectionState(state)
  if (patches) {
    set(patches)
    const repaired = get()
    validateSketchEditorState(repaired)
  } else {
    validateSketchEditorState(state)
  }
}

// A pickKey claim only means anything while its query is still selected. Chip
// diffs evict queries wholesale, so the claims they leave behind must go with
// them or they resurrect as ghost highlights the next time the query is picked.
// Returns the original map when nothing was pruned so subscribers stay put.
function prunePickClaims(picks: Map<string, Set<string>>, live: ReadonlySet<string>): Map<string, Set<string>> {
  let pruned: Map<string, Set<string>> | null = null
  for (const q of picks.keys()) {
    if (live.has(q)) continue
    if (pruned === null) pruned = new Map(picks)
    pruned.delete(q)
  }
  return pruned ?? picks
}

export const getEffectiveTool = (activeTool: ActiveTool): NonNullable<ActiveTool> => activeTool ?? 'drag'

export interface DialogState {
  position: [number, number]
  label: string
  defaultValue?: string
  onConfirm: (val: string) => void
  onCancel?: () => void
  // Return an error message to reject the input (dialog stays open and shows
  // it); return null to accept. Omit to accept any input.
  validate?: (val: string) => string | null
  // Optional secondary action rendered as an extra button (e.g. "Flip side" on
  // a directional dimension). Runs its handler and closes the dialog; it does
  // not go through `validate`/`onConfirm`.
  extraAction?: { label: string; onClick: () => void }
}

// Dragging a geometry vertex or whole edge.
export interface VertexOrEdgeDrag {
  type: 'vertex' | 'edge'
  vertexId: string  // full composite ID (entity ID for edge drags)
  featureId: string
  entityId: string
  vertexKey: string  // "start" | "end" | "center" | "xy" | "edge"
  startWorld: [number, number]
  currentWorld: [number, number]
  startClient: [number, number]  // screen coordinates at pointer-down (for click-vs-drag distinction)
}

// Dragging a dimension label to reposition it.
export interface DimLabelDrag {
  type: 'dim_label'
  constraintId: string
  featureId: string
  // World-space anchor for the label (midpoint of measured points, center, or vertex).
  anchorWorld: [number, number]
  startWorld: [number, number]
  currentWorld: [number, number]
}

// Dragging a feature editing handle (extrude/fillet/revolve arrow). Unlike the
// sketch drags this lives in world space: the cursor ray is mapped onto the
// handle's 3D axis and the travel converted to a field value via unitScale.
export interface FeatureHandleDrag {
  type: 'feature_handle'
  featureId: string
  field: string
  startValue: number
  currentValue: number
  axisOrigin: [number, number, number]  // world anchor at startValue
  axisDir: [number, number, number]  // unit world drag direction
  unitScale: number  // world units per field unit
  min: number
  max?: number
}

export type DragState = VertexOrEdgeDrag | DimLabelDrag | FeatureHandleDrag

export interface EdgeVertexDragPending {
  type: 'edge' | 'vertex'
  vertexId: string
  featureId: string
  entityId: string
  vertexKey: string
  startWorld: [number, number]
}

export interface DimLabelDragPending {
  type: 'dim_label'
  constraintId: string
  featureId: string
  anchorWorld: [number, number]
  startWorld: [number, number]
}

export interface FeatureHandleDragPending {
  type: 'feature_handle'
  featureId: string
  field: string
  startValue: number
  axisOrigin: [number, number, number]
  axisDir: [number, number, number]
  unitScale: number
  min: number
  max?: number
}

export type DragPendingState = EdgeVertexDragPending | DimLabelDragPending | FeatureHandleDragPending

// The single, store-owned pick-field coordinator (Layer 2 of the selection
// model). When non-null, exactly one feature field is consuming picks. There
// is no parallel plane-pick path: plane selection is just a field like any
// other. See feature/selection-unification.md.
export interface ActivePickField {
  featureId: string
  field: string
  multi?: boolean
}

interface SketchEditorState {
   // SELECTION SUBSYSTEM
  // Hovered selection, always reflects what entity/face/plane is directly under cursor.
  hoveredSelectionId: string | null
  // Per-primitive pick key of the hovered b-rep primitive (bodyKey#layer#index).
  // Set alongside hoveredSelectionId for edges so hover highlight can isolate the
  // single primitive under the cursor even when its query string is not unique.
  hoveredPickKey: string | null
  // Normal selection, traditional selection, persists until explicitly changed.
  // Query-keyed: the durable/ancestral identity every consumer reads.
  normalSelection: Set<string>
  // Live per-primitive refinement of the b-rep selection: query -> the SET of
  // pickKeys (bodyKey#layer#index) selected under that query. A click records
  // the exact primitive's pickKey here alongside its query in normalSelection,
  // so the viewport highlight isolates the primitives actually clicked even when
  // several of them share a query.
  //
  // A set, not a single key: a query is a many-to-one durable identity (two
  // primitives that earned no construction UUID legitimately share one), so a
  // single key per query made the query the de-facto selection identity and let
  // a second click on a colliding sibling evict the first. Grouping by query
  // still keeps the claims tied to their durable entry, so toggling a query off
  // drops every claim under it and no stale sibling key survives an off/on cycle.
  // Transient: unlike normalSelection it is not persisted and is empty after a
  // re-solve, where the query-keyed fallback takes over (see computeHighlight).
  // Cleared whenever the normal selection is cleared/reset.
  selectedPicks: Map<string, Set<string>>
  // Derived domain of the current normal selection.
  selectionDomain: SelectionDomain
  isPointerDown: boolean
  setHoveredSelectionId: (id: string | null) => void
  setHoveredPickKey: (key: string | null) => void
  setIsPointerDown: (down: boolean) => void
  clearNormalSelection: () => void
  // Reset every transient interaction field to its create() default, leaving
  // user preferences (showDebugHit, showConstraintTiles, ngonSides,
  // entityKindMap) intact. Called from Part's unmount cleanup: the store is
  // module-level and survives a remount, so a new document would otherwise
  // inherit the previous one's picks, drags, and modes. Deliberately a plain
  // set, not the validation-running actions: it tears down a half-open state,
  // and validating that state would failLoud on the inconsistency being cleared.
  resetTransientState: () => void
  // `pickKey` refines the b-rep highlight to a single primitive; omit it for
  // selections with no per-primitive identity (sketch entities, planes).
  toggleNormalSelection: (id: string, pickKey?: string) => void
  addToNormalSelection: (id: string) => void

  // HOVER STATE
  // Vertex-specific hover data (for snap / visual highlight).
  hoveredVertexId: string | null
  hoveredVertexPosition: [number, number] | null
  hoveredSnapKind: SnapKind | null
  // Constraint tile hover, highlights related entities/vertices.
  hoveredConstraintEntityIds: Set<string>
  // Face geometry for the "Normal to" context menu entry.
  hoveredFaceNormal: [number, number, number] | null
  hoveredFaceCenter: [number, number, number] | null
  setHoveredVertex: (id: string | null, position: [number, number] | null, snapKind?: SnapKind | null) => void
  setHoveredConstraintEntities: (ids: Set<string>) => void
  setHoveredFaceGeometry: (normal: [number, number, number] | null, center: [number, number, number] | null) => void

  // DRAG TOOL STATE
  drag: DragState | null
  dragStartClient: [number, number] | null  // screen coordinates at pointer-down, before drag initiated (for lazy initiation)
  dragPending: DragPendingState | null  // pending drag info from onPointerDown, used for lazy initiation
  dragSnap: SnapTarget | null
  alignmentSnapPoint: [number, number] | null
  alignmentSnapKind: 'kinda_horizontal' | 'kinda_vertical' | null
  alignmentSnapVertexId: string | null
  setDrag: (drag: DragState | null) => void
  setDragStartClient: (pos: [number, number] | null) => void
  setDragPending: (pending: DragPendingState | null) => void
  setDragSnap: (snap: SnapTarget | null) => void
  setAlignmentSnap: (point: [number, number] | null, kind: 'kinda_horizontal' | 'kinda_vertical' | null, vertexId: string | null) => void

  // DRAW TOOL STATE
  drawPoints: [number, number][]
  drawHover: [number, number] | null
  drawSnapVertexId: string | null
  addDrawPoint: (pt: [number, number]) => void
  setDrawPoints: (pts: [number, number][]) => void
  setDrawHover: (pt: [number, number] | null) => void
  setDrawSnap: (vertexId: string | null) => void
  clearDraw: () => void

  // NAVIGATION SUBSYSTEM
  isRotating: boolean
  setIsRotating: (rotating: boolean) => void

  // MODE STACK, tracks nested editor modes; must be empty when returning to "main"
  modeStack: string[]
  pushMode: (kind: string) => void
  popMode: (expectedKind?: string) => void

  // TOOL / SESSION STATE
  activeTool: ActiveTool
  activeFeatureId: string | null
  showDebugHit: boolean
  showConstraintTiles: boolean
  ngonSides: number  // side count for the two-click n-gon draw tool
  entityKindMap: Record<string, string>
  // Sticky-placement state: the picks the user has made inside the active
  // dimension-tool gesture. Empty until the first click, cleared on tool exit
  // or after the placement dialog closes.
  dimensionPicks: DimensionPick[]
  // Entity ids of projections this dimension gesture created on the active
  // sketch, so an aborted gesture or a replaced pick can delete them without
  // leaving orphans in the doc or the undo history.
  pendingBrepProjectionIds: string[]
  // Abandons the brep dimension gesture: deletes every projection it created
  // (withheld, so no undo entries) and drops the pick/commit pair. Used when
  // the gesture ends without a commit (dialog cancel, tool switch, sketch exit).
  cancelBrepProjectionGesture: () => void
  // Drops the brep gesture bookkeeping without touching the doc. Used where the
  // doc is already being replaced (undo), so no compensating delete is wanted.
  clearBrepProjectionState: () => void
  // Latest cursor position in sketch-local world coords during dim placement.
  // Written by the R3F-side pointermove projection (see Drawing.tsx); read by
  // finalizeDimensionPlacement to fill `pos` on the new constraint so the
  // dim lands at the click point instead of the renderer's default offset.
  dimensionCursorWorld: [number, number] | null
  pendingDialog: DialogState | null
  pendingProjectTarget: { sourceFeatureId: string; sourceEntityId: string } | null
  contextMenu: [number, number] | null
  activePickField: ActivePickField | null
  chipOwnedSelection: Set<string>
  syncChipSelection: (values: string[]) => void
  clearChipSelection: () => void
  setActiveTool: (tool: ActiveTool) => void
  setNgonSides: (n: number) => void
  setActiveFeatureId: (id: string | null) => void
  setShowDebugHit: (enabled: boolean) => void
  setShowConstraintTiles: (show: boolean) => void
  setEntityKindMap: (map: Record<string, string>) => void
  applyConstraint: (kind: string) => void
  applyOffset: (distance: number) => void
  toggleConstruction: () => void
  deleteSelected: () => void
  openDialog: (opts: DialogState) => void
  closeDialog: () => void
  setPendingProjectTarget: (target: { sourceFeatureId: string; sourceEntityId: string } | null) => void
  openContextMenu: (pos: [number, number]) => void
  closeContextMenu: () => void
  addDimensionPick: (pick: DimensionPick) => void
  addBrepDimensionPick: (query: string, opts: { isVertexPick: boolean; sourceKind?: string | null }) => void
  clearDimensionPicks: () => void
  setDimensionCursorWorld: (p: [number, number] | null) => void
  finalizeDimensionPlacement: (clientPos: [number, number]) => void
  setActivePickField: (field: ActivePickField | null, opts?: { seed?: boolean }) => void
}

// Snapshot the current state into the ToolContext a tool lifecycle hook expects.
// pushMode/popMode close over get() so they always reach the live store.
function buildToolContext(get: () => SketchEditorState): ToolContext {
  const s = get()
  return {
    normalSelection: s.normalSelection,
    hoveredSelectionId: s.hoveredSelectionId,
    isPointerDown: s.isPointerDown,
    activeFeatureId: s.activeFeatureId,
    hoveredVertexId: s.hoveredVertexId,
    hoveredVertexPosition: s.hoveredVertexPosition,
    hoveredSnapKind: s.hoveredSnapKind,
    onMutation: _sketchCbs.onMutation,
    onMutationBatch: _sketchCbs.onMutationBatch,
    pushMode: (kind: string) => get().pushMode(kind),
    popMode: (expectedKind?: string) => get().popMode(expectedKind),
  }
}

// Fire a tool's activate hook if the tool is registered. Callers own the guard
// deciding whether the hook should run at all; the tool field itself is written
// by the caller's own set().
function activateTool(get: () => SketchEditorState, toolId: ActiveTool): void {
  if (!toolId) return
  toolRegistry.get(toolId as ToolId)?.activate(buildToolContext(get))
}

// Disarms the tool completely before running its hook: the field, plus the
// transient state that only exists while a tool is armed. The hook pops the
// tool's mode entry and popMode revalidates the whole store the moment the
// stack empties, so it must not observe a half-disarmed editor (an activeTool
// whose entry is already gone, or draw/dimension leftovers with no tool).
// Callers that arm a new tool re-apply these resets anyway.
function deactivateTool(
  get: () => SketchEditorState,
  set: (p: Partial<SketchEditorState>) => void,
  toolId: ActiveTool,
): void {
  if (!toolId) return
  set({
    activeTool: null,
    drawPoints: [],
    drawHover: null,
    drawSnapVertexId: null,
    dimensionPicks: [],
    dimensionCursorWorld: null,
  })
  toolRegistry.get(toolId as ToolId)?.deactivate(buildToolContext(get))
}

export const useSketchEditorStore = create<SketchEditorState>((set, get) => ({
  normalSelection: new Set(),
  selectedPicks: new Map(),
  selectionDomain: 'sketch_2d',
  hoveredSelectionId: null,
  hoveredPickKey: null,
  isPointerDown: false,
  alignmentSnapPoint: null,
  alignmentSnapKind: null,
  alignmentSnapVertexId: null,
  drag: null,
  dragStartClient: null,
  dragPending: null,
  dragSnap: null,
  isRotating: false,
  showDebugHit: false,
  showConstraintTiles: true,
  ngonSides: 6,
  entityKindMap: {},
  hoveredConstraintEntityIds: new Set(),
  hoveredVertexId: null,
  hoveredFaceNormal: null,
  hoveredFaceCenter: null,
  hoveredVertexPosition: null,
  hoveredSnapKind: null,
  activeTool: null,
  activeFeatureId: null,
  drawPoints: [],
  drawHover: null,
  drawSnapVertexId: null,
  dimensionPicks: [],
  pendingBrepProjectionIds: [],
  dimensionCursorWorld: null,
  pendingDialog: null,
  pendingProjectTarget: null,
  contextMenu: null,
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

  resetTransientState: () => set({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    selectionDomain: 'sketch_2d',
    hoveredSelectionId: null,
    hoveredPickKey: null,
    isPointerDown: false,
    alignmentSnapPoint: null,
    alignmentSnapKind: null,
    alignmentSnapVertexId: null,
    drag: null,
    dragStartClient: null,
    dragPending: null,
    dragSnap: null,
    isRotating: false,
    hoveredConstraintEntityIds: new Set(),
    hoveredVertexId: null,
    hoveredFaceNormal: null,
    hoveredFaceCenter: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    activeTool: null,
    activeFeatureId: null,
    drawPoints: [],
    drawHover: null,
    drawSnapVertexId: null,
    dimensionPicks: [],
    pendingBrepProjectionIds: [],
    dimensionCursorWorld: null,
    pendingDialog: null,
    pendingProjectTarget: null,
    contextMenu: null,
    modeStack: [],
    activePickField: null,
    chipOwnedSelection: new Set(),
  }),

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
          if (pickKey !== undefined) nextPicks.set(id, new Set([pickKey]))
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
          nextPicks.set(id, remaining)
        }
      } else {
        // A colliding sibling: additive, never a replacement. This is the click
        // that used to silently un-select whatever already held this query.
        nextPicks.set(id, new Set(claims).add(pickKey))
      }
      return { normalSelection: next, selectedPicks: nextPicks, selectionDomain: deriveSelectionDomain(next) }
    }),

  addToNormalSelection: (id) =>
    set(s => {
      if (s.normalSelection.has(id)) return s
      const next = new Set(s.normalSelection)
      next.add(id)
      return { normalSelection: next, selectionDomain: deriveSelectionDomain(next) }
    }),

  setAlignmentSnap: (point, kind, vertexId) => set({ alignmentSnapPoint: point, alignmentSnapKind: kind, alignmentSnapVertexId: vertexId }),

  setDrag: (drag) => set({ drag }),
  setDragStartClient: (pos) => set({ dragStartClient: pos }),
  setDragPending: (pending) => set({ dragPending: pending }),
  setDragSnap: (snap) => set({ dragSnap: snap }),

  setIsRotating: (rotating: boolean) => set({ isRotating: rotating }),

  setShowDebugHit: (enabled) => set({ showDebugHit: enabled }),

  setShowConstraintTiles: (show) => set({ showConstraintTiles: show }),

  // Clamp to the n-gon range (3..64) so the draw tool and preview never see a
  // degenerate count.
  setNgonSides: (n) => set({ ngonSides: Math.max(3, Math.min(64, Math.round(n) || 6)) }),

  setActiveTool: (tool) => {
    const prevTool = get().activeTool

    // Deactivate previous tool (lifecycle hook)
    deactivateTool(get, set, prevTool)

    // Switching tools abandons any in-flight brep dimension gesture: the
    // projections it materialised were scratch work for that gesture.
    if (get().pendingBrepProjectionIds.length > 0) {
      get().cancelBrepProjectionGesture()
    }

    set(state => {
      const updates: Record<string, unknown> = {
        activeTool: tool,
        drawPoints: [],
        drawHover: null,
        drawSnapVertexId: null,
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
      // Clear stale pick-field state when entering any tool. Start from the
      // selection the clearsSelectionOnEnter branch may already have emptied:
      // rebuilding from state.normalSelection here would silently undo that
      // clear when both branches fire (dimension tool entered mid-pick).
      if (tool !== null && state.activePickField !== null) {
        updates.activePickField = null
        updates.chipOwnedSelection = new Set<string>()
        const baseNormal = (updates.normalSelection as Set<string> | undefined) ?? state.normalSelection
        const nextNormal = new Set(baseNormal)
        for (const v of state.chipOwnedSelection) nextNormal.delete(v)
        updates.normalSelection = nextNormal
        updates.selectedPicks = new Map<string, Set<string>>()
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

    // Activate new tool (lifecycle hook)
    activateTool(get, tool)

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
    set(state => {
      // Entering/exiting a sketch is never a continuation of a drag gesture (the
      // active feature does not change mid-drag), so any leftover drag/dragPending
      // here is stuck state from a lost gesture -- e.g. a load race that remounts
      // the DragPlane mid-press and loses its pointerup cleanup. Orbit is derived
      // as `!drag && !dragPending` (SceneController), so clearing it on every real
      // edit transition guarantees the camera re-enables the instant you press Edit.
      const dragReset = state.activeFeatureId !== id
        ? { drag: null, dragPending: null, dragStartClient: null, dragSnap: null, isPointerDown: false }
        : {}
      if (state.activeFeatureId !== null && id === null) {
        return { ...dragReset, activeFeatureId: id, activeTool: null, drawPoints: [], drawHover: null, drawSnapVertexId: null }
      }
      return { ...dragReset, activeFeatureId: id }
    })
  },

  setEntityKindMap: (map) => set({ entityKindMap: map }),

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
    if (!onMutation) return
    if (selection.size === 0 || !activeFeatureId) return
    const targets = [...selection].filter(t =>
      t.startsWith('entity:') || t.startsWith('vertex:') || t.startsWith('constraint:') || t.startsWith('@builtin_') || t.startsWith('dock:') || t.startsWith('isect:')
    )
    if (targets.length === 0) return

    // Reject operand kinds the constraint cannot represent before authoring it.
    // A parallel between two arcs (or a concentric on a line) otherwise lands in
    // the doc as a constraint the solver can't satisfy and the canvas can't
    // render -- leaving it stuck and undeletable. The registry's
    // `entityKindGroups` is the single source of truth: every entity operand's
    // kind must fall in one common group. An unknown kind (not in entityKindMap
    // yet) is tolerated so this never blocks on a transient/empty map.
    const def = CONSTRAINT_BY_KIND.get(kind)
    if (def?.entityKindGroups) {
      const groups = def.entityKindGroups
      const kinds = targets
        .filter(t => t.startsWith('entity:'))
        .map(t => entityKindMap[t])
        .filter((k): k is string => k !== undefined)
      const allOk = groups.some(g => kinds.every(k => g.includes(k)))
      if (!allOk) {
        if (devOnly) console.warn(`[sketchEditorStore] applyConstraint(${kind}): operand kinds [${kinds.join(', ')}] not allowed.`)
        return
      }
    }

    if (kind === 'horizontal' || kind === 'vertical') {
      if (targets.length === 1) {
        const entityTargets = targets.filter(t => t.startsWith('entity:'))
        if (entityTargets.length === 1) {
          const ek = entityKindMap[entityTargets[0]]
          if (ek !== undefined && ek !== 'line') {
            if (devOnly) console.warn(`[sketchEditorStore] applyConstraint(${kind}): single target must be a line, got '${ek}'.`)
            return
          }
        }
      }
    }

    if (kind === 'midpoint') {
      const entityTargets = targets.filter(t => t.startsWith('entity:'))
      const vertexTargets = targets.filter(t => t.startsWith('vertex:'))
      const validLinePoint = entityTargets.length === 1 && vertexTargets.length === 1
      const validThreeVertex = vertexTargets.length === 3 && entityTargets.length === 0
      if (!validLinePoint && !validThreeVertex) return
    }

    onMutation({ type: 'add_constraint', featureId: activeFeatureId, kind, targets })
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
    const targets = [...selection].filter(target => {
      if (target.startsWith('entity:') || target.startsWith('vertex:') || target.startsWith('constraint:')) {
        const parts = target.split(':')
        return parts[1] === activeFeatureId
      }
      return false
    })
    if (targets.length === 0) return
    onMutation({ type: 'delete', targets })
    set({ normalSelection: new Set(), selectedPicks: new Map(), selectionDomain: 'sketch_2d', chipOwnedSelection: new Set(), hoveredConstraintEntityIds: new Set() })
  },

  addDrawPoint: (pt) => set(s => ({ drawPoints: [...s.drawPoints, pt] })),
  setDrawPoints: (pts) => set({ drawPoints: pts }),
  setDrawHover: (pt) => set({ drawHover: pt }),
  setDrawSnap: (vertexId) => set({ drawSnapVertexId: vertexId }),
  clearDraw: () => {
    set({ drawPoints: [], drawHover: null, drawSnapVertexId: null })
    if (devOnly || testMode) {
      validateWithRepair(get, set)
    }
  },

  openDialog: (opts) => set({ pendingDialog: opts }),
  closeDialog: () => set({ pendingDialog: null }),
  setPendingProjectTarget: (target) => set({ pendingProjectTarget: target }),
  openContextMenu: (pos) => set({ contextMenu: pos }),
  closeContextMenu: () => set({ contextMenu: null }),

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
    const sketch = _sketchCbs.getSketch?.(activeFeatureId) ?? null
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
      _sketchCbs.beginBrepProjection?.()
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
    _sketchCbs.cancelBrepProjection?.()
    set({ pendingBrepProjectionIds: [] })
  },

  // Drops the brep gesture bookkeeping without touching the doc: used where the
  // doc is already being replaced (undo), so a compensating delete would only
  // chase entities that are already gone.
  clearBrepProjectionState: () => {
    _sketchCbs.cancelBrepProjection?.()
    set({ pendingBrepProjectionIds: [] })
  },

  setDimensionCursorWorld: (p) => set({ dimensionCursorWorld: p }),

  finalizeDimensionPlacement: (clientPos) => {
    const { activeFeatureId, dimensionCursorWorld } = get()
    if (!activeFeatureId || get().dimensionPicks.length === 0) return
    const sketch = _sketchCbs.getSketch?.(activeFeatureId) ?? null
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
    // The dim self-deduplicates if a same entity was clicked twice.
    const targets = dimensionTargets(dimensionPicks)
    const featureId = activeFeatureId
    let constraintKind = resolved.constraintKind

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

    get().openDialog({
      position: clientPos,
      label: 'Dimension value',
      defaultValue,
      // Cancelling the value dialog abandons the gesture: the projections it
      // materialised were scratch work and are removed with no undo entries.
      onCancel: () => get().cancelBrepProjectionGesture(),
      validate: (input) => {
        const val = parseFloat(input)
        if (isNaN(val)) return 'Enter a number'
        if (val <= 0) return 'Must be greater than 0'
        return null
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

  setActivePickField: (field, opts) => {
    // Leaving any prior pick: drop its mode and chip-owned mirror. The field is
    // cleared before the pop for the same reason deactivateTool clears the tool:
    // popMode revalidates on an empty stack and an armed pick field with no
    // 'pick' entry is a violation.
    const prev = get().activePickField
    if (prev !== null) {
      set({ activePickField: null })
      if (get().modeStack[get().modeStack.length - 1] === 'pick') {
        get().popMode('pick')
      }
      get().clearChipSelection()
    }

    if (field === null) {
      set({ activePickField: null })
      if (devOnly || testMode) validateWithRepair(get, set)
      return
    }

    // Entering a pick: deactivate any active tool first. Unguarded, like every
    // other deactivate path: an armed tool always owns the top of the stack (the
    // invariant says so), and a desync is a bug we want popMode to report rather
    // than skip silently.
    deactivateTool(get, set, get().activeTool)

    // Manual activate clears the existing normal selection so a stray prior
    // selection is not instantly consumed as a pick. `seed: true` (used by
    // auto-activate-on-insert) keeps it so it becomes the chip's initial picks.
    set({
      activePickField: field,
      activeTool: null,
      drawPoints: [],
      drawHover: null,
      drawSnapVertexId: null,
      ...(opts?.seed ? {} : { normalSelection: new Set<string>(), selectedPicks: new Map<string, Set<string>>(), chipOwnedSelection: new Set<string>(), selectionDomain: 'sketch_2d' as SelectionDomain }),
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

}))
