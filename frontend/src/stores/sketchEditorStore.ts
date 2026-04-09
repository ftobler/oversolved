import { create } from 'zustand'
import type { Mutation } from '../types/cad'
import { resolveSingleEntityDimension, resolveTwoTargetDimension } from '../registry'
import type { SnapKind } from '../registry'
import type { SnapTarget } from '../components/Geometry3D/snapDetection'

// Mutation types dispatched to the parent (Part.tsx) for YAML AST manipulation + re-solve
export type { Mutation }

export type ActiveTool = 'select' | 'dimension' | 'line' | 'rect' | 'center_rect' | 'circle' | 'arc' | 'point' | 'project' | 'drag' | null

export const getEffectiveTool = (activeTool: ActiveTool): NonNullable<ActiveTool> => activeTool ?? 'drag'

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

interface SketchEditorState {
   // SELECTION SUBSYSTEM
   // Internal hover selection — always reflects what's directly under cursor.
   internalHoverSelection: string | null
   // Normal selection — traditional selection, persists until explicitly changed.
   normalSelection: Set<string>
   // Dynamic selection — elements being added/removed during drag selection.
   dynamicSelection: Set<string>
   // Tracks if pointer is currently down for dynamic selection accumulation.
  isPointerDown: boolean
  setInternalHoverSelection: (id: string | null) => void
  setIsPointerDown: (down: boolean) => void
  clearNormalSelection: () => void
  clearDynamicSelection: () => void
  toggleNormalSelection: (id: string) => void
  updateDynamicSelection: (hoverId: string | null) => void

  // HOVER STATE
  // Written by hit geometry (EntityLines, VertexDots, planes, surfaces);
  // read by tools (drawing snap, constraint highlighting, debug overlay).
  hoveredEntityId: string | null
  hoveredVertexId: string | null
  hoveredVertexPosition: [number, number] | null
  hoveredSnapKind: SnapKind | null
  hoveredPathSnap: { entityId: string; position: [number, number] } | null
  hoveredConstraintEntityIds: Set<string>
  hoveredPlaneId: string | null
  hoveredSurfaceId: string | null
  setHoveredEntity: (id: string | null) => void
  setHoveredVertex: (id: string | null, position: [number, number] | null, snapKind?: SnapKind | null) => void
  setHoveredPathSnap: (snap: { entityId: string; position: [number, number] } | null) => void
  setHoveredConstraintEntities: (ids: Set<string>) => void
  setHoveredPlane: (id: string | null) => void
  setHoveredSurface: (id: string | null) => void

  // DRAG TOOL STATE
  drag: DragState | null
  dragStartClient: [number, number] | null  // screen coordinates at pointer-down, before drag initiated (for lazy initiation)
  dragPending: { type: 'edge' | 'vertex'; vertexId: string; featureId: string; entityId: string; vertexKey: string; startWorld: [number, number] } | null  // pending drag info from onPointerDown, used for lazy initiation
  dragSnap: SnapTarget | null
  alignmentSnapPoint: [number, number] | null
  alignmentSnapKind: 'kinda_horizontal' | 'kinda_vertical' | null
  alignmentSnapVertexId: string | null
  setDrag: (drag: DragState | null) => void
  setDragStartClient: (pos: [number, number] | null) => void
  setDragPending: (pending: { type: 'edge' | 'vertex'; vertexId: string; featureId: string; entityId: string; vertexKey: string; startWorld: [number, number] } | null) => void
  setDragSnap: (snap: SnapTarget | null) => void
  setAlignmentSnap: (point: [number, number] | null, kind: 'kinda_horizontal' | 'kinda_vertical' | null, vertexId: string | null) => void

  // DRAW TOOL STATE
  drawPoints: [number, number][]
  drawHover: [number, number] | null
  drawSnapVertexId: string | null
  drawSnapEntityRef: string | null
  addDrawPoint: (pt: [number, number]) => void
  setDrawHover: (pt: [number, number] | null) => void
  setDrawSnap: (vertexId: string | null, entityRef: string | null) => void
  clearDraw: () => void

  // NAVIGATION SUBSYSTEM
  orbitEnabled: boolean
  isRotating: boolean
  setOrbitEnabled: (enabled: boolean) => void
  setIsRotating: (rotating: boolean) => void

