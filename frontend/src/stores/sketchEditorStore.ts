// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import { create } from 'zustand'
import type { ActiveTool, Mutation, SelectionDomain, Sketch } from '@/types/cad'
import type { SnapKind } from '@/registry'
import type { DimensionPick } from '@/registry'
import { resolveDimension, dimensionTargets, CONSTRAINT_BY_KIND } from '@/registry'
import { computeNaturalDimensionValue, computeAnchorRelativePos } from '@/utils/geometry/dimensionNaturalValue'
import type { SnapTarget } from '@/components/Geometry3D/snapDetection'
import { validateSketchEditorState, failLoud } from './stateInvariants'
import { toolRegistry } from '@/registry/toolRegistry'
import type { ToolId } from '@/registry/toolRegistry'

// Callbacks dispatched from pure-layer store actions back into React state.
// Registered by Part.tsx on mount via setSketchCallback(); torn down on unmount.
// Stored outside Zustand so function references don't pollute serializable snapshots.
// Invariant: all three slots must be non-null while a sketch editing session is active.
const _sketchCbs: {
  onMutation: ((m: Mutation) => void) | null
  onRebuild: (() => void) | null
  onExitSketch: (() => void) | null
  getSketch: ((featureId: string) => Sketch | null) | null
} = { onMutation: null, onRebuild: null, onExitSketch: null, getSketch: null }

export function setSketchCallback(key: 'onMutation', cb: ((m: Mutation) => void) | null): void
export function setSketchCallback(key: 'onRebuild' | 'onExitSketch', cb: (() => void) | null): void
export function setSketchCallback(key: 'getSketch', cb: ((featureId: string) => Sketch | null) | null): void
export function setSketchCallback(key: keyof typeof _sketchCbs, cb: unknown): void {
  (_sketchCbs as Record<string, unknown>)[key] = cb
}

export function getSketchCallback<K extends keyof typeof _sketchCbs>(key: K): (typeof _sketchCbs)[K] {
  return _sketchCbs[key]
}

const devOnly = import.meta.env.DEV
const testMode = import.meta.env.MODE === 'test'

// Mutation types dispatched to the parent (Part.tsx) for YAML AST manipulation + re-solve
export type { Mutation }

export type { ActiveTool }

export const getEffectiveTool = (activeTool: ActiveTool): NonNullable<ActiveTool> => activeTool ?? 'drag'

export function deriveSelectionDomain(ids: Set<string>): SelectionDomain {
  if (ids.size === 0) return 'sketch_2d'
  let hasSketch = false
  let has3d = false
  let hasPlane = false
  for (const id of ids) {
    if (id.startsWith('entity:') || id.startsWith('vertex:') || id.startsWith('face:') || id.startsWith('constraint:')) {
      hasSketch = true
    } else if (id.startsWith('?') || (id.startsWith('@') && id.includes('/'))) {
      has3d = true
    } else if (id.startsWith('@')) {
      hasPlane = true
    }
  }
  if (hasSketch && !has3d && !hasPlane) return 'sketch_2d'
  if (has3d && !hasSketch && !hasPlane) return 'body_3d'
  if (hasPlane && !hasSketch && !has3d) return 'plane_3d'
  return 'mixed'
}

export interface DialogState {
  position: [number, number]
  label: string
  defaultValue?: string
  onConfirm: (val: string) => void
  onCancel?: () => void
  // Return an error message to reject the input (dialog stays open and shows
  // it); return null to accept. Omit to accept any input.
  validate?: (val: string) => string | null
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

export type DragState = VertexOrEdgeDrag | DimLabelDrag

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

export type DragPendingState = EdgeVertexDragPending | DimLabelDragPending

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
  // Hovered selection — always reflects what entity/face/plane is directly under cursor.
  hoveredSelectionId: string | null
  // Normal selection — traditional selection, persists until explicitly changed.
  normalSelection: Set<string>
  // Derived domain of the current normal selection.
  selectionDomain: SelectionDomain
  isPointerDown: boolean
  setHoveredSelectionId: (id: string | null) => void
  setIsPointerDown: (down: boolean) => void
  clearNormalSelection: () => void
  toggleNormalSelection: (id: string) => void
  addToNormalSelection: (id: string) => void

