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
import { stringify as stringifyYaml } from 'yaml'
import type { AssemblyDoc } from '@/types/cad'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { useUnsavedChangesStore, reconcileDirtyAfterRewind, type PinnedDirty } from '@/stores/unsavedChangesStore'
import { MAX_UNDO_DEPTH } from '@/config/undoConfig'
import { assemblyDocEquals } from '@/utils/assemblyMutations'
import { isSessionOpen } from '@/utils/assemblyEditingSubject'
import type { AssemblyUndoLabel } from '@/utils/core/assemblyUndoLabels'
import { pushCapped, moveTop } from '@/utils/core/undoStack'

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
  const pendingSession = useRef<{ doc: AssemblyDoc; label: AssemblyUndoLabel; dirty: PinnedDirty } | null>(null)

  // Read the stacks from the store so the hook re-renders (and tests can assert)
  // exactly like the part editor's hook does.
  const undoStack = useAssemblyStore(s => s.undoStack)
  const redoStack = useAssemblyStore(s => s.redoStack)

  const pushUndo = useCallback((doc: AssemblyDoc, label: AssemblyUndoLabel) => {
    // The entry holds a snapshot, never a reference: every caller passes the
    // live docRef object, and any path that mutates it in place would silently
    // rewrite history if the stored object were shared. Mirrors applyUndoRedo's
    // counterpart clone below. AssemblyDoc holds no shared import payloads (the
    // part doc's are why cloneDocForUndo exists), so a full structuredClone is
    // the correct snapshot here.
    const undo = pushCapped(useAssemblyStore.getState().undoStack, { doc: structuredClone(doc), label }, MAX_UNDO_DEPTH)
    // A fresh edit invalidates any redo branch.
    useAssemblyStore.setState({ undoStack: undo, redoStack: [] })
  }, [])

  const recordSessionEdit = useCallback((doc: AssemblyDoc, label: AssemblyUndoLabel) => {
    // The page's `mutate` calls this BEFORE it applies the mutation and before it
    // sets the doc dirty, so both the doc and the flag read here are still the
    // pre-session ones cancelSession has to restore.
    // The pin is a clone, not the live object: the copy-on-write mutators keep the
    // pre-session doc intact today, but nothing enforces that, and a future in-place
    // edit of the live doc would rewrite the target cancel restores. Same snapshot
    // rule as pushUndo.
    if (!pendingSession.current) {
      pendingSession.current = { doc: structuredClone(doc), label, dirty: useUnsavedChangesStore.getState().pinDirty() }
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
    if (assemblyDocEquals(pending.doc, docRef.current)) {
      // No entry lands, so nothing in the history represents the session's
      // edits; but each of them set the dirty flag on the way through, so the
      // frame would stay flagged unsaved with nothing to save. Reconcile the
      // flag exactly as the cancel twin does, with `rewound` false because the
      // session netted to zero and threw nothing away.
      reconcileDirtyAfterRewind(pending.dirty, false, () => stringifyYaml(pending.doc))
      return
    }
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
    // The write-back and the copy-on-write mutators install fresh doc objects,
    // so the rewind is judged on content, not identity. The same test drives the
    // dirty reconcile: a session the save actually stored, and the rewind throws
    // nothing away, must not be left flagged dirty forever.
    const rewound = !assemblyDocEquals(pending.doc, docRef.current)
    docRef.current = pending.doc
    setDoc(pending.doc)
    // Doc rewind and flag reconcile are one unit, mirroring usePartDoc's
    // cancelEditSession: a save that published its fingerprint decides the flag,
    // and only a caller with no fingerprint falls back to the pinned save count.
    reconcileDirtyAfterRewind(pending.dirty, rewound, () => stringifyYaml(pending.doc))
  }, [docRef, setDoc])

  // Apply a pure AssemblyDoc mutation and flag the doc dirty. The pre-mutation
  // doc is captured outside the setDoc updater: reading the store doc here
  // breaks under React batching, where two mutations in one event both see the
  // same stale pre-doc. The undo decision is the shared pure one, and the
  // session-open flag comes from the store, so no caller passes it.
  const mutate = useCallback((label: AssemblyUndoLabel, fn: (d: AssemblyDoc) => AssemblyDoc) => {
    const sessionOpen = isSessionOpen(useAssemblyStore.getState().editingSubject)
    // A pin can outlive its editor: setSnapshot force-closes one whose subject
    // vanished from an external doc change without knowing a session was pinned.
    // Committing it here resolves that pin as an ordered entry instead of letting
    // the push below key the new step to the stale pre-session doc, which would
    // later charge a second, out-of-order entry and strand those edits from undo.
    if (!sessionOpen && pendingSession.current) commitSession()
    const current = docRef.current
    if (!current) return
    const next = fn(current)
    const decision = decideAssemblyMutation({ pre: current, next, sessionOpen })
    if (decision === 'noop') return
    if (decision === 'fold') recordSessionEdit(current, label)
    else pushUndo(current, label)
    docRef.current = next
    setDoc(next)
    useUnsavedChangesStore.getState().setDirty(true)
  }, [setDoc, docRef, pushUndo, recordSessionEdit, commitSession])

  // A structural one-shot op (rename, reorder, delete, duplicate, visibility)
  // pushes its own step even while an editor session is open: the session's
  // coalesced step closes first, so the one-shot's pre-doc captures the doc
  // AFTER the session's edits and a later session commit starts from the
  // post-op doc - pre-docs stay distinct and in order.
  const mutateOneShot = useCallback((label: AssemblyUndoLabel, fn: (d: AssemblyDoc) => AssemblyDoc) => {
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
    // An undo mid-edit first closes the open session as its own entry, so the
    // undo reverts exactly the editor's edits. Dropping the pin instead left
    // those edits in the doc with no entry of their own: on an empty stack they
    // could never be undone, and otherwise they rode along with the previous
    // step's restore. A redo mid-edit commits too, and the fresh entry clears
    // the redo branch the way any edit does.
    commitSession()
    // Read after the commit, which may have pushed onto the undo stack.
    const store = useAssemblyStore.getState()
    const from = direction === 'undo' ? store.undoStack : store.redoStack
    const to = direction === 'undo' ? store.redoStack : store.undoStack
    // An empty stack is a no-op that leaves the open editor alone, matching the
    // part engine. A non-empty stack with no current doc is a no-op too: the
    // history describes a doc that does not exist, and popping would orphan the
    // counterpart entry and permanently desync the paired stacks.
    if (from.length === 0) return
    if (!docRef.current) return
    const preDoc = docRef.current
    // Undo/redo exits the open editor (the restore below would not reset the
    // subject otherwise). The rest of the transient state is reset by
    // resetTransientAssemblyState later.
    useAssemblyStore.getState().closeEditor()
    // The doc we are leaving becomes the counterpart entry, so the same label
    // round-trips in both directions. The clone mirrors pushUndo's snapshot
    // discipline: the departing doc must not be shared with the entry.
    const move = moveTop(from, to, entry => ({ doc: structuredClone(preDoc), label: entry.label }))
    if (!move) return
    const entry = from[from.length - 1]
    useAssemblyStore.setState(
      direction === 'undo'
        ? { undoStack: move.from, redoStack: move.to }
        : { undoStack: move.to, redoStack: move.from },
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
  }, [docRef, setDoc, requestSolve, commitSession])

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
