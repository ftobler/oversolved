// The sketch editor's UI-facing store: preferences and the pending value
// dialog / context menu. Everything that is editor state rather than chrome --
// selection, hover, the active tool, draw state, drag state and the part
// rollback/edit FSM -- moved to stores/editorState.ts (L2) and is re-exported
// here under the historical name below, so the many existing importers keep
// one entry point. The value dialog stays here; editorState reaches it through
// the sketchCallbacks ports registered at the bottom.
import { create } from 'zustand'
import type { DialogState } from './sketchEditorTypes'
import { sketchCallbacks } from './sketchEditorCallbacks'

export interface SketchUiState {
  showDebugHit: boolean
  showConstraintTiles: boolean
  ngonSides: number  // side count for the two-click n-gon draw tool
  pendingDialog: DialogState | null
  contextMenu: [number, number] | null
  setShowDebugHit: (enabled: boolean) => void
  setShowConstraintTiles: (show: boolean) => void
  // Clamp to the n-gon range (3..64) so the draw tool and preview never see a
  // degenerate count.
  setNgonSides: (n: number) => void
  openDialog: (opts: DialogState) => void
  closeDialog: () => void
  openContextMenu: (pos: [number, number]) => void
  closeContextMenu: () => void
  // The canonical UI wipe: closes the pending value dialog and the context
  // menu, leaving user preferences intact. Every "drop the editor's transient
  // state" call site must delegate here (Part's teardown calls this and the
  // editor store's resetTransientState together), never hand-list the fields.
  resetTransientState: () => void
}

export const useSketchUiStore = create<SketchUiState>((set) => ({
  showDebugHit: false,
  showConstraintTiles: true,
  ngonSides: 6,
  pendingDialog: null,
  contextMenu: null,

  setShowDebugHit: (enabled) => set({ showDebugHit: enabled }),

  setShowConstraintTiles: (show) => set({ showConstraintTiles: show }),

  setNgonSides: (n) => set({ ngonSides: Math.max(3, Math.min(64, Math.round(n) || 6)) }),

  openDialog: (opts) => set({ pendingDialog: opts }),
  // Guarded so the editor-state gesture abort, which fires this on every
  // dimension cancel, does not mint a fresh state and notify with nothing open.
  closeDialog: () => set(s => s.pendingDialog === null ? s : { pendingDialog: null }),
  openContextMenu: (pos) => set({ contextMenu: pos }),
  closeContextMenu: () => set({ contextMenu: null }),

  resetTransientState: () => set({ pendingDialog: null, contextMenu: null }),
}))

// The editor-state store asks the UI store to open/close the value dialog
// through these ports. Registering at module scope keeps the two stores
// acyclic and means any test that imports this module finds the ports live.
sketchCallbacks.openDialog = dialog => useSketchUiStore.getState().openDialog(dialog)
sketchCallbacks.closeDialog = () => useSketchUiStore.getState().closeDialog()

// The editor-state store under its historical name. Selection, hover, the
// active tool, draw state and the rollback/edit FSM live in editorState.ts;
// this re-export keeps the ~130 existing import sites on one hook.
export { useEditorState as useSketchEditorStore } from '@/hooks/useEditorState'
export { useEditorState } from '@/hooks/useEditorState'
export { editorState, clampRollback, DEFAULT_EDITOR_STATE, sketchOwnedDeleteTargets } from './editorState'
export type { EditorState, PartEditorFsm, ViewportDerivedState } from './editorState'

// Public surface preserved for existing consumers: the callback registry, the
// pure helper exports, and every type the module used to declare locally.
export { setSketchCallback, getSketchCallback, CANNOT_APPLY_TITLE } from './sketchEditorCallbacks'
export type { PendingConstraint, SketchMessage } from './sketchEditorCallbacks'
export { prunePickClaims, getEffectiveTool } from './sketchEditorHelpers'
export type {
  DialogState,
  VertexOrEdgeDrag,
  DimLabelDrag,
  FeatureHandleDrag,
  DragState,
  EdgeVertexDragPending,
  DimLabelDragPending,
  FeatureHandleDragPending,
  DragPendingState,
  ActivePickField,
} from './sketchEditorTypes'
