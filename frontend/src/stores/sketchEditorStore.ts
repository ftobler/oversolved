// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import { create } from 'zustand'
import type { Mutation, PendingPickField, SelectionDomain } from '../types/cad'
import { resolveSingleEntityDimension, resolveTwoTargetDimension } from '../registry'
import type { SnapKind } from '../registry'
import type { SnapTarget } from '../components/Geometry3D/snapDetection'
import { parseQuery } from '../utils/query'

// Mutation types dispatched to the parent (Part.tsx) for YAML AST manipulation + re-solve
export type { Mutation }

export type ActiveTool = 'select' | 'dimension' | 'line' | 'rect' | 'center_rect' | 'circle' | 'arc' | 'point' | 'project' | 'drag' | null

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
   // Dynamic selection — elements being added/removed during drag selection.
   dynamicSelection: Set<string>
   // Tracks if pointer is currently down for dynamic selection accumulation.
  isPointerDown: boolean
  setInternalHoverSelection: (id: string | null) => void
  setIsPointerDown: (down: boolean) => void
  clearNormalSelection: () => void
  clearDynamicSelection: () => void
  toggleNormalSelection: (id: string) => void
  addToNormalSelection: (id: string) => void
  updateDynamicSelection: (hoverId: string | null) => void

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
  pendingPickField: PendingPickField | null
  pickChipHighlightItems: string[]
  setPickChipHighlightItems: (items: string[]) => void
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
  setPendingDim: (target: string | null, entityKind: string | null) => void
  setPlaneSelectionFeatureId: (id: string | null) => void
  commitPlaneSelection: (selectionId: string) => void
  setPendingPickField: (state: PendingPickField | null) => void
  commitFieldPick: () => void
}