  // TOOL / SESSION STATE
  activeTool: ActiveTool
  activeFeatureId: string | null
  showDebugHit: boolean
  onMutation: ((m: Mutation) => void) | null
  onRebuild: (() => void) | null
  onExitSketch: (() => void) | null
  pendingDimTarget: string | null
  pendingDimEntityKind: string | null
  pendingDialog: DialogState | null
  pendingProjectTarget: { sourceFeatureId: string; sourceEntityId: string } | null
  contextMenu: [number, number] | null
  planeSelectionFeatureId: string | null
  fieldPickState: { featureId: string; field: string; kind: 'plane' | 'point' | 'line' } | null
  setActiveTool: (tool: ActiveTool) => void
  setActiveFeatureId: (id: string | null) => void
  setShowDebugHit: (enabled: boolean) => void
  setOnMutation: (cb: ((m: Mutation) => void) | null) => void
  setOnRebuild: (cb: (() => void) | null) => void
  setOnExitSketch: (cb: (() => void) | null) => void
  applyConstraint: (kind: string) => void
  toggleConstruction: () => void
  deleteSelected: () => void
  openDialog: (opts: DialogState) => void
  closeDialog: () => void
  setPendingProjectTarget: (target: { sourceFeatureId: string; sourceEntityId: string } | null) => void
  openContextMenu: (pos: [number, number]) => void
  closeContextMenu: () => void
  handleDimensionClick: (target: string, featureId: string, kind: 'entity' | 'vertex', screenPos: [number, number], entityKind?: string) => void
  setPlaneSelectionFeatureId: (id: string | null) => void
  commitPlaneSelection: (selectionId: string) => void
  setFieldPickState: (state: { featureId: string; field: string; kind: 'plane' | 'point' | 'line' } | null) => void
  commitFieldPick: (selectionId: string) => void
}

