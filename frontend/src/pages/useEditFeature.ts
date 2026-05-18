import { useState, useRef, useCallback, useEffect } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { PartFeature, PartDoc } from '@/types/cad'

const SKETCH_KINDS = new Set(['sketch', 'plane'])

interface UseEditFeatureInput {
  features: PartFeature[]
  rollbackPosition: number | null
  builtInIds: Set<string>
  setRollbackPos: (pos: number | null) => void
  setRollbackFromHandler: (pos: number | null) => void
  setPickBoundary: (b: number | null) => void
  clearPickBodies: () => void
  startEditSession: (suppressUndo: boolean) => void
  commitEditSession: () => void
  cancelEditSession: () => void
  docRef: React.MutableRefObject<PartDoc | null>
  reSolve: (doc: PartDoc, limit?: number | null) => void
  setMode: (mode: 'sketch' | 'feature' | 'code') => void
  getHandleRebuild: () => () => void
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

export function useEditFeature({
  features,
  rollbackPosition,
  builtInIds,
  setRollbackPos,
  setRollbackFromHandler,
  setPickBoundary,
  clearPickBodies,
  startEditSession,
  commitEditSession,
  cancelEditSession,
  docRef,
  reSolve,
  setMode,
  getHandleRebuild,
}: UseEditFeatureInput): UseEditFeatureReturn {
  const setPendingPickField = useSketchEditorStore(s => s.setPendingPickField)

  const [editingFeatureId, setEditingFeatureId] = useState<string | null>(null)
  const [savedRollbackPosition, setSavedRollbackPosition] = useState<number | null>(null)
  const [editForcedVisible, setEditForcedVisible] = useState<Set<string>>(new Set())
  const editEntryRollback = useRef<number | null>(null)
  const prevEditingIdRef = useRef<string | null>(null)

  // Set pick boundary when editing feature changes
  useEffect(() => {
    if (!docRef.current) return
    const prev = prevEditingIdRef.current
    prevEditingIdRef.current = editingFeatureId
    if (prev === editingFeatureId) return

    const feature = features.find(f => f.id === editingFeatureId)
    let nextBoundary: number | null = null
    if (feature && !SKETCH_KINDS.has(feature.kind)) {
      const nonBuiltInFeatures = features.filter(f => !builtInIds.has(f.id))
      const index = nonBuiltInFeatures.findIndex(f => f.id === editingFeatureId)
      if (index >= 0) nextBoundary = index
    }
    setPickBoundary(nextBoundary)
    if (nextBoundary !== null) {
      getHandleRebuild()()
    }
  }, [editingFeatureId, features, setPickBoundary, docRef, builtInIds, getHandleRebuild])

  const _exitEditCleanup = useCallback(() => {
    const targetRollback = savedRollbackPosition !== null ? savedRollbackPosition : rollbackPosition
    if (savedRollbackPosition !== null) {
      if (rollbackPosition === editEntryRollback.current || rollbackPosition === null) {
        setRollbackFromHandler(savedRollbackPosition)
      }
      editEntryRollback.current = null
      setSavedRollbackPosition(null)
    }
    setEditForcedVisible(new Set())
    setEditingFeatureId(null)
    setPendingPickField(null)
    setPickBoundary(null)
    if (docRef.current) reSolve(docRef.current, targetRollback)
  }, [savedRollbackPosition, rollbackPosition, setPendingPickField, setPickBoundary,
      setRollbackFromHandler, docRef, reSolve])

  const enterEditFeature = useCallback((featureId: string, suppressUndo = true) => {
    const idx = features.findIndex(f => f.id === featureId)
    if (idx < 0) return
    startEditSession(suppressUndo)
    setSavedRollbackPosition(rollbackPosition ?? features.length)
    editEntryRollback.current = idx + 1
    setRollbackPos(idx + 1)
    setRollbackFromHandler(idx + 1)
    setEditForcedVisible(new Set([featureId]))
    setEditingFeatureId(featureId)
    setPickBoundary(null)
    clearPickBodies()
  }, [features, rollbackPosition, setPickBoundary, clearPickBodies, setRollbackPos,
      setRollbackFromHandler, startEditSession])

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
    setEditingFeatureId(null)
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
