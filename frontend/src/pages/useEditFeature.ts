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
  setMode: (mode: 'sketch' | 'feature' | 'code') => void
  // Called on edit exit to drop the sketch-on-face FSM state. Optional so
  // tests / future call sites that don't use plane picking can omit it.
  clearPlaneSelection?: () => void
}

export interface UseEditFeatureReturn {
  editingFeatureId: string | null
  editForcedVisible: Set<string>
  enterEditFeature: (featureId: string, suppressUndo?: boolean) => void
  commitEditFeature: () => void
  cancelEditFeature: () => void
  exitEditFeature: () => void
  enterEditSketch: (featureId: string) => void
  exitEditSketch: () => void
  clearEditingFeature: () => void
}

/**
 * Compute pick_boundary for the feature being edited. Sketches/planes don't
 * use a pick boundary (their picks resolve against the full body state). For
 * solid-modifying features (extrude, fillet, etc.) the boundary is the
 * non-builtin index of the feature -- picks resolve against the body
 * checkpoint frozen just before that feature ran.
 */
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
  const [savedRollbackPosition, setSavedRollbackPosition] = useState<number | null>(null)
  const [editForcedVisible, setEditForcedVisible] = useState<Set<string>>(new Set())

  const enterEditFeature = useCallback((featureId: string, suppressUndo = true) => {
    const idx = features.findIndex(f => f.id === featureId)
    if (idx < 0) return
    const feature = features[idx]
    startEditSession(suppressUndo)
    const store = usePartEditorStore.getState()
    setSavedRollbackPosition(store.rollbackPosition ?? features.length)
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

  const _exitEditCleanup = useCallback(() => {
    if (clearPlaneSelection) clearPlaneSelection()
    const store = usePartEditorStore.getState()
    const targetRollback = savedRollbackPosition
    setSavedRollbackPosition(null)
    setEditForcedVisible(new Set())
    store.setEditingFeatureId(null)
    store.setPickBoundary(null)
    store.setRollbackPosition(targetRollback)
    if (docRef.current) reSolve(docRef.current)
  }, [savedRollbackPosition, docRef, reSolve, clearPlaneSelection])

  const commitEditFeature = useCallback(() => {
    commitEditSession()
    _exitEditCleanup()
  }, [commitEditSession, _exitEditCleanup])

  const cancelEditFeature = useCallback(() => {
    cancelEditSession()
    _exitEditCleanup()
  }, [cancelEditSession, _exitEditCleanup])

  const exitEditFeature = useCallback(() => {
    commitEditFeature()
  }, [commitEditFeature])

  const enterEditSketch = useCallback((featureId: string) => {
    enterEditFeature(featureId, false)  // sketch: don't suppress undo
    setMode('sketch')
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
    enterEditFeature,
    commitEditFeature,
    cancelEditFeature,
    exitEditFeature,
    enterEditSketch,
    exitEditSketch,
    clearEditingFeature,
  }
}
