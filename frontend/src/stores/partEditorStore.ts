import { create } from 'zustand'
import type { BodyResult, PartFeature, PartDoc } from '@/types/cad'

interface PartEditorState {
  features: PartFeature[]
  doc: PartDoc | null
  rollbackPosition: number | null
  editingFeatureId: string | null
  visibleFeatures: Set<string>
  visibleBodies: Set<string>
  partLabels: Record<string, string>
  solveResults: Record<string, unknown>
  bodies: Record<string, BodyResult>
  isRebuilding: boolean
  featureTimings: Record<string, number>
  // setters
  setFeatures: (f: PartFeature[]) => void
  setDoc: (doc: PartDoc | null) => void
  setRollbackPosition: (pos: number | null) => void
  setEditingFeatureId: (id: string | null) => void
  setVisibleFeatures: (vf: Set<string>) => void
  setVisibleBodies: (vb: Set<string>) => void
  setPartLabels: (labels: Record<string, string>) => void
  setSolveResults: (r: Record<string, unknown>) => void
  setBodies: (b: Record<string, BodyResult>) => void
  setIsRebuilding: (v: boolean) => void
  setFeatureTimings: (t: Record<string, number>) => void
}

export const usePartEditorStore = create<PartEditorState>((set) => ({
  features: [],
  doc: null,
  rollbackPosition: null,
  editingFeatureId: null,
  visibleFeatures: new Set(),
  visibleBodies: new Set(),
  partLabels: {},
  solveResults: {},
  bodies: {},
  isRebuilding: false,
  featureTimings: {},
  setFeatures: (features) => set({ features }),
  setDoc: (doc) => set({ doc }),
  setRollbackPosition: (rollbackPosition) => set({ rollbackPosition }),
  setEditingFeatureId: (editingFeatureId) => set({ editingFeatureId }),
  setVisibleFeatures: (visibleFeatures) => set({ visibleFeatures }),
  setVisibleBodies: (visibleBodies) => set({ visibleBodies }),
  setPartLabels: (partLabels) => set({ partLabels }),
  setSolveResults: (solveResults) => set({ solveResults }),
  setBodies: (bodies) => set({ bodies }),
  setIsRebuilding: (isRebuilding) => set({ isRebuilding }),
  setFeatureTimings: (featureTimings) => set({ featureTimings }),
}))
