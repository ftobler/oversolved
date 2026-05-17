import { create } from 'zustand'
import type { BodyResult, PartFeature, PartDoc, Sketch, PartStyleEntry, Mutation, RebuildValidation } from '@/types/cad'

type UndoEntry = { doc: unknown; mutation: Mutation }

export interface PartEditorData {
  features: PartFeature[]
  doc: PartDoc | null
  rollbackPosition: number | null
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

interface PartEditorState extends PartEditorData {
  setSnapshot: (data: PartEditorData) => void
}

export const usePartEditorStore = create<PartEditorState>((set) => ({
  ...DEFAULT_PART_EDITOR_DATA,
  setSnapshot: (data) => set(data),
}))