export const useSketchEditorStore = create<SketchEditorState>((set, get) => ({
  normalSelection: new Set(),
  internalHoverSelection: null,
  dynamicSelection: new Set(),
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
  onMutation: null,
  onRebuild: null,
  onExitSketch: null,
  hoveredConstraintEntityIds: new Set(),
  hoveredEntityId: null,
  hoveredVertexId: null,
  hoveredPlaneId: null,
  hoveredSurfaceId: null,
  hoveredVertexPosition: null,
  hoveredSnapKind: null,
  hoveredPathSnap: null,
  activeTool: null,
  activeFeatureId: null,
  drawPoints: [],
  drawHover: null,
  drawSnapVertexId: null,
  drawSnapEntityRef: null,
  pendingDimTarget: null,
  pendingDimEntityKind: null,
  pendingDialog: null,
  pendingProjectTarget: null,
  contextMenu: null,
  planeSelectionFeatureId: null,
  fieldPickState: null,

  setInternalHoverSelection: (id) => set(s => {
    if (s.internalHoverSelection === id) return s
    return { internalHoverSelection: id }
  }),

  setIsPointerDown: (down: boolean) => set({ isPointerDown: down }),

  clearNormalSelection: () => set({ normalSelection: new Set(), dynamicSelection: new Set() }),

  clearDynamicSelection: () => set({ dynamicSelection: new Set() }),

  toggleNormalSelection: (id) =>
    set(s => {
      const next = new Set(s.normalSelection)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { normalSelection: next }
    }),

  updateDynamicSelection: (hoverId) => set(s => {
    if (!hoverId) return { dynamicSelection: new Set() }

    if (hoverId === s.internalHoverSelection && s.internalHoverSelection !== null) {
      return s
    }

    const isInNormal = s.normalSelection.has(hoverId)
    const isInDynamic = s.dynamicSelection.has(hoverId)
    const next = new Set(s.dynamicSelection)
    if (isInNormal) {
      if (isInDynamic) next.delete(hoverId)
    } else {
      if (!isInDynamic) next.add(hoverId)
    }
    return { dynamicSelection: next }
  }),

  setAlignmentSnap: (point, kind, vertexId) => set({ alignmentSnapPoint: point, alignmentSnapKind: kind, alignmentSnapVertexId: vertexId }),

  setDrag: (drag) => set({ drag }),
  setDragStartClient: (pos) => set({ dragStartClient: pos }),
  setDragPending: (pending) => set({ dragPending: pending }),
  setDragSnap: (snap) => set({ dragSnap: snap }),

  setOrbitEnabled: (enabled) => set({ orbitEnabled: enabled }),

  setIsRotating: (rotating: boolean) => set({ isRotating: rotating }),

  setShowDebugHit: (enabled) => set({ showDebugHit: enabled }),

  setOnMutation: (cb) => set({ onMutation: cb }),
  setOnRebuild: (cb) => set({ onRebuild: cb }),
  setOnExitSketch: (cb) => set({ onExitSketch: cb }),

  setActiveFeatureId: (id) => set({ activeFeatureId: id }),

  setHoveredConstraintEntities: (ids) => set({ hoveredConstraintEntityIds: ids }),

  setHoveredEntity: (id) => set({ hoveredEntityId: id }),

  setHoveredVertex: (id, position, snapKind) => set({ hoveredVertexId: id, hoveredVertexPosition: position, hoveredSnapKind: snapKind ?? null }),

  setHoveredPlane: (id) => set({ hoveredPlaneId: id }),

  setHoveredSurface: (id) => set({ hoveredSurfaceId: id }),

  setHoveredPathSnap: (snap) => set({ hoveredPathSnap: snap }),

  setActiveTool: (tool) => {
    set({ activeTool: tool, drawPoints: [], drawHover: null })
  },

  applyConstraint: (kind) => {
    const { normalSelection: selection, onMutation, activeFeatureId } = get()
    if (selection.size === 0 || !onMutation || !activeFeatureId) return
    const targets = [...selection]
    onMutation({ type: 'add_constraint', featureId: activeFeatureId, kind, targets })
  },

  toggleConstruction: () => {
    const { normalSelection: selection, onMutation } = get()
    if (selection.size === 0 || !onMutation) return
    const targets = [...selection].filter(t => t.startsWith('entity:'))
    if (targets.length === 0) return
    onMutation({ type: 'toggle_construction', targets })
  },

  deleteSelected: () => {
    const { normalSelection: selection, onMutation, activeFeatureId } = get()
    if (selection.size === 0 || !onMutation) return
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
  setDrawSnap: (vertexId, entityRef) => set({ drawSnapVertexId: vertexId, drawSnapEntityRef: entityRef }),
  clearDraw: () => set({ drawPoints: [], drawHover: null, drawSnapVertexId: null, drawSnapEntityRef: null }),

  openDialog: (opts) => set({ pendingDialog: opts }),
  closeDialog: () => set({ pendingDialog: null }),
  setPendingProjectTarget: (target) => set({ pendingProjectTarget: target }),
  openContextMenu: (pos) => set({ contextMenu: pos }),
  closeContextMenu: () => set({ contextMenu: null }),

  setPlaneSelectionFeatureId: (id) => set({ planeSelectionFeatureId: id }),

  setFieldPickState: (state) => set({ fieldPickState: state }),

  commitFieldPick: (selectionId) => {
    const { fieldPickState, onMutation } = get()
    if (!fieldPickState) return
    let value: string
    if (selectionId.startsWith('face:')) {
      value = selectionId.split(':').slice(2).join(':')
    } else if (selectionId.startsWith('vertex:')) {
      const parts = selectionId.split(':')
      const [, featId, eleId, sub] = parts
      value = '@' + featId + eleId + sub
    } else if (selectionId.startsWith('entity:')) {
      const parts = selectionId.split(':')
      const [, featId, eleId] = parts
      value = '@' + featId + eleId
    } else {
      value = selectionId
    }
    onMutation?.({ type: 'set_plane_definition_field', featureId: fieldPickState.featureId, field: fieldPickState.field, value })
  },

  commitPlaneSelection: (selectionId) => {
    const { planeSelectionFeatureId, onMutation } = get()
    if (!planeSelectionFeatureId) return
    const plane = selectionId.startsWith('face:')
      ? selectionId.split(':').slice(2).join(':')
      : selectionId
    onMutation?.({ type: 'set_feature_plane', featureId: planeSelectionFeatureId, plane })
  },

  handleDimensionClick: (target, featureId, kind, screenPos, entityKind) => {
    const { pendingDimTarget, pendingDimEntityKind, onMutation, activeFeatureId } = get()
    const hostFeatureId = activeFeatureId ?? featureId
    const openDialog = get().openDialog
    if (!pendingDimTarget) {
      // Single-entity dimension — immediately create for arc/circle, go pending for line
      if (kind === 'entity' && entityKind !== 'line') {
        const dimKind = entityKind ? resolveSingleEntityDimension(entityKind) : null
        if (dimKind) {
          openDialog({
            position: screenPos,
            label: 'Dimension value',
            onConfirm: (input) => {
              const val = parseFloat(input)
              if (isNaN(val) || val <= 0) return
              onMutation?.({ type: 'add_constraint', featureId: hostFeatureId, kind: dimKind, targets: [target], value: val })
              set({ activeTool: null, pendingDimTarget: null, pendingDimEntityKind: null })
            },
          })
          return
        }
      }
      // First click: store pending (line goes pending for potential angle with second line)
      set({ pendingDimTarget: target, pendingDimEntityKind: entityKind ?? null })
    } else {
      // Second click — resolve constraint kind from target pair
      const first = pendingDimTarget
      const firstEntityKind = pendingDimEntityKind
      set({ pendingDimTarget: null, pendingDimEntityKind: null })

      if (first === target && firstEntityKind) {
        // Same entity clicked twice: create single-entity dimension (e.g. length for line)
        const singleKind = resolveSingleEntityDimension(firstEntityKind)
        if (!singleKind) return
        openDialog({
          position: screenPos,
          label: 'Dimension value',
          onConfirm: (input) => {
            const val = parseFloat(input)
            if (isNaN(val) || val <= 0) return
            onMutation?.({ type: 'add_constraint', featureId: hostFeatureId, kind: singleKind, targets: [target], value: val })
            set({ activeTool: null })
            },
            })
            return
            }

            const isPoint = (t: string) => t.startsWith('vertex:') || t.startsWith('@builtin_')
      const dimKind = resolveTwoTargetDimension(
        isPoint(first),
        isPoint(target),
        firstEntityKind ?? undefined,
        entityKind,
      )
      openDialog({
        position: screenPos,
        label: 'Dimension value',
        onConfirm: (input) => {
          const val = parseFloat(input)
          if (isNaN(val) || val <= 0) return
          onMutation?.({ type: 'add_constraint', featureId: hostFeatureId, kind: dimKind, targets: [first, target], value: val })
          set({ activeTool: null })
        },
      })
    }
  },
}))
