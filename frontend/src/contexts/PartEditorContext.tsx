import { createContext, useContext } from 'react'
import type { Mutation } from '@/types/cad'

export interface PartEditorCallbacks {
  onToggleSelect: (id: string) => void
  onEnterEditSketch: (featureId: string) => void
  onExitEditSketch: () => void
  onAlignCameraToSketchPlane?: () => void
  onEnterEditFeature: (featureId: string) => void
  onExitEditFeature: () => void
  onEditCommit: () => void
  onEditCancel: () => void
  onToggleVisibility: (featureId: string) => void
  onRightClick: (pos: [number, number], targetId?: string) => void
  onRename?: (featureId: string, label: string) => void
  onMutation: (mutation: Mutation) => void
  onSetRollbackPosition: (pos: number | null) => void
  onRebuild?: () => void
}

const PartEditorContext = createContext<PartEditorCallbacks | null>(null)

export const PartEditorProvider = PartEditorContext.Provider

export function usePartEditorCallbacks(): PartEditorCallbacks {
  const ctx = useContext(PartEditorContext)
  if (!ctx) throw new Error('usePartEditorCallbacks must be used inside PartEditorProvider')
  return ctx
}
