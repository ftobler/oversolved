// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import { create } from 'zustand'
import type { ActiveTool, Mutation, SelectionDomain } from '@/types/cad'
import type { SnapKind } from '@/registry'
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
} = { onMutation: null, onRebuild: null, onExitSketch: null }

export function setSketchCallback(key: 'onMutation', cb: ((m: Mutation) => void) | null): void
export function setSketchCallback(key: 'onRebuild' | 'onExitSketch', cb: (() => void) | null): void
export function setSketchCallback(key: keyof typeof _sketchCbs, cb: unknown): void {
  (_sketchCbs as Record<string, unknown>)[key] = cb
}

export function getSketchCallback<K extends keyof typeof _sketchCbs>(key: K): (typeof _sketchCbs)[K] {
  return _sketchCbs[key]
}

const devOnly = import.meta.env.DEV
const testMode = import.meta.env.MODE === 'test'

function guard<T extends (...args: never[]) => unknown>(
  fn: T | null | undefined,
  label: string,
): T {
  if (!fn) {
    if (testMode) {
      throw new Error(`[sketchEditorStore] ${label}: callback not registered. Call setSketchCallback() before invoking this action.`)
    }
    if (devOnly) {
      console.warn(`[sketchEditorStore] ${label}: callback not registered — action will be ignored. Ensure setSketchCallback() was called before this action.`)
    }
  }
  return (fn ?? (() => {})) as unknown as T
}

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

interface SketchEditorState {
   // SELECTION SUBSYSTEM
   // Internal hover selection — always reflects what's directly under cursor.
   internalHoverSelection: string | null
   // Normal selection — traditional selection, persists until explicitly changed.
   normalSelection: Set<string>
   // Derived domain of the current normal selection.
   selectionDomain: SelectionDomain
  isPointerDown: boolean
  setInternalHoverSelection: (id: string | null) => void
  setIsPointerDown: (down: boolean) => void
  clearNormalSelection: () => void
  toggleNormalSelection: (id: string) => void
  addToNormalSelection: (id: string) => void

  // HOVER STATE
  // Written by hit geometry (EntityLines, VertexDots, planes, surfaces);
  // read by tools (drawing snap, constraint highlighting, debug overlay).
  hoveredEntityId: string | null
  hoveredVertexId: string | null
  hoveredVertexPosition: [number, number] | null
  hoveredSnapKind: SnapKind | null
  hoveredConstraintEntityIds: Set<string>
  hoveredPlaneId: string | null
  hoveredSurfaceId: string | null
  hovered3DSurfaceId: string | null
  hoveredEdgeId: string | null
  hoveredBodyId: string | null
  hoveredFaceNormal: [number, number, number] | null
  hoveredFaceCenter: [number, number, number] | null
  setHoveredEntity: (id: string | null) => void
  setHoveredVertex: (id: string | null, position: [number, number] | null, snapKind?: SnapKind | null) => void
  setHoveredConstraintEntities: (ids: Set<string>) => void
  setHoveredPlane: (id: string | null) => void
  setHoveredSurface: (id: string | null) => void
  setHovered3DSurface: (id: string | null) => void
  setHoveredEdge: (id: string | null) => void
  setHoveredBodyId: (id: string | null | ((current: string | null) => string | null)) => void
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
  entityKindMap: Record<string, string>
  pendingDimTarget: string | null
  pendingDimEntityKind: string | null
  pendingDialog: DialogState | null
  pendingProjectTarget: { sourceFeatureId: string; sourceEntityId: string } | null
  contextMenu: [number, number] | null
  planeSelectionFeatureId: string | null
  chipOwnedSelection: Set<string>
  syncChipSelection: (values: string[]) => void
  clearChipSelection: () => void
  setActiveTool: (tool: ActiveTool) => void
  setActiveFeatureId: (id: string | null) => void
  setShowDebugHit: (enabled: boolean) => void
  setShowConstraintTiles: (show: boolean) => void
  setEntityKindMap: (map: Record<string, string>) => void
  applyConstraint: (kind: string) => void
  toggleConstruction: () => void
  deleteSelected: () => void
  openDialog: (opts: DialogState) => void
  closeDialog: () => void
  setPendingProjectTarget: (target: { sourceFeatureId: string; sourceEntityId: string } | null) => void
  openContextMenu: (pos: [number, number]) => void
  closeContextMenu: () => void
  setPendingDim: (target: string | null, entityKind: string | null) => void
  setPlaneSelectionFeatureId: (id: string | null) => void
  commitPlaneSelection: (selectionId: string) => void
}

