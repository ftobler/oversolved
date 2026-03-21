import { create } from 'zustand'

// Mutation types dispatched to the parent (Part.tsx) for YAML AST manipulation + re-solve
export type Mutation =
  | { type: 'move_vertex'; featureId: string; entityId: string; vertexKey: string; to: [number, number] }
  | { type: 'move_entity'; featureId: string; entityId: string; delta: [number, number] }
  | { type: 'add_constraint'; featureId: string; kind: string; targets: string[] }
  | { type: 'set_constraint_value'; featureId: string; constraintId: string; value: number }
  | { type: 'delete'; targets: string[] }
  | { type: 'add_entity'; featureId: string; kind: string; params: number[] }

export type ActiveTool = 'select' | 'dimension' | 'line' | 'rect' | 'circle' | 'arc' | 'point'

export interface DragState {
  type: 'vertex' | 'edge'
  vertexId: string       // full composite ID (entity ID for edge drags)
  featureId: string
  entityId: string
  vertexKey: string      // "start" | "end" | "center" | "xy" | "edge"
  startWorld: [number, number]
  currentWorld: [number, number]
}

interface SketchEditorState {
  // --- state ---
  selection: Set<string>
  drag: DragState | null
  orbitEnabled: boolean
  onMutation: ((m: Mutation) => void) | null
  hoveredConstraintEntityIds: Set<string>  // entity IDs highlighted by constraint hover
  activeTool: ActiveTool
  drawPoints: [number, number][]
  drawHover: [number, number] | null

  // --- actions ---
  toggleSelect: (id: string) => void
  clearSelection: () => void
  setDrag: (drag: DragState | null) => void
  setOrbitEnabled: (enabled: boolean) => void
  setOnMutation: (cb: ((m: Mutation) => void) | null) => void
  setHoveredConstraintEntities: (ids: Set<string>) => void
  setActiveTool: (tool: ActiveTool) => void
  applyConstraint: (kind: string) => void
  deleteSelected: () => void
  addDrawPoint: (pt: [number, number]) => void
  setDrawHover: (pt: [number, number] | null) => void
  clearDraw: () => void
}

export const useSketchEditorStore = create<SketchEditorState>((set, get) => ({
  selection: new Set(),
  drag: null,
  orbitEnabled: true,
  onMutation: null,
  hoveredConstraintEntityIds: new Set(),
  activeTool: 'select',
  drawPoints: [],
  drawHover: null,

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

  setHoveredConstraintEntities: (ids) => set({ hoveredConstraintEntityIds: ids }),

  setActiveTool: (tool) => set({ activeTool: tool, drawPoints: [], drawHover: null }),

  applyConstraint: (kind) => {
    const { selection, onMutation } = get()
    if (selection.size === 0 || !onMutation) return
    // Derive featureId from first selected element (all must share same feature for now)
    const targets = [...selection]
    const firstParts = targets[0].split(':')
    const featureId = firstParts[1] ?? ''
    onMutation({ type: 'add_constraint', featureId, kind, targets })
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
}))
