import { create } from 'zustand'
import type { BodyResult, PartFeature, PartDoc, Sketch, PartStyleEntry, Mutation, RebuildValidation } from '@/types/cad'

type UndoEntry = { doc: unknown; mutation: Mutation }

interface PartEditorData {
  features: PartFeature[]
  doc: PartDoc | null
  rollbackPosition: number | null
  editingFeatureId: string | null
  activeSketchFeatureId: string | null
  visibleFeatures: Set<string>
  visibleBodies: Set<string>
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

interface PartEditorState extends PartEditorData {
  sync: (patch: Partial<PartEditorData>) => void
}

export const usePartEditorStore = create<PartEditorState>((set) => ({
  features: [],
  doc: null,
  rollbackPosition: null,
  editingFeatureId: null,
  activeSketchFeatureId: null,
  visibleFeatures: new Set(),
  visibleBodies: new Set(),
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
  sync: (patch) => set(patch),
}))
