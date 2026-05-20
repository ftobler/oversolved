import { useCallback, useEffect, useRef } from 'react'
import type { PartDoc, Mutation } from '@/types/cad'
import { useDocumentState } from '@/hooks/useDocumentState'
import { useSolver } from '@/hooks/useSolver'
import { useUndoRedo } from '@/hooks/useUndoRedo'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { failLoud } from '@/stores/stateInvariants'

export { healDoc, BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS } from '@/hooks/useDocumentState'

export function usePartDoc(uuid: string | undefined, mode: string, setCodeText: (t: string) => void, { solveOnLoad = true, onFirstSolve }: { solveOnLoad?: boolean; onFirstSolve?: () => void } = {}) {
  const modeRef = useRef(mode)
  useEffect(() => { modeRef.current = mode }, [mode])

  const reSolveRef = useRef<((d: PartDoc) => void) | null>(null)

  const {
    doc, setDoc, docRef, docName, setDocName, ownerUsername,
    loading, error, setError, permission, isPublic,
    saveDoc, renameDoc,
  } = useDocumentState(uuid, reSolveRef, { solveOnLoad })

  const {
    solveResults, setSolveResults, bodies, pickBodies, setPickBodies,
    solving, solveTime, solveError, setSolveError, solveResult, setSolveRawResult,
    featureTimings, reSolve, setRollbackPos, setPickBoundary,
    validation, clearValidation,
  } = useSolver(uuid, setCodeText, modeRef, { onFirstSolve }, docRef, setDoc)

  useEffect(() => { reSolveRef.current = reSolve }, [reSolve])

  const {
    undoStack, redoStack, suppressUndoRef, pushUndo, handleUndo, handleRedo,
    saveUndoStackSnapshot, restoreUndoStackSnapshot, clearUndoStackSnapshot,
  } = useUndoRedo(docRef, setDoc, reSolve)

  const handleMutation = useCallback((m: Mutation) => {
    setSolveError(null)
    const current = docRef.current
    if (!current) return

    setSolveResults(prev => {
      if (m.type === 'delete_feature') {
        const next = { ...prev }
        delete next[m.featureId]
        return next
      }
      if (m.type === 'delete') {
        return {}
      }
      return prev
    })

    const next: PartDoc = structuredClone(current)
    if (!suppressUndoRef.current) {
      pushUndo(m, current)
    }
    type AnyHandler = (doc: PartDoc, m: Mutation) => void
    const handler = (mutationHandlers as Record<string, AnyHandler | undefined>)[m.type]
    if (import.meta.env.DEV && !handler) {
      console.error(`[handleMutation] no handler for mutation type: ${m.type}`)
    }
    handler?.(next, m)

    docRef.current = next
    setDoc(next)
    reSolve(next, undefined, { bypassCache: true })
  }, [docRef, setDoc, reSolve, setSolveResults, setSolveError, suppressUndoRef, pushUndo])

  const previewOriginalDoc = useRef<PartDoc | null>(null)

  const startPreviewMode = useCallback((originalDoc: PartDoc) => {
    if (previewOriginalDoc.current !== null) {
      failLoud('[usePartDoc] startPreviewMode called while a preview is already active (nested preview not supported)')
    }
    previewOriginalDoc.current = structuredClone(originalDoc)
    suppressUndoRef.current = true
  }, [suppressUndoRef])

  const commitPreview = useCallback((mutation: Mutation) => {
    if (!previewOriginalDoc.current) {
      failLoud('[usePartDoc] commitPreview called with no active preview')
      return
    }
    pushUndo(mutation, previewOriginalDoc.current)
    suppressUndoRef.current = false
    previewOriginalDoc.current = null
  }, [suppressUndoRef, pushUndo])

  const cancelPreview = useCallback(() => {
    if (!previewOriginalDoc.current) {
      failLoud('[usePartDoc] cancelPreview called with no active preview')
      return null
    }
    suppressUndoRef.current = false
    const original = previewOriginalDoc.current
    previewOriginalDoc.current = null
    return original
  }, [suppressUndoRef])

  const editSnapshotRef = useRef<PartDoc | null>(null)

  const startEditSession = useCallback((suppressUndo: boolean) => {
    if (!docRef.current) return
    if (editSnapshotRef.current !== null) {
      failLoud('[usePartDoc] startEditSession called while an edit session is already active (nested edit session not supported)')
    }
    editSnapshotRef.current = structuredClone(docRef.current)
    saveUndoStackSnapshot()
    if (suppressUndo) {
      suppressUndoRef.current = true
    }
  }, [docRef, saveUndoStackSnapshot, suppressUndoRef])

  const commitEditSession = useCallback(() => {
    if (editSnapshotRef.current === null) {
      failLoud('[usePartDoc] commitEditSession called with no active edit session')
      return
    }
    const snapshot = editSnapshotRef.current
    editSnapshotRef.current = null
    suppressUndoRef.current = false
    if (snapshot && docRef.current) {
      pushUndo(
        { type: 'edit_session', featureId: '' },
        snapshot,
      )
    }
    clearUndoStackSnapshot()
  }, [suppressUndoRef, pushUndo, clearUndoStackSnapshot, docRef])

  const cancelEditSession = useCallback(() => {
    if (editSnapshotRef.current === null) {
      failLoud('[usePartDoc] cancelEditSession called with no active edit session')
      return
    }
    suppressUndoRef.current = false
    const snapshot = editSnapshotRef.current
    editSnapshotRef.current = null
    if (snapshot) {
      docRef.current = snapshot
      setDoc(snapshot)
    }
    restoreUndoStackSnapshot()
  }, [suppressUndoRef, docRef, setDoc, restoreUndoStackSnapshot])

  return {
    doc,
    setDoc,
    docRef,
    docName,
    setDocName,
    ownerUsername,
    loading,
    error,
    setError,
    solveResults,
    setSolveResults,
    featureTimings,
    bodies,
    pickBodies,
    setPickBodies,
    solving,
    solveTime,
    solveError,
    setSolveError,
    solveResult,
    setSolveRawResult,
    undoStack,
    redoStack,
    reSolve,
    validation,
    clearValidation,
    handleMutation,
    handleUndo,
    handleRedo,
    saveDoc,
    renameDoc,
    permission,
    isPublic,
    setRollbackPos,
    setPickBoundary,
    startPreviewMode,
    commitPreview,
    cancelPreview,
    startEditSession,
    commitEditSession,
    cancelEditSession,
  }
}