export const useSketchEditorStore = create<SketchEditorState>((set, get) => ({
  normalSelection: new Set(),
  selectionDomain: 'sketch_2d',
  internalHoverSelection: null,
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
  entityKindMap: {},
  hoveredConstraintEntityIds: new Set(),
  hoveredEntityId: null,
  hoveredVertexId: null,
  hoveredPlaneId: null,
  hoveredSurfaceId: null,
  hovered3DSurfaceId: null,
  hoveredEdgeId: null,
  hoveredBodyId: null,
  hoveredFaceNormal: null,
  hoveredFaceCenter: null,
  hoveredVertexPosition: null,
  hoveredSnapKind: null,
  activeTool: null,
  activeFeatureId: null,
  drawPoints: [],
  drawHover: null,
  drawSnapVertexId: null,
  pendingDimTarget: null,
  pendingDimEntityKind: null,
  pendingDialog: null,
  pendingProjectTarget: null,
  contextMenu: null,
  modeStack: [],
  planeSelectionFeatureId: null,
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

  setInternalHoverSelection: (id) => set(s => {
    if (s.internalHoverSelection === id) return s
    return { internalHoverSelection: id }
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

  setActiveTool: (tool) => {
    const prevTool = get().activeTool

    // Deactivate previous tool (lifecycle hook)
    if (prevTool) {
      const prev = toolRegistry.get(prevTool as ToolId)
      if (prev) {
        const s = get()
        prev.deactivate({
          normalSelection: s.normalSelection,
          internalHoverSelection: s.internalHoverSelection,
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
        updates.pendingDimTarget = null
        updates.pendingDimEntityKind = null
      }
      // Clear stale plane selection state when entering any tool
      if (tool !== null && state.planeSelectionFeatureId !== null) {
        updates.planeSelectionFeatureId = null
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
          internalHoverSelection: s.internalHoverSelection,
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

  setHoveredEntity: (id) => set({ hoveredEntityId: id }),
  setHoveredVertex: (id, position, snapKind) => set({ hoveredVertexId: id, hoveredVertexPosition: position, hoveredSnapKind: snapKind ?? null }),
  setHoveredConstraintEntities: (ids) => set({ hoveredConstraintEntityIds: ids }),
  setHoveredPlane: (id) => set({ hoveredPlaneId: id }),
  setHoveredSurface: (id) => set({ hoveredSurfaceId: id }),
  setHovered3DSurface: (id) => set({ hovered3DSurfaceId: id }),
  setHoveredEdge: (id) => set({ hoveredEdgeId: id }),
  setHoveredBodyId: (id) => set(s => ({ hoveredBodyId: typeof id === 'function' ? id(s.hoveredBodyId) : id })),
  setHoveredFaceGeometry: (normal, center) => set({ hoveredFaceNormal: normal, hoveredFaceCenter: center }),

  applyConstraint: (kind) => {
    const { normalSelection: selection, activeFeatureId } = get()
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

    if (kind === 'midpoint') {
      const entityTargets = targets.filter(t => t.startsWith('entity:'))
      const vertexTargets = targets.filter(t => t.startsWith('vertex:'))
      const validLinePoint = entityTargets.length === 1 && vertexTargets.length === 1
      const validThreeVertex = vertexTargets.length === 3 && entityTargets.length === 0
      if (!validLinePoint && !validThreeVertex) return
    }

    onMutation({ type: 'add_constraint', featureId: activeFeatureId, kind, targets })
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

  setPendingDim: (target, entityKind) => {
    set({ pendingDimTarget: target, pendingDimEntityKind: entityKind })
    if (devOnly || testMode) {
      validateSketchEditorState(get())
    }
  },

  setPlaneSelectionFeatureId: (id) => {
    // When entering plane selection, deactivate any active tool first.
    // Guard: only deactivate if the mode stack has the tool at the top.
    // This handles the case where state was set directly (e.g., test setup via setState)
    // and no tool mode was ever pushed onto the stack.
    if (id !== null) {
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
              internalHoverSelection: s.internalHoverSelection,
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
    }

    // Then clear all draw state before updating plane selection state.
    // This ensures invariant validation in popMode (triggered by deactivate above)
    // sees clean draw state even if previous tests left drawPoints dirty.
    if (id !== null) {
      set({
        planeSelectionFeatureId: id,
        activeTool: null,
        drawPoints: [],
        drawHover: null,
        drawSnapVertexId: null,
      })
    } else {
      set({ planeSelectionFeatureId: id })
    }

    if (id !== null) {
      get().pushMode('plane_selection')
    }

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

  commitPlaneSelection: (selectionId) => {
    const { planeSelectionFeatureId } = get()
    const onMutation = guard(_sketchCbs.onMutation, 'onMutation (from commitPlaneSelection)')
    if (!planeSelectionFeatureId) return
    const plane = selectionId.startsWith('face:')
      ? selectionId.split(':').slice(2).join(':')
      : selectionId
    onMutation({ type: 'set_feature_plane', featureId: planeSelectionFeatureId, plane })
    const s = get()
    const next = new Set(s.normalSelection)
    for (const v of s.chipOwnedSelection) next.delete(v)
    set({ planeSelectionFeatureId: null, normalSelection: next, chipOwnedSelection: new Set() })
    get().popMode('plane_selection')
    if (devOnly || testMode) {
      validateSketchEditorState(get())
    }
  },

}))
