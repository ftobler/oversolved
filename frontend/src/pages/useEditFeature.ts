import { useState, useCallback } from 'react'
import type { PartFeature, PartDoc } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'

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

interface ExitOpts {
  // Set when a caller is about to open a different feature's session right
  // after this one closes (plane-on-face's exit-before-enter): the pending
  // plane pick for that NEXT feature lives in the same activePickField slot
  // clearPlaneSelection would otherwise null out from under it.
  keepPlaneSelection?: boolean
}

export interface UseEditFeatureReturn {
  editingFeatureId: string | null
  editForcedVisible: Set<string>
  resetEditState: (opts?: ExitOpts) => void
  enterEditFeature: (featureId: string, suppressUndo?: boolean) => void
  commitEditFeature: (opts?: ExitOpts) => void
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

  const enterEditFeature = useCallback((featureId: string, suppressUndo = true) => {
    const idx = features.findIndex(f => f.id === featureId)
    if (idx < 0) return
    const feature = features[idx]
    const activeEditingId = usePartEditorStore.getState().editingFeatureId
    if (activeEditingId !== null && activeEditingId !== featureId) {
      // Nesting is structurally impossible, not just loud: a caller must
      // close (commit or cancel) whatever session is open before opening
      // another feature's. Plane-on-face (Part.tsx) does exactly that,
      // committing the outer session itself before requesting this one.
      return
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
  }, [features, builtInIds, startEditSession, docRef, reSolve])

  // Everything an edit owns in the UI, dropped without touching the doc. Split
  // out of the exit path because undo/redo needs the same reset but brings its
  // own doc and its own single re-solve.
  const resetEditState = useCallback((opts?: ExitOpts) => {
    if (clearPlaneSelection && !opts?.keepPlaneSelection) clearPlaneSelection()
    const store = usePartEditorStore.getState()
    setEditForcedVisible(new Set())
    store.setEditingFeatureId(null)
    store.setPickBoundary(null)
    // Entering an edit pins the bar just after the edited feature; leaving it
    // returns the bar to where the user parked it (null = end of stack).
    store.setRollbackPosition(docRef.current?.rollback ?? null)
  }, [docRef, clearPlaneSelection])

  const _exitEditCleanup = useCallback((opts?: ExitOpts) => {
    resetEditState(opts)
    if (docRef.current) reSolve(docRef.current)
  }, [resetEditState, docRef, reSolve])

  const commitEditFeature = useCallback((opts?: ExitOpts) => {
    commitEditSession()
    _exitEditCleanup(opts)
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
