// Snapshot-based undo/redo for the assembly editor, mirroring the part editor's
// useUndoRedo but with the stacks held in the module assemblyStore so they are
// not torn down with the component. Each entry is the pre-mutation AssemblyDoc
// plus a short label for the toolbar tooltip.
//
// The page's `mutate` funnel decides when a step is recorded. Most operations
// push immediately. A mate or instance editor is a coalescing session: typing an
// offset fires a mutate per keystroke, so the session's first mutation pins the
// pre-session doc and the close commits exactly one entry.

import { useCallback, useRef } from 'react'
import type { AssemblyDoc } from '@/types/cad'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { MAX_UNDO_DEPTH } from '@/config/undoConfig'
import { assemblyDocEquals } from '@/utils/assemblyMutations'

export function useAssemblyUndoRedo(
  docRef: React.MutableRefObject<AssemblyDoc | null>,
  setDoc: React.Dispatch<React.SetStateAction<AssemblyDoc | null>>,
  requestSolve: () => void,
) {
  // The coalesced pre-session doc of the open editor, or null between sessions.
  // The first mutation pins it; a close commits it as one entry, a cancel drops it.
  const pendingSession = useRef<{ doc: AssemblyDoc; label: string } | null>(null)

  // Read the stacks from the store so the hook re-renders (and tests can assert)
  // exactly like the part editor's hook does.
  const undoStack = useAssemblyStore(s => s.undoStack)
  const redoStack = useAssemblyStore(s => s.redoStack)

  const pushUndo = useCallback((doc: AssemblyDoc, label: string) => {
    const undo = [...useAssemblyStore.getState().undoStack, { doc, label }]
    if (undo.length > MAX_UNDO_DEPTH) undo.shift()
    // A fresh edit invalidates any redo branch.
    useAssemblyStore.setState({ undoStack: undo, redoStack: [] })
  }, [])

  const recordSessionEdit = useCallback((doc: AssemblyDoc, label: string) => {
    if (!pendingSession.current) pendingSession.current = { doc, label }
  }, [])

  const commitSession = useCallback(() => {
    const pending = pendingSession.current
    pendingSession.current = null
    if (!pending) return
    // The live doc is gone (a teardown after a failed load, an unmount after
    // the doc already left): pushing would record an entry keyed to a doc that
    // does not exist, so the pin is dropped instead. Mirrors applyUndoRedo's
    // empty-stack/null-doc no-op.
    if (!docRef.current) return
    // A session that left the doc exactly as it found it (typed back to its
    // start value) must not charge an entry: the pre-session doc and the
    // current doc are structurally equal, so undoing it would restore an
    // identical document. Mirrors docDiffersForSession's whole-doc guard.
    if (assemblyDocEquals(pending.doc, docRef.current)) return
    pushUndo(pending.doc, pending.label)
  }, [pushUndo, docRef])

  const cancelSession = useCallback(() => {
    pendingSession.current = null
  }, [])

  const applyUndoRedo = useCallback((direction: 'undo' | 'redo') => {
    const store = useAssemblyStore.getState()
    const from = direction === 'undo' ? store.undoStack : store.redoStack
    // An undo mid-edit abandons the uncommitted session: its coalesced doc
    // describes a state the restore is about to replace. The drop runs even for
    // an empty-stack undo, or a later commit would pin the coalesced edits to a
    // pre-doc that no longer corresponds to the doc they were made on.
    pendingSession.current = null
    if (from.length === 0) return
    // A non-empty stack with no current doc means the history describes a doc
    // that does not exist. Popping would orphan the counterpart entry and
    // permanently desync the paired stacks, so the whole undo is a no-op.
    if (!docRef.current) return
    const entry = from[from.length - 1]
    const nextFrom = from.slice(0, -1)
    const to = direction === 'undo' ? store.redoStack : store.undoStack
    // The doc we are leaving becomes the counterpart entry, so the same label
    // round-trips in both directions. The clone mirrors pushUndo's snapshot
    // discipline: the departing doc must not be shared with the entry.
    const preDoc = docRef.current
    const nextTo = [...to, { doc: structuredClone(preDoc), label: entry.label }]
    if (nextTo.length > MAX_UNDO_DEPTH) nextTo.shift()
    useAssemblyStore.setState(
      direction === 'undo'
        ? { undoStack: nextFrom, redoStack: nextTo }
        : { undoStack: nextTo, redoStack: nextFrom },
    )
    // Restoring an earlier doc moves it away from the saved content, so it
    // counts as unsaved until the user saves again.
    useUnsavedChangesStore.getState().setDirty(true)
    // A restored doc may no longer contain the mate being authored, the B-rep
    // entities being selected or the instance the tree has selected; the armed
    // field, its owed solve, its candidates and the selection state must not
    // aim into a vanished feature. The page's safety effects clear
    // selectedMateId and selectedPartHandle for the same reason. A mid-drag
    // undo must not leave the session behind either: pointer-up would
    // otherwise commit the drag onto the restored doc. Delegated to the
    // store's own reset (rather than hand-listing the fields here) so this
    // call site can't drift from STORE_OWNED_FIELDS the way it already had
    // (missing showPickDebug); it deliberately skips the two undo stacks,
    // which this call already set above.
    useAssemblyStore.getState().resetTransientAssemblyState()
    docRef.current = entry.doc
    setDoc(entry.doc)
    // The store still holds the post-drag solved scene, so the viewport would
    // render the dragged pose until this solve re-bakes the restored doc.
    requestSolve()
  }, [docRef, setDoc, requestSolve])

  const handleUndo = useCallback(() => { applyUndoRedo('undo') }, [applyUndoRedo])

  const handleRedo = useCallback(() => { applyUndoRedo('redo') }, [applyUndoRedo])

  return {
    undoStack,
    redoStack,
    pushUndo,
    recordSessionEdit,
    commitSession,
    cancelSession,
    handleUndo,
    handleRedo,
  }
}
