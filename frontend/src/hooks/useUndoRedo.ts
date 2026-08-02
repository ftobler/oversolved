import { useState, useCallback, useRef } from 'react'
import type { PartDoc, Mutation } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { MAX_UNDO_DEPTH } from '@/config/undoConfig'

type UndoEntry = { doc: PartDoc; mutation: Mutation }

export function useUndoRedo(
  docRef: React.MutableRefObject<PartDoc | null>,
  setDoc: React.Dispatch<React.SetStateAction<PartDoc | null>>,
  reSolve: (d: PartDoc, opts?: { validate?: boolean; bypassCache?: boolean; dragAnchor?: { featureId: string; entityId: string } }) => void | Promise<void>,
  // Abandons every half-open edit/preview session. Must only null out transient
  // state, never write the doc back, because the doc it would write is the one
  // undo is about to replace.
  tearDownEditorState?: () => void,
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
    // The entry holds a snapshot, never a reference: handleMutation clones
    // before pushing today, but any path that mutates the current doc in place
    // would silently rewrite history if the stored object were shared.
    const undo = [...undoRef.current, { doc: structuredClone(currentDoc), mutation }]
    if (undo.length > MAX_UNDO_DEPTH) undo.shift()
    commitStacks(undo, [])  // a fresh edit invalidates any redo branch
  }, [commitStacks])

  // The code tab replaces the whole document from text, outside the mutation
  // funnel that owns the stacks, so there is nothing to pair an undo entry with.
  // The history is dropped rather than left standing: a surviving entry holds a
  // doc from before the YAML edit, and popping it would revert that edit
  // together with the last real one, under the wrong label.
  //
  // Stacks only. The open edit/preview sessions are just as stale after such a
  // replacement, but they belong to usePartDoc; it composes the teardown around
  // this call the same way applyUndoRedo does above.
  const clearStacks = useCallback(() => {
    commitStacks([], [])
    // A parked edit-session snapshot is the same history by another name;
    // restoring it later would resurrect exactly the entries just dropped.
    stackSnapshotRef.current = null
  }, [commitStacks])

  const applyUndoRedo = useCallback(
    (direction: 'undo' | 'redo') => {
      const from = direction === 'undo' ? undoRef.current : redoRef.current
      const to = direction === 'undo' ? redoRef.current : undoRef.current
      if (from.length === 0) return

      // A non-empty stack with no current doc means the history describes a doc
      // that does not exist. Popping would orphan the counterpart entry and
      // permanently desync the paired stacks, so the whole undo is a no-op.
      if (!docRef.current) return
      const preDoc = docRef.current

      // Exit every open session before the doc swaps. A session that survives
      // would later commit a spurious entry keyed to the pre-undo doc, or cancel
      // straight back to it and silently revert the undo. An empty stack is a
      // no-op, so nothing is torn down for a keystroke that does nothing.
      suppressUndoRef.current = false
      stackSnapshotRef.current = null
      tearDownEditorState?.()

      const entry = from[from.length - 1]
      const nextFrom = from.slice(0, -1)
      // The doc we are leaving becomes the counterpart entry, so the same
      // mutation label round-trips in both directions. The clone mirrors
      // pushUndo: the departing doc must not be shared with the entry.
      const nextTo = [...to, { doc: structuredClone(preDoc), mutation: entry.mutation }]
      if (nextTo.length > MAX_UNDO_DEPTH) nextTo.shift()

      commitStacks(
        direction === 'undo' ? nextFrom : nextTo,
        direction === 'undo' ? nextTo : nextFrom,
      )

      // Restoring an earlier doc moves it away from the saved content, so it
      // counts as unsaved until the user saves again.
      useUnsavedChangesStore.getState().setDirty(true)
      docRef.current = entry.doc
      setDoc(entry.doc)
      // Undo/redo always exits any edit (there is no meaningful in-edit state
      // to preserve) and restores the rollback the doc was saved with, which
      // is the end of the stack unless the user had parked the bar earlier.
      const store = usePartEditorStore.getState()
      store.setEditingFeatureId(null)
      store.setPickBoundary(null)
      store.setRollbackPosition(entry.doc.rollback ?? entry.doc.features?.length ?? 0)
      reSolve(entry.doc)
    }, [docRef, setDoc, reSolve, commitStacks, tearDownEditorState])

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
    clearStacks,
    handleUndo,
    handleRedo,
    saveUndoStackSnapshot,
    restoreUndoStackSnapshot,
    clearUndoStackSnapshot,
  }
}
