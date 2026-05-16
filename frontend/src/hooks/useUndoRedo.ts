import { useState, useCallback, useRef } from 'react'
import type { PartDoc, Mutation } from '@/types/cad'

type UndoEntry = { doc: PartDoc; mutation: Mutation }

export function useUndoRedo(
  docRef: React.MutableRefObject<PartDoc | null>,
  setDoc: React.Dispatch<React.SetStateAction<PartDoc | null>>,
  reSolve: (d: PartDoc, rollbackPosition?: number | null) => void,
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

  const handleUndo = useCallback(() => {
    setUndoStack(prev => {
      if (prev.length === 0) return prev
      const next = [...prev]
      const entry = next.pop()!
      const preUndoDoc = docRef.current
      if (preUndoDoc) setRedoStack(r => [...r, { doc: preUndoDoc, mutation: entry.mutation }])
      docRef.current = entry.doc
      setDoc(entry.doc)
      reSolve(entry.doc, entry.doc.features?.length ?? 0)
      return next
    })
  }, [docRef, setDoc, reSolve])

  const handleRedo = useCallback(() => {
    setRedoStack(prev => {
      if (prev.length === 0) return prev
      const next = [...prev]
      const entry = next.pop()!
      const preRedoDoc = docRef.current
      if (preRedoDoc) setUndoStack(u => [...u, { doc: preRedoDoc, mutation: entry.mutation }])
      docRef.current = entry.doc
      setDoc(entry.doc)
      reSolve(entry.doc, entry.doc.features?.length ?? 0)
      return next
    })
  }, [docRef, setDoc, reSolve])

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
    setUndoStack,
    redoStack,
    setRedoStack,
    suppressUndoRef,
    pushUndo,
    handleUndo,
    handleRedo,
    saveUndoStackSnapshot,
    restoreUndoStackSnapshot,
    clearUndoStackSnapshot,
  }
}
