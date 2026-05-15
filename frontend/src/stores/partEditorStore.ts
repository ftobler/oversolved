import { create } from 'zustand'
import type { BodyResult, PartFeature, PartDoc } from '@/types/cad'

interface PartEditorData {
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
}

interface PartEditorState extends PartEditorData {
  sync: (patch: Partial<PartEditorData>) => void
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
  sync: (patch) => set(patch),
}))
