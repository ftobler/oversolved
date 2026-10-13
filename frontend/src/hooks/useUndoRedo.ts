import { useState, useCallback, useRef } from 'react'
import type { PartDoc, Mutation } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { MAX_UNDO_DEPTH } from '@/config/undoConfig'
import { cloneDocForUndo } from '@/utils/yamlMutations/undoSnapshot'
import { pushCapped, moveTop } from '@/utils/core/undoStack'

type UndoEntry = { doc: PartDoc; mutation: Mutation }

export function useUndoRedo(
  docRef: React.MutableRefObject<PartDoc | null>,
  setDoc: React.Dispatch<React.SetStateAction<PartDoc | null>>,
  reSolve: (d: PartDoc, opts?: { validate?: boolean; bypassCache?: boolean; dragAnchor?: { featureId: string; entityId: string } }) => void | Promise<void>,
  // Abandons every half-open edit/preview session. Must only null out transient
  // state, never write the doc back, because the doc it would write is the one
  // undo is about to replace. It may write transient store state (rollback,
  // pick boundary, editing id) because applyUndoRedo tears the editor down
  // BEFORE the swap and then owns and rewrites the rollback position from the
  // restored entry; any such store write during teardown is intentionally
  // overwritten.
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

  // The shared tail of both push paths: append, cap, clear the redo branch. Only
  // the entry's doc differs between them, so the stack bookkeeping stays in one
  // place and the two callers cannot drift apart.
  const pushEntry = useCallback((mutation: Mutation, entryDoc: PartDoc) => {
    // A fresh edit invalidates any redo branch.
    commitStacks(pushCapped(undoRef.current, { doc: entryDoc, mutation }, MAX_UNDO_DEPTH), [])
  }, [commitStacks])

  const pushUndo = useCallback((mutation: Mutation, currentDoc: PartDoc) => {
    // The entry holds a snapshot, never a reference: handleMutation clones
    // before pushing today, but any path that mutates the current doc in place
    // would silently rewrite history if the stored object were shared.
    // cloneDocForUndo is a full deep clone, so the entry shares nothing with
    // the live doc.
    pushEntry(mutation, cloneDocForUndo(currentDoc))
  }, [pushEntry])

  // For callers that already hold an independent snapshot: the preview baseline
  // (previewOriginalDoc) and the edit-session snapshot (editSnapshotRef) are
  // produced by cloneDocForUndo and dropped right after the push, so cloning
  // them again at the boundary would only copy a throwaway. The caller must
  // pass a doc that is already independent of the live document and will not
  // be mutated afterwards; a live doc still belongs to pushUndo.
  const pushUndoSnapshot = useCallback((mutation: Mutation, docSnapshot: PartDoc) => {
    pushEntry(mutation, docSnapshot)
  }, [pushEntry])

  const applyUndoRedo = useCallback(
    (direction: 'undo' | 'redo') => {
      const from = direction === 'undo' ? undoRef.current : redoRef.current
      const to = direction === 'undo' ? redoRef.current : undoRef.current

      // A non-empty stack with no current doc means the history describes a doc
      // that does not exist. Popping would orphan the counterpart entry and
      // permanently desync the paired stacks, so the whole undo is a no-op. An
      // empty stack is a no-op for the same reason, and the check keeps
      // tearDownEditorState from running for a keystroke that does nothing.
      const preDoc = docRef.current
      if (from.length === 0 || !preDoc) return

      // Exit every open session before the doc swaps. A session that survives
      // would later commit a spurious entry keyed to the pre-undo doc, or cancel
      // straight back to it and silently revert the undo.
      suppressUndoRef.current = false
      stackSnapshotRef.current = null
      tearDownEditorState?.()

      // The doc we are leaving becomes the counterpart entry, so the same
      // mutation label round-trips in both directions. The clone mirrors
      // pushUndo: cloneDocForUndo is a full deep clone, so the departing doc
      // never shares state with the live doc or the entry.
      const move = moveTop(from, to, entry => ({ doc: cloneDocForUndo(preDoc), mutation: entry.mutation }))
      if (!move) return
      const entry = from[from.length - 1]

      commitStacks(
        direction === 'undo' ? move.from : move.to,
        direction === 'undo' ? move.to : move.from,
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
      // Clamp the restored position to the restored feature list, the same
      // guard Part.tsx applies when a doc loads: a stale/hand-edited doc
      // (rollback: 5 in a 3-feature list) must not set the bar past the end.
      // The entry stays immutable; the mirror re-fixes the doc on the next
      // mutation, exactly as Part.tsx's clamp effect does today.
      const features = entry.doc.features?.length ?? 0
      const rollback = Math.min(Math.max(entry.doc.rollback ?? features, 0), features)
      store.setRollbackPosition(rollback)
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

  // PAIRING CONTRACT: the stacks only describe the pre-session doc again once
  // the live doc IS that doc. This restore commits the stacks and nothing
  // else; the caller must have rewound docRef/setDoc to the pre-session
  // snapshot BEFORE calling (cancelEditSession composes doc rewind + stack
  // restore into one unit). Restoring alone would leave the top entry naming a
  // doc the live doc no longer is, desyncing history from the document.
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
    pushUndoSnapshot,
    handleUndo,
    handleRedo,
    saveUndoStackSnapshot,
    restoreUndoStackSnapshot,
    clearUndoStackSnapshot,
  }
}
