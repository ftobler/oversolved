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
import { isSessionOpen } from '@/utils/assemblyEditingSubject'

export type AssemblyMutationDecision = 'noop' | 'push' | 'fold'

// The undo decision the old page funnels spelled out inline: a value no-op
// leaves no step, an open editor folds the next edit into its coalescing
// session, and anything else pushes immediately. Pure so the decision can be
// unit tested without mounting the page.
export function decideAssemblyMutation(args: {
  pre: AssemblyDoc | null
  next: AssemblyDoc | null
  sessionOpen: boolean
}): AssemblyMutationDecision {
  if (!args.pre || !args.next) return 'noop'
  if (args.next === args.pre || assemblyDocEquals(args.pre, args.next)) return 'noop'
  return args.sessionOpen ? 'fold' : 'push'
}

export function useAssemblyUndoRedo(
  docRef: React.MutableRefObject<AssemblyDoc | null>,
  setDoc: React.Dispatch<React.SetStateAction<AssemblyDoc | null>>,
  requestSolve: () => void,
) {
  // The coalesced pre-session doc of the open editor, or null between sessions.
  // The first mutation pins it; a close commits it as one entry, a cancel rewinds
  // to it. The unsaved-changes flag rides along so the cancel can put it back:
  // pinning it here rather than when the editor opened is what makes it right, as
  // a one-shot landing between the open and the first session edit dirties the doc
  // for a reason the cancel has no business undoing.
  const pendingSession = useRef<{ doc: AssemblyDoc; label: string; dirty: boolean } | null>(null)

  // Read the stacks from the store so the hook re-renders (and tests can assert)
  // exactly like the part editor's hook does.
  const undoStack = useAssemblyStore(s => s.undoStack)
  const redoStack = useAssemblyStore(s => s.redoStack)

  const pushUndo = useCallback((doc: AssemblyDoc, label: string) => {
    // The entry holds a snapshot, never a reference: every caller passes the
    // live docRef object, and any path that mutates it in place would silently
    // rewrite history if the stored object were shared. Mirrors applyUndoRedo's
    // counterpart clone below.
    const undo = [...useAssemblyStore.getState().undoStack, { doc: structuredClone(doc), label }]
    if (undo.length > MAX_UNDO_DEPTH) undo.shift()
    // A fresh edit invalidates any redo branch.
    useAssemblyStore.setState({ undoStack: undo, redoStack: [] })
  }, [])

  const recordSessionEdit = useCallback((doc: AssemblyDoc, label: string) => {
    // The page's `mutate` calls this BEFORE it applies the mutation and before it
    // sets the doc dirty, so both the doc and the flag read here are still the
    // pre-session ones cancelSession has to restore.
    if (!pendingSession.current) {
      pendingSession.current = { doc, label, dirty: useUnsavedChangesStore.getState().dirty }
    }
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

  // Cancel rewinds the WHOLE doc to the pinned pre-session one. Reverting only
  // the feature whose editor is open under-reverts: the instance editor's
  // position, rotation and fixed controls each bake every non-fixed instance's
  // solved pose into its seed (bakeSolvedTransforms), so the other instances'
  // rewritten seeds would stay in the document with no undo entry to reach them
  // and a restored clean flag telling the guard there was nothing to warn about.
  //
  // Doc rewind, pin drop and dirty restore are ONE unit, mirroring useUndoRedo's
  // snapshot PAIRING CONTRACT and usePartDoc's cancelEditSession. The undo stacks
  // need no adjustment: a pinned session pushed nothing (that is what the pin is
  // for), so they already describe the pre-session doc, which is exactly the doc
  // becoming live again. The re-solve is left to the callers, which owe one
  // whether or not anything was pinned.
  const cancelSession = useCallback(() => {
    const pending = pendingSession.current
    pendingSession.current = null
    // No pin means the session mutated nothing: there is nothing to rewind, and
    // no dirty flag was set on its behalf to restore.
    if (!pending) return
    // Same null-doc guard as commitSession: the live doc is gone (a teardown
    // after a failed load), so there is nothing left to rewind.
    if (!docRef.current) return
    docRef.current = pending.doc
    setDoc(pending.doc)
    useUnsavedChangesStore.getState().setDirty(pending.dirty)
  }, [docRef, setDoc])

  // Apply a pure AssemblyDoc mutation and flag the doc dirty. The pre-mutation
  // doc is captured outside the setDoc updater: reading the store doc here
  // breaks under React batching, where two mutations in one event both see the
  // same stale pre-doc. The undo decision is the shared pure one, and the
  // session-open flag comes from the store, so no caller passes it.
  const mutate = useCallback((label: string, fn: (d: AssemblyDoc) => AssemblyDoc) => {
    const current = docRef.current
    if (!current) return
    const next = fn(current)
    const decision = decideAssemblyMutation({
      pre: current,
      next,
      sessionOpen: isSessionOpen(useAssemblyStore.getState().editingSubject),
    })
    if (decision === 'noop') return
    if (decision === 'fold') recordSessionEdit(current, label)
    else pushUndo(current, label)
    docRef.current = next
    setDoc(next)
    useUnsavedChangesStore.getState().setDirty(true)
  }, [setDoc, docRef, pushUndo, recordSessionEdit])

  // A structural one-shot op (rename, reorder, delete, duplicate, visibility)
  // pushes its own step even while an editor session is open: the session's
  // coalesced step closes first, so the one-shot's pre-doc captures the doc
  // AFTER the session's edits and a later session commit starts from the
  // post-op doc - pre-docs stay distinct and in order.
  const mutateOneShot = useCallback((label: string, fn: (d: AssemblyDoc) => AssemblyDoc) => {
    commitSession()
    const current = docRef.current
    if (!current) return
    const next = fn(current)
    const decision = decideAssemblyMutation({ pre: current, next, sessionOpen: false })
    if (decision === 'noop') return
    pushUndo(current, label)
    docRef.current = next
    setDoc(next)
    useUnsavedChangesStore.getState().setDirty(true)
  }, [setDoc, docRef, pushUndo, commitSession])

  const applyUndoRedo = useCallback((direction: 'undo' | 'redo') => {
    const store = useAssemblyStore.getState()
    const from = direction === 'undo' ? store.undoStack : store.redoStack
    // An undo mid-edit abandons the uncommitted session: its coalesced doc
    // describes a state the restore is about to replace. The drop runs even for
    // an empty-stack undo, or a later commit would pin the coalesced edits to a
    // pre-doc that no longer corresponds to the doc they were made on.
    pendingSession.current = null
    // Undo/redo always exits the open editor, even on an empty stack (where the
    // restore below never runs and would not otherwise reset the subject). The
    // rest of the transient state is reset by resetTransientAssemblyState later.
    useAssemblyStore.getState().closeEditor()
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
    // aim into a vanished feature. The page's safety effects clear the subject
    // for the same reason. A mid-drag
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
    mutate,
    mutateOneShot,
    handleUndo,
    handleRedo,
  }
}
