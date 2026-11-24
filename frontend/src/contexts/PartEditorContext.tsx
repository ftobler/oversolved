import { createContext, useContext } from 'react'
import type { Mutation } from '@/types/cad'
import type { ContextMenuSurface, RenameTarget } from '@/pages/buildContextMenu'

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
  onRightClick: (pos: [number, number], targetId?: string, surface?: ContextMenuSurface) => void
  onRename?: (featureId: string, label: string) => void
  // The same dialog opener the tree menu uses: one RenameDialog, one confirm
  // path. Absent in headless callers, which is why the card hides its button.
  onRequestRename?: (target: RenameTarget) => void
  onMutation: (mutation: Mutation) => void
  // The editor's group seam: mutations that belong to one user gesture land as
  // one undo step (a pick field's whole arriving lasso).
  onMutationBatch?: (mutations: Mutation[]) => void
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