export const useSketchEditorStore = create<SketchEditorState>((set, get) => ({
  normalSelection: new Set(),
  selectionDomain: 'sketch_2d',
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
  planeSelectionFeatureId: null,
  pendingPickField: null,
  pickChipHighlightItems: [],

  setInternalHoverSelection: (id) => set(s => {
    if (s.internalHoverSelection === id) return s
    return { internalHoverSelection: id }
  }),

  setIsPointerDown: (down: boolean) => set({ isPointerDown: down }),

  clearNormalSelection: () => set({ normalSelection: new Set(), selectionDomain: 'sketch_2d', dynamicSelection: new Set() }),

  clearDynamicSelection: () => set({ dynamicSelection: new Set() }),

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

  setHovered3DSurface: (id) => set({ hovered3DSurfaceId: id }),

  setHoveredEdge: (id) => set({ hoveredEdgeId: id }),

  setHoveredBodyId: (id) => set(s => ({
    hoveredBodyId: typeof id === 'function' ? id(s.hoveredBodyId) : id,
  })),

  setHoveredFaceGeometry: (normal, center) => set({ hoveredFaceNormal: normal, hoveredFaceCenter: center }),

  setActiveTool: (tool) => {
    set({ activeTool: tool, drawPoints: [], drawHover: null })
  },

  applyConstraint: (kind) => {
    const { normalSelection: selection, onMutation, activeFeatureId } = get()
    if (selection.size === 0 || !onMutation || !activeFeatureId) return
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
  setDrawSnap: (vertexId) => set({ drawSnapVertexId: vertexId }),
  clearDraw: () => set({ drawPoints: [], drawHover: null, drawSnapVertexId: null }),

  openDialog: (opts) => set({ pendingDialog: opts }),
  closeDialog: () => set({ pendingDialog: null }),
  setPendingProjectTarget: (target) => set({ pendingProjectTarget: target }),
  openContextMenu: (pos) => set({ contextMenu: pos }),
  closeContextMenu: () => set({ contextMenu: null }),

  setPendingDim: (target, entityKind) => set({ pendingDimTarget: target, pendingDimEntityKind: entityKind }),

  setPlaneSelectionFeatureId: (id) => set({ planeSelectionFeatureId: id }),

  setPendingPickField: (state) => set({
    pendingPickField: state,
    pickChipHighlightItems: state ? get().pickChipHighlightItems : [],
  }),

  setPickChipHighlightItems: (items) => set({ pickChipHighlightItems: items }),

  commitFieldPick: () => {
    const { pendingPickField, normalSelection, onMutation } = get()
    if (!pendingPickField) return
    const selectionId = [...normalSelection].pop()
    if (!selectionId) return

    const _resolveBodyRef = (id: string): string => {
      let bodyRef = id
      if (id.startsWith('body:')) {
        bodyRef = '@' + id.slice(5)
      } else if (id.startsWith('?')) {
        const parsed = parseQuery(id)
        if (parsed.kind === 'ancestry' && parsed.ids.length > 0) {
          bodyRef = parsed.ids[parsed.ids.length - 1]
        }
      } else if (id.startsWith('@') && id.includes('/')) {
        bodyRef = '@' + id.slice(1).split('/')[0]
      }
      // Ensure @body_ prefix so frontend body refs match backend body_store keys.
      if (bodyRef.startsWith('@') && !bodyRef.startsWith('@body_')) {
        bodyRef = '@body_' + bodyRef.slice(1)
      }
      return bodyRef
    }

    if (pendingPickField.field === 'sketch') {
      const sketchQuery = selectionId.startsWith('face:')
        ? selectionId.split(':').slice(2).join(':')  // face pick: pass ancestry query through unchanged
        : selectionId  // raw selection id
      if (pendingPickField.hostKind === 'hole') {
        onMutation?.({ type: 'set_hole_sketch', featureId: pendingPickField.featureId, sketch: sketchQuery })
        set({ pendingPickField: null, normalSelection: new Set(), selectionDomain: 'sketch_2d', pickChipHighlightItems: [] })
        return
      }
      const mutationType = pendingPickField.hostKind === 'revolve' ? 'add_revolve_profile' : 'add_extrude_profile'
      onMutation?.({ type: mutationType, featureId: pendingPickField.featureId, sketchQuery })
      set({ normalSelection: new Set() })  // clear selection but keep pick mode open
      return
    }
    if (pendingPickField.field === 'edges') {
      const edgeQuery = selectionId.startsWith('face:')
        ? selectionId.split(':').slice(2).join(':')
        : selectionId
      const mutationType = pendingPickField.hostKind === 'chamfer' ? 'add_chamfer_edge' : 'add_fillet_edge'
      onMutation?.({ type: mutationType, featureId: pendingPickField.featureId, edgeQuery })
      set({ normalSelection: new Set() })  // clear selection but keep pick mode open
      return
    }
    if (pendingPickField.field === 'axis') {
      const axisQuery = selectionId.startsWith('face:')
        ? selectionId.split(':').slice(2).join(':')
        : selectionId
      onMutation?.({ type: 'set_revolve_axis', featureId: pendingPickField.featureId, axis: axisQuery })
      set({ pendingPickField: null, normalSelection: new Set(), selectionDomain: 'sketch_2d', pickChipHighlightItems: [] })
      return
    }
    if (pendingPickField.field === 'merge_target') {
      const bodyRef = _resolveBodyRef(selectionId)
      onMutation?.({ type: 'set_extrude_merge_target', featureId: pendingPickField.featureId, mergeTarget: bodyRef })
      set({ pendingPickField: null, normalSelection: new Set(), selectionDomain: 'sketch_2d', pickChipHighlightItems: [] })
      return
    }
    if (pendingPickField.field === 'boolean_target') {
      const bodyRef = _resolveBodyRef(selectionId)
      onMutation?.({ type: 'set_boolean_target', featureId: pendingPickField.featureId, target: bodyRef })
      set({ pendingPickField: null, normalSelection: new Set(), selectionDomain: 'sketch_2d', pickChipHighlightItems: [] })
      return
    }
    if (pendingPickField.field === 'boolean_tool') {
      const bodyRef = _resolveBodyRef(selectionId)
      onMutation?.({ type: 'add_boolean_tool', featureId: pendingPickField.featureId, tool: bodyRef })
      set({ normalSelection: new Set() })  // keep pick mode open for multiple tools
      return
    }
    if (pendingPickField.field === 'body') {
      const bodyRef = _resolveBodyRef(selectionId)
      if (pendingPickField.hostKind === 'transform') {
        onMutation?.({ type: 'set_transform_field', featureId: pendingPickField.featureId, field: 'body', value: bodyRef })
      } else {
        onMutation?.({ type: 'set_delete_body_target', featureId: pendingPickField.featureId, body: bodyRef })
      }
      set({ pendingPickField: null, normalSelection: new Set(), selectionDomain: 'sketch_2d', pickChipHighlightItems: [] })
      return
    }
    let value: string
    if (pendingPickField.field === 'rotation_axis' && pendingPickField.hostKind === 'transform') {
      value = selectionId.startsWith('face:')
        ? selectionId.split(':').slice(2).join(':')
        : selectionId
      onMutation?.({ type: 'set_transform_field', featureId: pendingPickField.featureId, field: 'rotation_axis', value })
      set({ pendingPickField: null, normalSelection: new Set(), selectionDomain: 'sketch_2d', pickChipHighlightItems: [] })
      return
    }
    if (pendingPickField.field === 'scale_center_from' && pendingPickField.hostKind === 'transform') {
      value = selectionId.startsWith('face:')
        ? selectionId.split(':').slice(2).join(':')
        : selectionId
      onMutation?.({ type: 'set_transform_field', featureId: pendingPickField.featureId, field: 'scale_center_from', value })
      set({ pendingPickField: null, normalSelection: new Set(), selectionDomain: 'sketch_2d', pickChipHighlightItems: [] })
      return
    }
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
    onMutation?.({ type: 'set_plane_definition_field', featureId: pendingPickField.featureId, field: pendingPickField.field, value })
    set({ pendingPickField: null, normalSelection: new Set(), selectionDomain: 'sketch_2d', pickChipHighlightItems: [] })
  },

  commitPlaneSelection: (selectionId) => {
    const { planeSelectionFeatureId, onMutation } = get()
    if (!planeSelectionFeatureId) return
    const plane = selectionId.startsWith('face:')
      ? selectionId.split(':').slice(2).join(':')
      : selectionId
    onMutation?.({ type: 'set_feature_plane', featureId: planeSelectionFeatureId, plane })
    set({ planeSelectionFeatureId: null, pickChipHighlightItems: [] })
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
