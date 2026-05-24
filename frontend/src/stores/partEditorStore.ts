import { create } from 'zustand'
import type { BodyResult, PartFeature, PartDoc, Sketch, PartStyleEntry, Mutation, RebuildValidation } from '@/types/cad'

type UndoEntry = { doc: unknown; mutation: Mutation }

export interface PartEditorData {
  features: PartFeature[]
  doc: PartDoc | null
  rollbackPosition: number | null
  pickBoundary: number | null
  editingFeatureId: string | null
  activeSketchFeatureId: string | null
  visibleFeatures: Set<string>
  visibleBodies: Set<string> | undefined
  partLabels: Record<string, string>
  solveResults: Record<string, unknown>
  bodies: Record<string, BodyResult>
  pickBodies: Record<string, BodyResult>
  isRebuilding: boolean
  featureTimings: Record<string, number>
  validation: RebuildValidation | null
  ghostMode: boolean
  otherSketches: Record<string, Sketch>
  partColors: Record<string, string>
  partStyle: Record<string, PartStyleEntry>
  undoStack: UndoEntry[]
  redoStack: UndoEntry[]
}

export const DEFAULT_PART_EDITOR_DATA: PartEditorData = {
  features: [],
  doc: null,
  rollbackPosition: null,
  pickBoundary: null,
  editingFeatureId: null,
  activeSketchFeatureId: null,
  visibleFeatures: new Set(),
  visibleBodies: undefined,
  partLabels: {},
  solveResults: {},
  bodies: {},
  pickBodies: {},
  isRebuilding: false,
  featureTimings: {},
  validation: null,
  ghostMode: false,
  otherSketches: {},
  partColors: {},
  partStyle: {},
  undoStack: [],
  redoStack: [],
}

// Fields owned exclusively by the store (not overwritten by setSnapshot).
// These are the source of truth for the rollback/edit FSM and are mutated
// only through their dedicated setters.
const STORE_OWNED_FIELDS = ['rollbackPosition', 'pickBoundary', 'editingFeatureId'] as const

interface PartEditorState extends PartEditorData {
  setSnapshot: (data: PartEditorData) => void
  setActiveSketchFeatureId: (id: string | null) => void
  setRollbackPosition: (pos: number | null) => void
  setPickBoundary: (pos: number | null) => void
  setEditingFeatureId: (id: string | null) => void
}

export const usePartEditorStore = create<PartEditorState>((set) => ({
  ...DEFAULT_PART_EDITOR_DATA,
  setSnapshot: (data) => set((prev) => {
    // Preserve store-owned fields; setSnapshot is for React-mirrored state only.
    // Callers write owned fields via their dedicated setters.
    const prevRec = prev as unknown as Record<string, unknown>
    const merged = { ...data } as unknown as Record<string, unknown>
    for (const field of STORE_OWNED_FIELDS) {
      merged[field] = prevRec[field]
    }
    return merged as unknown as PartEditorData
  }),
  setActiveSketchFeatureId: (id) => set({ activeSketchFeatureId: id }),
  setRollbackPosition: (pos) => set({ rollbackPosition: pos }),
  setPickBoundary: (pos) => set({ pickBoundary: pos }),
  setEditingFeatureId: (id) => set({ editingFeatureId: id }),
}))
