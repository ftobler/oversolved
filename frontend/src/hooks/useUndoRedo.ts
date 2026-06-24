import { useState, useCallback, useRef } from 'react'
import type { PartDoc, Mutation } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

type UndoEntry = { doc: PartDoc; mutation: Mutation }

export function useUndoRedo(
  docRef: React.MutableRefObject<PartDoc | null>,
  setDoc: React.Dispatch<React.SetStateAction<PartDoc | null>>,
  reSolve: (d: PartDoc, opts?: { validate?: boolean; bypassCache?: boolean; dragAnchor?: { featureId: string; entityId: string } }) => void | Promise<void>,
) {
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([])
  const [redoStack, setRedoStack] = useState<UndoEntry[]>([])
  const suppressUndoRef = useRef(false)
  const stackSnapshotRef = useRef<{ undo: UndoEntry[]; redo: UndoEntry[] } | null>(null)

  const pushUndo = useCallback((mutation: Mutation, currentDoc: PartDoc) => {
    setUndoStack(prev => {
      const next = [...prev, { doc: currentDoc, mutation }]
      if (next.length > 50) next.shift()
      return next
    })
    setRedoStack([])
  }, [])

  const applyUndoRedo = useCallback(
    (setFromStack: typeof setUndoStack, setToStack: typeof setUndoStack) => {
      setFromStack(prev => {
        if (prev.length === 0) return prev
        const next = [...prev]
        const entry = next.pop()!
        // Restoring an earlier doc moves it away from the saved content, so it
        // counts as unsaved until the user saves again.
        useUnsavedChangesStore.getState().setDirty(true)
        const preDoc = docRef.current
        if (preDoc) setToStack(r => [...r, { doc: preDoc, mutation: entry.mutation }])
        docRef.current = entry.doc
        setDoc(entry.doc)
        // Undo/redo always exits any edit and snaps rollback to the end of the
        // restored doc — there is no meaningful in-edit state to preserve.
        const store = usePartEditorStore.getState()
        store.setEditingFeatureId(null)
        store.setPickBoundary(null)
        store.setRollbackPosition(entry.doc.features?.length ?? 0)
        reSolve(entry.doc)
        return next
      })
    }, [docRef, setDoc, reSolve])

  const handleUndo = useCallback(() => { applyUndoRedo(setUndoStack, setRedoStack) }, [applyUndoRedo])

  const handleRedo = useCallback(() => { applyUndoRedo(setRedoStack, setUndoStack) }, [applyUndoRedo])

  const saveUndoStackSnapshot = useCallback(() => {
    stackSnapshotRef.current = {
      undo: [...undoStack],
      redo: [...redoStack],
    }
  }, [undoStack, redoStack])

  const restoreUndoStackSnapshot = useCallback(() => {
    const snap = stackSnapshotRef.current
    if (!snap) return
    setUndoStack(snap.undo)
    setRedoStack(snap.redo)
    stackSnapshotRef.current = null
  }, [])

  const clearUndoStackSnapshot = useCallback(() => {
    stackSnapshotRef.current = null
  }, [])

  return {
    undoStack,
    redoStack,
    suppressUndoRef,
    pushUndo,
    handleUndo,
    handleRedo,
    saveUndoStackSnapshot,
    restoreUndoStackSnapshot,
    clearUndoStackSnapshot,
  }
}
