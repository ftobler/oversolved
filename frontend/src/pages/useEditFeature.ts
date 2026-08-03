import { useState, useCallback } from 'react'
import type { PartFeature, PartDoc } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

const SKETCH_KINDS = new Set(['sketch', 'plane'])

interface UseEditFeatureInput {
  features: PartFeature[]
  builtInIds: Set<string>
  startEditSession: (suppressUndo: boolean) => void
  commitEditSession: () => void
  cancelEditSession: () => void
  docRef: React.MutableRefObject<PartDoc | null>
  reSolve: (doc: PartDoc, opts?: { validate?: boolean; bypassCache?: boolean; dragAnchor?: { featureId: string; entityId: string } }) => void | Promise<void>
  // Returns false when the page refuses to leave the mode it is in (the code tab
  // holds text that is not a document). A refusal aborts whatever the caller was
  // arranging around the switch.
  setMode: (mode: 'sketch' | 'feature' | 'code') => boolean
  clearPlaneSelection?: () => void
}

interface ResetOpts {
  // Set when the UI reset is a mid-transition step inside enterEditFeature's
  // own close-then-open (see below): the activePickField slot it would
  // otherwise null already belongs to the feature about to open, not the one
  // being closed.
  keepPlaneSelection?: boolean
}

export interface UseEditFeatureReturn {
  editingFeatureId: string | null
  editForcedVisible: Set<string>
  resetEditState: (opts?: ResetOpts) => void
  enterEditFeature: (featureId: string, suppressUndo?: boolean) => void
  commitEditFeature: () => void
  cancelEditFeature: () => void
  exitEditFeature: () => void
  enterEditSketch: (featureId: string) => void
  exitEditSketch: () => void
  clearEditingFeature: () => void
}

function computePickBoundary(
  features: PartFeature[],
  featureId: string,
  builtInIds: Set<string>,
): number | null {
  const feature = features.find(f => f.id === featureId)
  if (!feature || SKETCH_KINDS.has(feature.kind)) return null
  const nonBuiltIns = features.filter(f => !builtInIds.has(f.id))
  const idx = nonBuiltIns.findIndex(f => f.id === featureId)
  return idx >= 0 ? idx : null
}

export function useEditFeature({
  features,
  builtInIds,
  startEditSession,
  commitEditSession,
  cancelEditSession,
  docRef,
  reSolve,
  setMode,
  clearPlaneSelection,
}: UseEditFeatureInput): UseEditFeatureReturn {
  const editingFeatureId = usePartEditorStore(s => s.editingFeatureId)
  const [editForcedVisible, setEditForcedVisible] = useState<Set<string>>(new Set())

  // Everything an edit owns in the UI, dropped without touching the doc. Split
  // out of the exit path because undo/redo needs the same reset but brings its
  // own doc and its own single re-solve.
  const resetEditState = useCallback((opts?: ResetOpts) => {
    if (clearPlaneSelection && !opts?.keepPlaneSelection) clearPlaneSelection()
    const store = usePartEditorStore.getState()
    setEditForcedVisible(new Set())
    store.setEditingFeatureId(null)
    store.setPickBoundary(null)
    // Entering an edit pins the bar just after the edited feature; leaving it
    // returns the bar to where the user parked it (null = end of stack).
    store.setRollbackPosition(docRef.current?.rollback ?? null)
  }, [docRef, clearPlaneSelection])

  // One-open-editor discipline (the same rule assembly-session-hygiene enforces
  // for the assembly editor, `AssemblyEditor.tsx`'s closeOpenEditor): every
  // caller that asks to open a feature's edit session while a DIFFERENT one is
  // still open -- the FeatureTree Edit button, plane-on-face, anything else --
  // closes the open one FIRST, committing it into its own undo entry. Nesting
  // used to only failLoud-and-clobber the outer snapshot in prod; now it
  // cannot happen at all, because every path funnels through this one function.
  const enterEditFeature = useCallback((featureId: string, suppressUndo = true) => {
    const idx = features.findIndex(f => f.id === featureId)
    if (idx < 0) return
    const feature = features[idx]
    const activeEditingId = usePartEditorStore.getState().editingFeatureId
    if (activeEditingId !== null && activeEditingId !== featureId) {
      commitEditSession()
      // activePickField can already be targeting the feature we are about to
      // open below (plane-on-face arms it on the newly-created sketch before
      // this runs), so only drop it when it belongs to something else. It is
      // consumed synchronously by the enter that follows in this same call,
      // so there is no window for a stale value to leak; code mode cannot be
      // active here either, since entering it already tears down any open
      // session (setMode('code') -> discardHistoryAndSessions/discardSessions).
      const pickField = useSketchEditorStore.getState().activePickField
      // resetEditState does not itself re-solve -- only the tail of this
      // function does -- so closing the old editor and opening this one
      // together cost exactly one solve, not two.
      resetEditState({ keepPlaneSelection: pickField?.featureId === featureId })
    }
    startEditSession(suppressUndo)
    const store = usePartEditorStore.getState()
    const pickBoundary = computePickBoundary(features, featureId, builtInIds)
    if (feature.kind === 'sketch') {
      store.setActiveSketchFeatureId(featureId)
    }
    store.setRollbackPosition(idx + 1)
    store.setPickBoundary(pickBoundary)
    store.setEditingFeatureId(featureId)
    setEditForcedVisible(new Set([featureId]))
    if (docRef.current) reSolve(docRef.current)
  }, [features, builtInIds, startEditSession, commitEditSession, resetEditState, docRef, reSolve])

  const _exitEditCleanup = useCallback(() => {
    resetEditState()
    if (docRef.current) reSolve(docRef.current)
  }, [resetEditState, docRef, reSolve])

  const commitEditFeature = useCallback(() => {
    commitEditSession()
    _exitEditCleanup()
  }, [commitEditSession, _exitEditCleanup])

  // Reset before cancelling: cancelEditSession re-solves the snapshot it
  // restores, and the edit-mode rollback/pick_boundary would truncate that
  // payload to the edited feature.
  const cancelEditFeature = useCallback(() => {
    resetEditState()
    cancelEditSession()
  }, [cancelEditSession, resetEditState])

  const exitEditFeature = useCallback(() => {
    commitEditFeature()
  }, [commitEditFeature])

  // The mode switch goes FIRST because it can be refused: starting the session
  // and then failing to leave the code tab strands a half-open edit behind the
  // textarea, with no sketch toolbar and the viewport hidden. Asking first also
  // means the session snapshots the document the code tab just applied, rather
  // than the one it replaced.
  const enterEditSketch = useCallback((featureId: string) => {
    if (!setMode('sketch')) return
    enterEditFeature(featureId, false)  // sketch: don't suppress undo
  }, [enterEditFeature, setMode])

  const exitEditSketch = useCallback(() => {
    commitEditFeature()  // sketch exits always commit
  }, [commitEditFeature])

  const clearEditingFeature = useCallback(() => {
    usePartEditorStore.getState().setEditingFeatureId(null)
  }, [])

  return {
    editingFeatureId,
    editForcedVisible,
    resetEditState,
    enterEditFeature,
    commitEditFeature,
    cancelEditFeature,
    exitEditFeature,
    enterEditSketch,
    exitEditSketch,
    clearEditingFeature,
  }
}
