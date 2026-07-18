import { useState, useCallback, useRef } from 'react'
import type { PartDoc, Mutation } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

type UndoEntry = { doc: PartDoc; mutation: Mutation }

const MAX_UNDO_DEPTH = 50

export function useUndoRedo(
  docRef: React.MutableRefObject<PartDoc | null>,
  setDoc: React.Dispatch<React.SetStateAction<PartDoc | null>>,
  reSolve: (d: PartDoc, opts?: { validate?: boolean; bypassCache?: boolean; dragAnchor?: { featureId: string; entityId: string } }) => void | Promise<void>,
) {
  // The refs are the source of truth; the state mirrors them purely so the UI
  // re-renders. Stack transitions must never run inside a setState updater:
  // React invokes updaters twice under StrictMode, which replays any side
  // effect inside them (that duplicated every entry pushed onto the opposite
  // stack while the pop, being pure, stayed correct).
  const undoRef = useRef<UndoEntry[]>([])
  const redoRef = useRef<UndoEntry[]>([])
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([])
  const [redoStack, setRedoStack] = useState<UndoEntry[]>([])
  const suppressUndoRef = useRef(false)
  const stackSnapshotRef = useRef<{ undo: UndoEntry[]; redo: UndoEntry[] } | null>(null)

  const commitStacks = useCallback((undo: UndoEntry[], redo: UndoEntry[]) => {
    undoRef.current = undo
    redoRef.current = redo
    setUndoStack(undo)
    setRedoStack(redo)
  }, [])

  const pushUndo = useCallback((mutation: Mutation, currentDoc: PartDoc) => {
    const undo = [...undoRef.current, { doc: currentDoc, mutation }]
    if (undo.length > MAX_UNDO_DEPTH) undo.shift()
    commitStacks(undo, [])  // a fresh edit invalidates any redo branch
  }, [commitStacks])

  const applyUndoRedo = useCallback(
    (direction: 'undo' | 'redo') => {
      const from = direction === 'undo' ? undoRef.current : redoRef.current
      const to = direction === 'undo' ? redoRef.current : undoRef.current
      if (from.length === 0) return

      const entry = from[from.length - 1]
      const nextFrom = from.slice(0, -1)
      // The doc we are leaving becomes the counterpart entry, so the same
      // mutation label round-trips in both directions.
      const preDoc = docRef.current
      const nextTo = preDoc ? [...to, { doc: preDoc, mutation: entry.mutation }] : to

      commitStacks(
        direction === 'undo' ? nextFrom : nextTo,
        direction === 'undo' ? nextTo : nextFrom,
      )

      // Restoring an earlier doc moves it away from the saved content, so it
      // counts as unsaved until the user saves again.
      useUnsavedChangesStore.getState().setDirty(true)
      docRef.current = entry.doc
      setDoc(entry.doc)
      // Undo/redo always exits any edit — there is no meaningful in-edit state
      // to preserve — and restores the rollback the doc was saved with, which
      // is the end of the stack unless the user had parked the bar earlier.
      const store = usePartEditorStore.getState()
      store.setEditingFeatureId(null)
      store.setPickBoundary(null)
      store.setRollbackPosition(entry.doc.rollback ?? entry.doc.features?.length ?? 0)
      reSolve(entry.doc)
    }, [docRef, setDoc, reSolve, commitStacks])

  const handleUndo = useCallback(() => { applyUndoRedo('undo') }, [applyUndoRedo])

  const handleRedo = useCallback(() => { applyUndoRedo('redo') }, [applyUndoRedo])

  // Reads the refs, not the rendered state, so a snapshot taken in the same
  // tick as a mutation still sees that mutation's push.
  const saveUndoStackSnapshot = useCallback(() => {
    stackSnapshotRef.current = {
      undo: [...undoRef.current],
      redo: [...redoRef.current],
    }
  }, [])

  const restoreUndoStackSnapshot = useCallback(() => {
    const snap = stackSnapshotRef.current
    if (!snap) return
    commitStacks(snap.undo, snap.redo)
    stackSnapshotRef.current = null
  }, [commitStacks])

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
