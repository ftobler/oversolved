import { create } from 'zustand'
import type { Mutation } from '../types/cad'
import { resolveSingleEntityDimension, resolveTwoTargetDimension } from '../registry'

// Mutation types dispatched to the parent (Part.tsx) for YAML AST manipulation + re-solve
export type { Mutation }

export type ActiveTool = 'select' | 'dimension' | 'line' | 'rect' | 'center_rect' | 'circle' | 'arc' | 'point'

export interface DialogState {
  position: [number, number]
  label: string
  defaultValue?: string
  onConfirm: (val: string) => void
  onCancel?: () => void
}

/** Dragging a geometry vertex or whole edge. */
export interface VertexOrEdgeDrag {
  type: 'vertex' | 'edge'
  vertexId: string       // full composite ID (entity ID for edge drags)
  featureId: string
  entityId: string
  vertexKey: string      // "start" | "end" | "center" | "xy" | "edge"
  startWorld: [number, number]
  currentWorld: [number, number]
}

/** Dragging a dimension label to reposition it. */
export interface DimLabelDrag {
  type: 'dim_label'
  constraintId: string
  featureId: string
  /** World-space anchor for the label (midpoint of measured points, center, or vertex). */
  anchorWorld: [number, number]
  startWorld: [number, number]
  currentWorld: [number, number]
}

export type DragState = VertexOrEdgeDrag | DimLabelDrag

interface SketchEditorState {
  // --- state ---
  selection: Set<string>
  drag: DragState | null
  orbitEnabled: boolean
  onMutation: ((m: Mutation) => void) | null
  hoveredConstraintEntityIds: Set<string>  // entity IDs highlighted by constraint hover
  activeTool: ActiveTool
  activeFeatureId: string | null           // the sketch currently being edited
  drawPoints: [number, number][]
  drawHover: [number, number] | null
  pendingDimTarget: string | null       // first click target when doing two-target dimension
  pendingDimEntityKind: string | null   // entity kind of the first click target
  pendingDialog: DialogState | null
  planeSelectionFeatureId: string | null

  // --- actions ---
  toggleSelect: (id: string) => void
  clearSelection: () => void
  setDrag: (drag: DragState | null) => void
  setOrbitEnabled: (enabled: boolean) => void
  setOnMutation: (cb: ((m: Mutation) => void) | null) => void
  setActiveFeatureId: (id: string | null) => void
  setHoveredConstraintEntities: (ids: Set<string>) => void
  setActiveTool: (tool: ActiveTool) => void
  applyConstraint: (kind: string) => void
  toggleConstruction: () => void
  deleteSelected: () => void
  addDrawPoint: (pt: [number, number]) => void
  setDrawHover: (pt: [number, number] | null) => void
  clearDraw: () => void
  openDialog: (opts: DialogState) => void
  closeDialog: () => void
  handleDimensionClick: (target: string, featureId: string, kind: 'entity' | 'vertex', screenPos: [number, number], entityKind?: string) => void
  setPlaneSelectionFeatureId: (id: string | null) => void
  commitPlaneSelection: (selectionId: string) => void
}

export const useSketchEditorStore = create<SketchEditorState>((set, get) => ({
  selection: new Set(),
  drag: null,
  orbitEnabled: true,
  onMutation: null,
  hoveredConstraintEntityIds: new Set(),
  activeTool: 'select',
  activeFeatureId: null,
  drawPoints: [],
  drawHover: null,
  pendingDimTarget: null,
  pendingDimEntityKind: null,
  pendingDialog: null,
  planeSelectionFeatureId: null,

  toggleSelect: (id) =>
    set(s => {
      const next = new Set(s.selection)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { selection: next }
    }),

  clearSelection: () => set({ selection: new Set() }),

  setDrag: (drag) => set({ drag }),

  setOrbitEnabled: (enabled) => set({ orbitEnabled: enabled }),

  setOnMutation: (cb) => set({ onMutation: cb }),

  setActiveFeatureId: (id) => set({ activeFeatureId: id }),

  setHoveredConstraintEntities: (ids) => set({ hoveredConstraintEntityIds: ids }),

  setActiveTool: (tool) => set({ activeTool: tool, drawPoints: [], drawHover: null }),

  applyConstraint: (kind) => {
    const { selection, onMutation, activeFeatureId } = get()
    if (selection.size === 0 || !onMutation || !activeFeatureId) return
    const targets = [...selection]
    onMutation({ type: 'add_constraint', featureId: activeFeatureId, kind, targets })
  },

  toggleConstruction: () => {
    const { selection, onMutation } = get()
    if (selection.size === 0 || !onMutation) return
    const targets = [...selection].filter(t => t.startsWith('entity:'))
    if (targets.length === 0) return
    onMutation({ type: 'toggle_construction', targets })
  },

  deleteSelected: () => {
    const { selection, onMutation } = get()
    if (selection.size === 0 || !onMutation) return
    onMutation({ type: 'delete', targets: [...selection] })
    set({ selection: new Set() })
  },

  addDrawPoint: (pt) => set(s => ({ drawPoints: [...s.drawPoints, pt] })),
  setDrawHover: (pt) => set({ drawHover: pt }),
  clearDraw: () => set({ drawPoints: [], drawHover: null }),

  openDialog: (opts) => set({ pendingDialog: opts }),
  closeDialog: () => set({ pendingDialog: null }),

  setPlaneSelectionFeatureId: (id) => set({ planeSelectionFeatureId: id }),

  commitPlaneSelection: (selectionId) => {
    const { planeSelectionFeatureId, onMutation } = get()
    if (!planeSelectionFeatureId) return
    const plane = selectionId.startsWith('face:')
      ? selectionId.split(':').slice(2).join(':')
      : selectionId
    onMutation?.({ type: 'set_feature_plane', featureId: planeSelectionFeatureId, plane })
    set({ planeSelectionFeatureId: null })
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
              set({ activeTool: 'select', pendingDimTarget: null, pendingDimEntityKind: null })
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
            set({ activeTool: 'select' })
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
          set({ activeTool: 'select' })
        },
      })
    }
  },
}))
