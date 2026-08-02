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

const MAX_UNDO_DEPTH = 50

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
    if (pending) pushUndo(pending.doc, pending.label)
  }, [pushUndo])

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
    const entry = from[from.length - 1]
    const nextFrom = from.slice(0, -1)
    // The doc we are leaving becomes the counterpart entry, so the same label
    // round-trips in both directions.
    const to = direction === 'undo' ? store.redoStack : store.undoStack
    const preDoc = docRef.current
    const nextTo = preDoc ? [...to, { doc: preDoc, label: entry.label }] : to
    useAssemblyStore.setState(
      direction === 'undo'
        ? { undoStack: nextFrom, redoStack: nextTo }
        : { undoStack: nextTo, redoStack: nextFrom },
    )
    // Restoring an earlier doc moves it away from the saved content, so it
    // counts as unsaved until the user saves again.
    useUnsavedChangesStore.getState().setDirty(true)
    // A restored doc may no longer contain the mate being authored; the armed
    // field, its owed solve and its candidates must not aim into a vanished
    // feature. The page's safety effect clears selectedMateId for the same reason.
    useAssemblyStore.setState({
      activeMateField: null, mateFieldDirty: false,
      pickCandidates: [], pickIndex: -1, selectedMateId: null,
      // A mid-drag undo must not leave the session behind: pointer-up would
      // otherwise commit the drag onto the restored doc. The offsets, hover
      // scope and hits all describe the pre-undo scene too.
      manipulation: null, gizmoDrag: null, settlingOffsets: {},
      pickScopeEntity: null, hoverHits: [],
    })
    docRef.current = entry.doc
    setDoc(entry.doc)
    // The store still holds the post-drag solved scene, so the viewport would
    // render the dragged pose until this solve re-bakes the restored doc.
    requestSolve()
  }, [docRef, setDoc, requestSolve])

  const handleUndo = useCallback(() => { applyUndoRedo('undo') }, [applyUndoRedo])

  const handleRedo = useCallback(() => { applyUndoRedo('redo') }, [applyUndoRedo])

  const clearStacks = useCallback(() => {
    useAssemblyStore.setState({ undoStack: [], redoStack: [] })
  }, [])

  return {
    undoStack,
    redoStack,
    pushUndo,
    recordSessionEdit,
    commitSession,
    cancelSession,
    handleUndo,
    handleRedo,
    clearStacks,
  }
}