  // HOVER STATE
  // Vertex-specific hover data (for snap / visual highlight).
  hoveredVertexId: string | null
  hoveredVertexPosition: [number, number] | null
  hoveredSnapKind: SnapKind | null
  // Constraint tile hover — highlights related entities/vertices.
  hoveredConstraintEntityIds: Set<string>
  // Face geometry for "Align to Face" context menu.
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
  setDrawHover: (pt: [number, number] | null) => void
  setDrawSnap: (vertexId: string | null) => void
  clearDraw: () => void

  // NAVIGATION SUBSYSTEM
  orbitEnabled: boolean
  isRotating: boolean
  setOrbitEnabled: (enabled: boolean) => void
  setIsRotating: (rotating: boolean) => void

  // MODE STACK — tracks nested editor modes; must be empty when returning to "main"
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
  clearDimensionPicks: () => void
  setDimensionCursorWorld: (p: [number, number] | null) => void
  finalizeDimensionPlacement: (clientPos: [number, number]) => void
  setActivePickField: (field: ActivePickField | null, opts?: { seed?: boolean }) => void
}

export const useSketchEditorStore = create<SketchEditorState>((set, get) => ({
  normalSelection: new Set(),
  selectionDomain: 'sketch_2d',
  hoveredSelectionId: null,
  isPointerDown: false,
  alignmentSnapPoint: null,
  alignmentSnapKind: null,
  alignmentSnapVertexId: null,
  drag: null,
  dragStartClient: null,
  dragPending: null,
  dragSnap: null,
  orbitEnabled: true,
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
      validateSketchEditorState(get())
    }
  },

  setHoveredSelectionId: (id) => set(s => {
    if (s.hoveredSelectionId === id) return s
    return { hoveredSelectionId: id }
  }),

  setIsPointerDown: (down: boolean) => set({ isPointerDown: down }),

  clearNormalSelection: () => set({ normalSelection: new Set(), chipOwnedSelection: new Set(), selectionDomain: 'sketch_2d' }),

  toggleNormalSelection: (id) =>
    set(s => {
      const next = new Set(s.normalSelection)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { normalSelection: next, selectionDomain: deriveSelectionDomain(next) }
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

  setOrbitEnabled: (enabled) => set({ orbitEnabled: enabled }),

  setIsRotating: (rotating: boolean) => set({ isRotating: rotating }),

  setShowDebugHit: (enabled) => set({ showDebugHit: enabled }),

  setShowConstraintTiles: (show) => set({ showConstraintTiles: show }),

  // Clamp to the n-gon range (3..64) so the draw tool and preview never see a
  // degenerate count.
  setNgonSides: (n) => set({ ngonSides: Math.max(3, Math.min(64, Math.round(n) || 6)) }),

  setActiveTool: (tool) => {
    const prevTool = get().activeTool

    // Deactivate previous tool (lifecycle hook)
    if (prevTool) {
      const prev = toolRegistry.get(prevTool as ToolId)
      if (prev) {
        const s = get()
        prev.deactivate({
          normalSelection: s.normalSelection,
          hoveredSelectionId: s.hoveredSelectionId,
          isPointerDown: s.isPointerDown,
          activeFeatureId: s.activeFeatureId,
          hoveredVertexId: s.hoveredVertexId,
          hoveredVertexPosition: s.hoveredVertexPosition,
          hoveredSnapKind: s.hoveredSnapKind,
          onMutation: _sketchCbs.onMutation,
          pushMode: (kind: string) => get().pushMode(kind),
          popMode: (expectedKind?: string) => get().popMode(expectedKind),
        })
      }
    }

    set(state => {
      const updates: Record<string, unknown> = {
        activeTool: tool,
        drawPoints: [],
        drawHover: null,
        drawSnapVertexId: null,
      }
      // Clear stale pending dimension state when not in dimension tool
      if (tool !== 'dimension') {
        updates.dimensionPicks = []
        updates.dimensionCursorWorld = null
      } else {
        // Entering the dimension tool wipes the current normal selection so
        // the picks the user makes inside the tool aren't contaminated by
        // whatever was selected before. (Spec: "user clicks 'd', everything
        // de-selects.") Also resets any leftover placement state so the first
        // click starts a fresh gesture.
        updates.normalSelection = new Set<string>()
        updates.dimensionPicks = []
        updates.dimensionCursorWorld = null
      }
      // Clear stale pick-field state when entering any tool
      if (tool !== null && state.activePickField !== null) {
        updates.activePickField = null
        updates.chipOwnedSelection = new Set<string>()
        const nextNormal = new Set(state.normalSelection)
        for (const v of state.chipOwnedSelection) nextNormal.delete(v)
        updates.normalSelection = nextNormal
        if (state.modeStack[state.modeStack.length - 1] === 'pick') {
          updates.modeStack = state.modeStack.slice(0, -1)
        }
      }
      return updates
    })

    // Activate new tool (lifecycle hook)
    if (tool) {
      const next = toolRegistry.get(tool as ToolId)
      if (next) {
        const s = get()
        next.activate({
          normalSelection: s.normalSelection,
          hoveredSelectionId: s.hoveredSelectionId,
          isPointerDown: s.isPointerDown,
          activeFeatureId: s.activeFeatureId,
          hoveredVertexId: s.hoveredVertexId,
          hoveredVertexPosition: s.hoveredVertexPosition,
          hoveredSnapKind: s.hoveredSnapKind,
          onMutation: _sketchCbs.onMutation,
          pushMode: (kind: string) => get().pushMode(kind),
          popMode: (expectedKind?: string) => get().popMode(expectedKind),
        })
      }
    }

    if (devOnly || testMode) {
      validateSketchEditorState(get())
    }
  },

  setActiveFeatureId: (id) => set(state => {
    if (state.activeFeatureId !== null && id === null) {
      return { activeFeatureId: id, activeTool: null, drawPoints: [], drawHover: null, drawSnapVertexId: null }
    }
    return { activeFeatureId: id }
  }),

  setEntityKindMap: (map) => set({ entityKindMap: map }),

  setHoveredVertex: (id, position, snapKind) => set({ hoveredVertexId: id, hoveredVertexPosition: position, hoveredSnapKind: snapKind ?? null }),
  setHoveredConstraintEntities: (ids) => set({ hoveredConstraintEntityIds: ids }),
  setHoveredFaceGeometry: (normal, center) => set({ hoveredFaceNormal: normal, hoveredFaceCenter: center }),

  applyConstraint: (kind) => {
    const { normalSelection: selection, activeFeatureId, entityKindMap } = get()
    const onMutation = _sketchCbs.onMutation
    if (!onMutation) {
      if (devOnly) console.warn('[sketchEditorStore] onMutation: callback not registered — applyConstraint will be a no-op.')
      return
    }
    if (selection.size === 0 || !activeFeatureId) return
    const targets = [...selection].filter(t =>
      t.startsWith('entity:') || t.startsWith('vertex:') || t.startsWith('constraint:') || t.startsWith('@builtin_')
    )
    if (targets.length === 0) return

    // Reject operand kinds the constraint cannot represent before authoring it.
    // A parallel between two arcs (or a concentric on a line) otherwise lands in
    // the doc as a constraint the solver can't satisfy and the canvas can't
    // render -- leaving it stuck and undeletable. The registry's `entityKinds`
    // is the single source of truth; an unknown kind (not in entityKindMap yet)
    // is tolerated so this never blocks on a transient/empty map.
    const def = CONSTRAINT_BY_KIND.get(kind)
    if (def?.entityKinds) {
      const allowed = def.entityKinds
      const allOk = targets.every(t => {
        if (!t.startsWith('entity:')) return true  // vertices/builtins unrestricted
        const k = entityKindMap[t]
        return k === undefined || allowed.includes(k)
      })
      if (!allOk) {
        if (devOnly) console.warn(`[sketchEditorStore] applyConstraint(${kind}): rejected operand kind not in [${allowed.join(', ')}].`)
        return
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
    const onMutation = _sketchCbs.onMutation
    if (!onMutation) {
      if (devOnly) console.warn('[sketchEditorStore] onMutation: callback not registered — applyOffset will be a no-op.')
      return
    }
    if (selection.size === 0 || !activeFeatureId) return
    const sourceIds = [...selection]
      .filter(t => t.startsWith('entity:') && t.split(':')[1] === activeFeatureId)
      .map(t => t.split(':')[2])
    if (sourceIds.length === 0) return
    onMutation({ type: 'apply_offset', featureId: activeFeatureId, sourceIds, distance })
  },

  toggleConstruction: () => {
    const { normalSelection: selection } = get()
    const onMutation = _sketchCbs.onMutation
    if (!onMutation) {
      if (devOnly) console.warn('[sketchEditorStore] onMutation: callback not registered — toggleConstruction will be a no-op.')
      return
    }
    if (selection.size === 0) return
    const targets = [...selection].filter(t => t.startsWith('entity:'))
    if (targets.length === 0) return
    onMutation({ type: 'toggle_construction', targets })
  },

  deleteSelected: () => {
    const { normalSelection: selection, activeFeatureId } = get()
    const onMutation = _sketchCbs.onMutation
    if (!onMutation) {
      if (devOnly) console.warn('[sketchEditorStore] onMutation: callback not registered — deleteSelected will be a no-op.')
      return
    }
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
    set({ normalSelection: new Set() })
  },

  addDrawPoint: (pt) => set(s => ({ drawPoints: [...s.drawPoints, pt] })),
  setDrawHover: (pt) => set({ drawHover: pt }),
  setDrawSnap: (vertexId) => set({ drawSnapVertexId: vertexId }),
  clearDraw: () => {
    set({ drawPoints: [], drawHover: null, drawSnapVertexId: null })
    if (devOnly || testMode) {
      validateSketchEditorState(get())
    }
  },

  openDialog: (opts) => set({ pendingDialog: opts }),
  closeDialog: () => set({ pendingDialog: null }),
  setPendingProjectTarget: (target) => set({ pendingProjectTarget: target }),
  openContextMenu: (pos) => set({ contextMenu: pos }),
  closeContextMenu: () => set({ contextMenu: null }),

  addDimensionPick: (pick: DimensionPick) => {
    const { dimensionPicks } = get()
    // Cap at 2 picks: a third entity click replaces the second (lets the user
    // swap their second pick without restarting the gesture).
    const next = dimensionPicks.length >= 2
      ? [dimensionPicks[0], pick]
      : [...dimensionPicks, pick]
    set({ dimensionPicks: next })
  },

  clearDimensionPicks: () => set({ dimensionPicks: [] }),

  setDimensionCursorWorld: (p) => set({ dimensionCursorWorld: p }),

  finalizeDimensionPlacement: (clientPos) => {
    const { dimensionPicks, activeFeatureId, dimensionCursorWorld } = get()
    if (!activeFeatureId || dimensionPicks.length === 0) return
    const sketch = _sketchCbs.getSketch?.(activeFeatureId) ?? null
    const resolved = resolveDimension(dimensionPicks, sketch ?? undefined, activeFeatureId)
    if (!resolved) {
      // Vertex-only or otherwise undimensionable: silently drop and let the
      // user keep picking. Do not deactivate the tool.
      return
    }
    const onMutation = _sketchCbs.onMutation
    if (!onMutation) {
      if (devOnly) console.warn('[sketchEditorStore] onMutation: callback not registered — finalizeDimensionPlacement will be a no-op.')
      return
    }
    // The dim self-deduplicates if a same entity was clicked twice.
    const targets = dimensionTargets(dimensionPicks)
    const featureId = activeFeatureId
    const constraintKind = resolved.constraintKind

    // Snapshot the placement anchor BEFORE clearing -- the cursorWorld field
    // is cleared on tool exit but we want the dispatched pos to point at where
    // the click happened, not at a later cursor position.
    const placementWorld = dimensionCursorWorld

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
    const defaultValue = naturalValue !== null
      ? (Number.isInteger(naturalValue) ? String(naturalValue) : naturalValue.toFixed(2))
      : undefined

    get().openDialog({
      position: clientPos,
      label: 'Dimension value',
      defaultValue,
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
        const value = (naturalValue !== null && input === defaultValue)
          ? naturalValue
          : parseFloat(input)
        // The pos written by the placement click anchors the dim label where
        // the user clicked instead of the renderer's default offset. Compute
        // it relative to the dim's natural anchor so the LinearDimension /
        // RadiusDimension / DiameterDimension / AngleDimension components,
        // which interpret pos as an anchor-relative offset, render it at the
        // requested world point.
        const pos = (placementWorld && sketch)
          ? computeAnchorRelativePos(constraintKind, targets, sketch, featureId, placementWorld)
          : null
        onMutation({
          type: 'add_constraint',
          featureId, kind: constraintKind, targets, value,
          ...(pos && { pos }),
        })
        // The dimension tool stays armed so the user can place several dims
        // without re-pressing 'd'. They exit explicitly (Escape / different
        // tool / tool button), matching standard CAD behaviour.
      },
    })
  },

  setActivePickField: (field, opts) => {
    // Leaving any prior pick: drop its mode and chip-owned mirror.
    const prev = get().activePickField
    if (prev !== null) {
      if (get().modeStack[get().modeStack.length - 1] === 'pick') {
        get().popMode('pick')
      }
      get().clearChipSelection()
    }

    if (field === null) {
      set({ activePickField: null })
      if (devOnly || testMode) validateSketchEditorState(get())
      return
    }

    // Entering a pick: deactivate any active tool first.
    // Guard: only deactivate if the mode stack has the tool at the top.
    // This handles the case where state was set directly (e.g., test setup via setState)
    // and no tool mode was ever pushed onto the stack.
    const prevTool = get().activeTool
    const stack = get().modeStack
    if (prevTool && stack.length > 0) {
      const top = stack[stack.length - 1]
      if (top === `tool:${prevTool}`) {
        const prev = toolRegistry.get(prevTool as ToolId)
        if (prev) {
          const s = get()
          prev.deactivate({
            normalSelection: s.normalSelection,
            hoveredSelectionId: s.hoveredSelectionId,
            isPointerDown: s.isPointerDown,
            activeFeatureId: s.activeFeatureId,
            hoveredVertexId: s.hoveredVertexId,
            hoveredVertexPosition: s.hoveredVertexPosition,
            hoveredSnapKind: s.hoveredSnapKind,
            onMutation: _sketchCbs.onMutation,
            pushMode: (kind: string) => get().pushMode(kind),
            popMode: (expectedKind?: string) => get().popMode(expectedKind),
          })
        }
      }
    }

    // Manual activate clears the existing normal selection so a stray prior
    // selection is not instantly consumed as a pick. `seed: true` (used by
    // auto-activate-on-insert) keeps it so it becomes the chip's initial picks.
    set({
      activePickField: field,
      activeTool: null,
      drawPoints: [],
      drawHover: null,
      drawSnapVertexId: null,
      ...(opts?.seed ? {} : { normalSelection: new Set<string>(), chipOwnedSelection: new Set<string>(), selectionDomain: 'sketch_2d' as SelectionDomain }),
    })
    get().pushMode('pick')

    if (devOnly || testMode) {
      validateSketchEditorState(get())
    }
  },

  syncChipSelection: (values) => {
    const s = get()
    const nextOwned = new Set(values)
    // Bail if the set hasn't changed to avoid infinite re-render loops
    // when callers pass a fresh array reference each render.
    if (s.chipOwnedSelection.size === nextOwned.size
        && [...s.chipOwnedSelection].every(v => nextOwned.has(v))) {
      return
    }
    const next = new Set(s.normalSelection)
    for (const v of s.chipOwnedSelection) {
      if (!nextOwned.has(v)) next.delete(v)
    }
    for (const v of nextOwned) next.add(v)
    set({ normalSelection: next, chipOwnedSelection: nextOwned })
  },

  clearChipSelection: () => {
    const s = get()
    if (s.chipOwnedSelection.size === 0) return
    const next = new Set(s.normalSelection)
    for (const v of s.chipOwnedSelection) next.delete(v)
    set({ normalSelection: next, chipOwnedSelection: new Set() })
  },

}))
