import { create } from 'zustand'

// Mutation types dispatched to the parent (Part.tsx) for YAML AST manipulation + re-solve
export type Mutation =
  | { type: 'move_vertex'; featureId: string; entityId: string; vertexKey: string; to: [number, number] }
  | { type: 'add_constraint'; featureId: string; kind: string; targets: string[] }
  | { type: 'delete'; targets: string[] }

export interface DragState {
  vertexId: string       // full composite ID
  featureId: string
  entityId: string
  vertexKey: string      // "start" | "end" | "center" | "x,y"
  startWorld: [number, number]
  currentWorld: [number, number]
}

interface SketchEditorState {
  // --- state ---
  selection: Set<string>
  drag: DragState | null
  orbitEnabled: boolean
  onMutation: ((m: Mutation) => void) | null

  // --- actions ---
  toggleSelect: (id: string) => void
  clearSelection: () => void
  setDrag: (drag: DragState | null) => void
  setOrbitEnabled: (enabled: boolean) => void
  setOnMutation: (cb: ((m: Mutation) => void) | null) => void
  applyConstraint: (kind: string) => void
  deleteSelected: () => void
}

export const useSketchEditorStore = create<SketchEditorState>((set, get) => ({
  selection: new Set(),
  drag: null,
  orbitEnabled: true,
  onMutation: null,

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
}))
