import { useCallback, useEffect, useRef } from 'react'
import type { PartDoc, Mutation, SketchData } from '@/types/cad'
import { useDocumentState } from '@/hooks/useDocumentState'
import { useSolver } from '@/hooks/useSolver'
import { useUndoRedo } from '@/hooks/useUndoRedo'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { pruneSolveResults } from '@/utils/yamlMutations/solveResults'
import { failLoud } from '@/stores/stateInvariants'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { applySetRollback } from '@/utils/yamlMutations'

export { BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS } from '@/hooks/useDocumentState'

// Mutations that write a value which may already equal the current one. Only
// these pay for the deep-compare in handleMutation; every other mutation adds
// or removes content and can never be a no-op, so comparing would waste O(doc)
// work on every sketch drag. add_*_edge is deliberately absent: re-applying it
// on an already-listed edge is a toggle that removes the edge, a real change.
const IDEMPOTENT_MUTATION_TYPES = new Set<Mutation['type']>([
  'rename_feature',
  'rename_part',
  'reorder_features',
  'reorder_pick_field',
  'set_part_color',
  'set_part_transparency',
  'set_part_metalness',
  'set_part_roughness',
  'set_part_transmission',
  'set_body_visibility',
  'set_feature_visibility',
  'set_feature_suppression',
  'set_feature_plane',
  'set_plane_definition_field',
  'set_extrude_field',
  'set_revolve_field',
  'set_sweep_field',
  'set_fillet_field',
  'set_chamfer_field',
  'set_boolean_field',
  'set_array_field',
  'set_circular_array_field',
  'set_hole_field',
  'set_transform_field',
  'set_mirror_field',
  'set_variable_field',
  'set_constraint_value',
  'set_constraint_pos',
  'set_constraint_sign',
])

// The mutation types the color preview can produce. Suppression is scoped to
// these: while a preview is open any OTHER mutation is an escape (see
// handleMutation) that auto-commits the preview and then pushes normally, so a
// sketch edit mid-preview is never swallowed and destroyed by a later cancel.
// A suppressed feature edit session keeps its 'all' scope on top of this.
const PREVIEW_SCOPE = new Set<Mutation['type']>([
  'set_part_color',
  'set_part_transparency',
  'set_part_metalness',
  'set_part_roughness',
  'set_part_transmission',
])

// Whole-doc change test for the edit-session commit. part_style is excluded
// because reconcilePartStyle fabricates entries there during a solve, which
// would manufacture an edit out of nothing; rollback is excluded because it is
// pinned during an edit (the mirror only runs when editingFeatureId is null),
// so it can never be a user change inside a session. The docs are throwaway
// clones, so stripping in place is safe.
function docDiffersForSession(a: PartDoc, b: PartDoc): boolean {
  const strip = (d: PartDoc): PartDoc => {
    const clone = structuredClone(d)
    delete clone.part_style
    delete clone.rollback
    return clone
  }
  return JSON.stringify(strip(a)) !== JSON.stringify(strip(b))
}

// The commit label for a preview apply. The color popover is the only preview
// producer and it edits per-body material fields, so the diff is against the
// pre-preview doc's part_style; the popover always applies `set_part_color` on
// Apply even when only a slider moved, so naming what actually changed is more
// honest than reusing that mutation. Returns null when nothing in part_style
// changed, letting the caller fall back to the mutation it was handed.
function previewMutationFor(original: PartDoc, current: PartDoc): Mutation | null {
  const before = original.part_style ?? {}
  const after = current.part_style ?? {}
  const bodyIds = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed: string[] = []
  for (const bodyId of bodyIds) {
    const a = (before[bodyId] ?? {}) as Record<string, unknown>
    const b = (after[bodyId] ?? {}) as Record<string, unknown>
    const fields = Object.keys({ ...a, ...b }).filter(f => a[f] !== b[f])
    if (fields.length > 0) changed.push(`edit ${bodyId}: ${fields.join(', ')}`)
  }
  if (changed.length === 0) return null
  return { type: 'preview_commit', description: changed.join('; ') }
}

// A serializable key of only the parts of `doc` an idempotent mutation can
// change, so the no-op guard compares O(touched) instead of O(doc). The
// rollback mirror writes doc.rollback outside a session, so that is always
// included; a feature mutation narrows to its feature (a reorder to the order
// alone, since it never touches content); a body-style mutation to its single
// part_style entry. Every idempotent handler stays within these, so a change
// the handlers made can never be invisible to the slice.
function noOpSliceFor(m: Mutation, doc: PartDoc): unknown {
  const featureId = (m as { featureId?: string }).featureId
  const bodyId = (m as { bodyId?: string }).bodyId
  const slice: Record<string, unknown> = {}
  if (doc.rollback !== undefined) slice.rollback = doc.rollback
  if (m.type === 'reorder_features') {
    slice.features = (doc.features ?? []).map(f => f.id)
  } else if (featureId !== undefined) {
    slice.features = [(doc.features ?? []).find(f => f.id === featureId)]
  }
  if (bodyId !== undefined) {
    slice.part_style = { [bodyId]: doc.part_style?.[bodyId] }
  }
  return slice
}

type ReSolveFn = (d: PartDoc, opts?: { validate?: boolean; bypassCache?: boolean; dragAnchor?: { featureId: string; entityId: string }; _suppressFirstSolve?: boolean; _restoreSolveResults?: Record<string, SketchData> }) => Promise<void> | void

export function usePartDoc(uuid: string | undefined, mode: string, setCodeText: (t: string) => void, { solveOnLoad = true, onFirstSolve }: { solveOnLoad?: boolean; onFirstSolve?: () => void } = {}) {
  const modeRef = useRef(mode)
  useEffect(() => { modeRef.current = mode }, [mode])

  const reSolveRef = useRef<ReSolveFn | null>(null)

  const {
    doc, setDoc, docRef, docName, ownerUsername,
    loading, error, setError, permission, isCloudDoc,
    saveDoc, renameDoc, cloneDoc,
  } = useDocumentState(uuid, reSolveRef, { solveOnLoad })

  const {
    solveResults, setSolveResults, bodies, pickBodies, pickStateReady,
    solving, solveError, setSolveError, solveResult,
    featureTimings, reSolve,
    validation,
  } = useSolver(uuid, setCodeText, modeRef, { onFirstSolve }, docRef, setDoc)

  useEffect(() => { reSolveRef.current = reSolve }, [reSolve])

  // Mirror of the solver's solveResults so handleMutation can compute the
  // optimistic prune (and what it removed) synchronously in an event handler.
  const solveResultsRef = useRef<Record<string, SketchData>>({})
  useEffect(() => { solveResultsRef.current = solveResults }, [solveResults])

  const previewOriginalDoc = useRef<PartDoc | null>(null)
  // Whether the active preview has swallowed a PREVIEW_SCOPE mutation. The
  // commit gate needs this to tell a user's color change from a part_style
  // entry the solve fabricates: both are part_style diffs, only one earned an
  // entry.
  const previewTouchedRef = useRef(false)
  const editSnapshotRef = useRef<PartDoc | null>(null)
  // Whether the active edit session suppresses per-action undo entries. A
  // suppressed (feature) session commits one aggregate; a sketch session keeps
  // each action as its own entry and must not be folded on commit.
  const editSessionSuppressedRef = useRef(false)
  // The brep dimension pick commits its projection with no undo entry, so pick
  // and the dimension that follows it read as one step for the user. `armed`
  // means the next mutation (the projection, or a compensating delete on
  // cancel) applies without an entry; `doc` is the pre-gesture doc the commit
  // mutation must restore.
  const brepWithholdRef = useRef<{ armed: boolean; doc: PartDoc | null }>({ armed: false, doc: null })
  // Set by the page: the transient editor state that does not live in this hook
  // (forced visibility, sketch-editor selection/pick, popovers, panel mode).
  const undoTeardownRef = useRef<(() => void) | null>(null)

  const registerUndoTeardown = useCallback((fn: (() => void) | null) => {
    undoTeardownRef.current = fn
  }, [])

  // Dropping the session refs is what makes a nested session unreachable after
  // an undo: without it the next commit/cancel would still hold the pre-undo
  // world and write it back.
  const tearDownEditorState = useCallback(() => {
    editSnapshotRef.current = null
    editSessionSuppressedRef.current = false
    brepWithholdRef.current = { armed: false, doc: null }
    previewOriginalDoc.current = null
    previewTouchedRef.current = false
    undoTeardownRef.current?.()
  }, [])

  const {
    undoStack, redoStack, suppressUndoRef, pushUndo, clearStacks, handleUndo, handleRedo,
    saveUndoStackSnapshot, restoreUndoStackSnapshot, clearUndoStackSnapshot,
  } = useUndoRedo(docRef, setDoc, reSolve, tearDownEditorState)

  // Abandons open edit/preview sessions and re-enables undo pushes, WITHOUT
  // touching the stacks. The code tab's own exit path runs the full
  // discardHistoryAndSessions (a doc swap clears the history), but a plain
  // exit with no typed text still has to drop a session a preview started in
  // code mode, or its suppressUndoRef keeps swallowing every later edit.
  const discardSessions = useCallback(() => {
    suppressUndoRef.current = false
    tearDownEditorState()
  }, [suppressUndoRef, tearDownEditorState])

  // What the code tab calls before it swaps the document in from text. The swap
  // leaves every open session describing a world the document no longer has --
  // the same staleness an undo creates -- so it gets the same teardown, and the
  // history goes with it because no entry can be paired with the swap.
  // Without the teardown a cancel taken afterwards would rewind the doc to a
  // pre-code-tab snapshot, and restoreUndoStackSnapshot would silently do
  // nothing because the snapshot it wants was dropped here.
  const discardHistoryAndSessions = useCallback(() => {
    discardSessions()
    clearStacks()
  }, [discardSessions, clearStacks])

  const startPreviewMode = useCallback((originalDoc: PartDoc) => {
    if (previewOriginalDoc.current !== null) {
      failLoud('[usePartDoc] startPreviewMode called while a preview is already active (nested preview not supported)')
      // A nested preview must not overwrite the live baseline.
      return
    }
    previewOriginalDoc.current = structuredClone(originalDoc)
    previewTouchedRef.current = false
    suppressUndoRef.current = true
  }, [suppressUndoRef])

  const commitPreview = useCallback((mutation: Mutation) => {
    if (!previewOriginalDoc.current) {
      failLoud('[usePartDoc] commitPreview called with no active preview')
      return
    }
    // Same-value apply (e.g. a preview that never changed the color) restores
    // the pre-preview doc on undo, so it must not leave a dead step behind.
    // The change gate excludes solve-fabricated part_style entries the way the
    // edit-session diff does: only a real non-part_style change, or a preview
    // that actually swallowed a scope mutation, earns an entry.
    const original = previewOriginalDoc.current
    const current = docRef.current
    const styleChanged = previewTouchedRef.current
      && current !== null
      && previewMutationFor(original, current) !== null
    if (current && (docDiffersForSession(original, current) || styleChanged)) {
      // The popover applies set_part_color no matter what was edited, so the
      // label is composed from the actual part_style diff; a preview whose
      // change was elsewhere keeps the mutation it was handed.
      pushUndo(previewMutationFor(original, current) ?? mutation, original)
    }
    previewTouchedRef.current = false
    previewOriginalDoc.current = null
    // A suppressed feature session is the undo owner of this preview: keep
    // suppression on so the session's commit stays the single aggregate and
    // the preview_commit sits beside it, instead of every later session edit
    // pushing its own entry.
    if (!editSessionSuppressedRef.current) {
      suppressUndoRef.current = false
    }
  }, [suppressUndoRef, pushUndo, docRef, editSessionSuppressedRef])

  const cancelPreview = useCallback(() => {
    if (!previewOriginalDoc.current) {
      // No live preview: it already committed (an escape), so there is nothing
      // to rewind. null tells the caller to just close the popover.
      return null
    }
    previewTouchedRef.current = false
    const original = previewOriginalDoc.current
    previewOriginalDoc.current = null
    if (!editSessionSuppressedRef.current) {
      suppressUndoRef.current = false
    }
    return original
  }, [suppressUndoRef, editSessionSuppressedRef])

  const handleMutation = useCallback((m: Mutation) => {
    setSolveError(null)
    const current = docRef.current
    if (!current) return

    // The handler runs on the clone first so the no-op guard below can compare
    // the result against the pre-mutation doc before anything is committed.
    const next: PartDoc = structuredClone(current)
    type AnyHandler = (doc: PartDoc, m: Mutation) => void
    const handler = (mutationHandlers as Record<string, AnyHandler | undefined>)[m.type]
    if (import.meta.env.DEV && !handler) {
      console.error(`[handleMutation] no handler for mutation type: ${m.type}`)
    }
    handler?.(next, m)

    // The rollback bar is document content, but only a user-parked position is:
    // during an edit the bar is pinned just after the edited feature, which is
    // transient. Outside an edit, mirroring the store into every doc edit means
    // an append or delete can never leave a stale position behind (adding a
    // feature moves the bar to the end, and that must reach the doc too).
    const editorStore = usePartEditorStore.getState()
    if (editorStore.editingFeatureId === null) {
      // The set_rollback payload is advisory: the store owns the position and
      // the mirror writes it into the doc, so a payload that disagrees here
      // means the mutation was dispatched without pre-syncing the store, which
      // would silently no-op while still pushing an entry. During an edit the
      // store legitimately diverges (the bar is pinned transiently), so the
      // guard only runs outside one.
      if (m.type === 'set_rollback' && editorStore.rollbackPosition !== m.position) {
        failLoud('[usePartDoc] set_rollback dispatched with the rollback store not pre-synced')
      }
      applySetRollback(next, editorStore.rollbackPosition)
    }

    // A value mutation that leaves the doc byte-identical is a dead undo step,
    // and re-solving for it wastes a build: skip the push, the dirty flag and
    // the solve together. The rollback write above is part of the compare, so
    // a mirror-visible rollback change still counts as a real edit. The slice
    // limits the stringify to the touched feature/part_style entry instead of
    // the whole doc (per-keystroke field edits must not cost O(doc) on a large
    // STEP-imported document).
    if (IDEMPOTENT_MUTATION_TYPES.has(m.type)
      && JSON.stringify(noOpSliceFor(m, current)) === JSON.stringify(noOpSliceFor(m, next))) {
      return
    }

    // Every doc edit funnels through here (direct mutations, drags, and preview
    // commits all call handleMutation), so this is the one place that flags the
    // document as having changes not yet saved to its store.
    useUnsavedChangesStore.getState().setDirty(true)

    // Content-removing edits invalidate the affected features' last solve;
    // prune it so stale geometry cannot linger while the re-solve is in flight.
    // Only whole-feature removals carry a restorable snapshot (a partial
    // delete's snapshot would redraw deleted entities after a failing solve);
    // partial deletes stay pruned and the doc-driven fallback renders them.
    const { next: nextSolveResults, restorable } = pruneSolveResults(m, solveResultsRef.current)
    if (nextSolveResults !== solveResultsRef.current) setSolveResults(nextSolveResults)

    const brep = brepWithholdRef.current
    // A mutation the color preview cannot produce while a preview is open is an
    // escape: the popover is non-modal, so a sketch edit mid-preview folds the
    // pending color into its own entry (commitPreview) and then pushes normally
    // below, instead of being swallowed and destroyed by a later cancel. A
    // suppressed feature session keeps its 'all' scope and swallows everything.
    let escapedPreview = false
    if (suppressUndoRef.current
      && !editSessionSuppressedRef.current
      && previewOriginalDoc.current !== null
      && !PREVIEW_SCOPE.has(m.type)) {
      const original = previewOriginalDoc.current
      commitPreview(previewMutationFor(original, current) ?? m)
      escapedPreview = true
    }
    if (suppressUndoRef.current && !escapedPreview) {
      // A suppressed session swallows every mutation; a live preview swallows
      // only the part_style mutations it produces.
      if (previewOriginalDoc.current !== null && PREVIEW_SCOPE.has(m.type)) {
        previewTouchedRef.current = true
      }
    } else if (brep.armed) {
      // The brep dimension projection, or the compensating delete of a
      // cancelled one: apply without an entry and remember the pre-gesture doc
      // so the commit that follows can restore past it. A later pick in the
      // same gesture keeps the EARLIEST captured doc, or the first pick's
      // projection would be orphaned by the commit's undo.
      brepWithholdRef.current = { armed: false, doc: brep.doc ?? current }
    } else if (brep.doc && m.type === 'add_constraint') {
      // The brep dimension commit: one entry restoring the pre-projection doc,
      // so undo removes the dimension and its projection in a single step. The
      // type gate keeps an unrelated mid-gesture mutation (a rename, a delete)
      // from stealing the withhold and pushing an entry keyed to the pre-pick
      // doc, which would silently unpair the projection.
      const preDoc = brep.doc
      brepWithholdRef.current = { armed: false, doc: null }
      pushUndo(m, preDoc)
    } else {
      pushUndo(m, current)
    }

    docRef.current = next
    setDoc(next)
    const dragAnchor =
      m.type === 'move_vertex' || m.type === 'move_vertex_with_constraint' || m.type === 'move_entity'
        ? { featureId: m.featureId, entityId: m.entityId }
        : undefined
    // Bypass the checkpoint cache for exactly the edits dirty detection cannot
    // see: `drag_anchor` is a VOLATILE_FEATURE_KEY (kernel/builder.ts), so a
    // solve differing only in the anchor reads as clean and would never rebuild.
    // Every other edit changes the feature spec itself, which findFirstDirty
    // sees -- and bypassing there rebuilt the whole stack per edit, so deleting
    // one part out of a large STEP import cost a full re-import (28.5s vs 0.5s
    // on a measured 200-part file).
    reSolve(next, {
      bypassCache: dragAnchor !== undefined,
      dragAnchor,
      _suppressFirstSolve: true,
      ...(restorable ? { _restoreSolveResults: restorable } : {}),
    })
  }, [docRef, setDoc, reSolve, setSolveResults, setSolveError, suppressUndoRef, pushUndo, solveResultsRef, commitPreview])

  const startEditSession = useCallback((suppressUndo: boolean) => {
    if (!docRef.current) return
    if (editSnapshotRef.current !== null) {
      failLoud('[usePartDoc] startEditSession called while an edit session is already active (nested edit session not supported)')
    }
    editSnapshotRef.current = structuredClone(docRef.current)
    // Which kind of session this is decides what commitEditSession does: a
    // suppressed (feature) session folds into one aggregate entry, a sketch
    // session keeps its per-action entries and pushes nothing extra.
    editSessionSuppressedRef.current = suppressUndo
    saveUndoStackSnapshot()
    if (suppressUndo) {
      suppressUndoRef.current = true
    }
  }, [docRef, saveUndoStackSnapshot, suppressUndoRef])

  const commitEditSession = useCallback(() => {
    if (editSnapshotRef.current === null) {
      // No active session (e.g. add+enter pattern where only editingFeatureId
      // was set without starting a session). Silently skip.
      return
    }
    const snapshot = editSnapshotRef.current
    const suppressed = editSessionSuppressedRef.current
    editSnapshotRef.current = null
    editSessionSuppressedRef.current = false
    suppressUndoRef.current = false
    // A sketch session already left one undo entry per action; an aggregate
    // on top would double-record the same work. Only a suppressed (feature)
    // session needs the collapse into one step.
    if (suppressed && snapshot && docRef.current) {
      // Entering an edit and leaving it without touching anything must not leave
      // an undo step behind: it would restore an identical doc, so undo would
      // look dead to the user. The whole-doc diff excludes part_style (the
      // solver fabricates entries there during a solve) and rollback (the
      // mirror is gated on editingFeatureId === null, so it cannot drift here).
      const changed = docDiffersForSession(snapshot, docRef.current)
      if (changed) {
        // The store still holds the edited feature here (commitEditSession runs
        // before the caller's exit cleanup clears it), so the undo label can name
        // the feature instead of rendering an empty one.
        const featureId = usePartEditorStore.getState().editingFeatureId ?? ''
        pushUndo({ type: 'edit_session', featureId }, snapshot)
      }
    }
    clearUndoStackSnapshot()
  }, [suppressUndoRef, pushUndo, clearUndoStackSnapshot, docRef])

  const cancelEditSession = useCallback(() => {
    const snapshot = editSnapshotRef.current
    // No snapshot means no session was ever started (add-and-enter only sets
    // editingFeatureId), so there is nothing to rewind -- but the exit still
    // needs the re-solve below.
    if (snapshot !== null) {
      editSnapshotRef.current = null
      editSessionSuppressedRef.current = false
      suppressUndoRef.current = false
      docRef.current = snapshot
      setDoc(snapshot)
      restoreUndoStackSnapshot()
    }
    // Rewinding the doc is this function's own doing, so it owns the re-solve
    // too. Leaving it to the caller's exit cleanup meant any other route into
    // cancel left the viewport on the discarded edit.
    if (docRef.current) reSolve(docRef.current)
  }, [suppressUndoRef, docRef, setDoc, reSolve, restoreUndoStackSnapshot])

  // Applies a set of mutations a single gesture produced (an end-snapped line,
  // a multi-face projection, a multi-feature delete) as ONE undo entry and one
  // re-solve. The handlers run in order on one clone; the entry restores the
  // pre-gesture doc, so undo undoes the whole gesture at once.
  const commitMutationGroup = useCallback((ms: Mutation[]) => {
    setSolveError(null)
    const current = docRef.current
    if (!current || ms.length === 0) return

    const next: PartDoc = structuredClone(current)
    type AnyHandler = (doc: PartDoc, m: Mutation) => void
    let restorable: Record<string, SketchData> | null = null
    let nextSolveResults = solveResultsRef.current
    for (const m of ms) {
      const handler = (mutationHandlers as Record<string, AnyHandler | undefined>)[m.type]
      if (import.meta.env.DEV && !handler) {
        console.error(`[handleMutation] no handler for mutation type: ${m.type}`)
      }
      handler?.(next, m)
      const pruned = pruneSolveResults(m, nextSolveResults)
      if (pruned.next !== nextSolveResults) {
        nextSolveResults = pruned.next
        if (pruned.restorable) restorable = { ...(restorable ?? {}), ...pruned.restorable }
      }
    }

    const editorStore = usePartEditorStore.getState()
    if (editorStore.editingFeatureId === null) {
      applySetRollback(next, editorStore.rollbackPosition)
    }

    // A group whose handlers all no-opped (e.g. a re-drop of a selection) must
    // not leave a dead entry or waste a solve, mirroring the single-mutation
    // guard in handleMutation.
    if (JSON.stringify(current) === JSON.stringify(next)) {
      return
    }

    useUnsavedChangesStore.getState().setDirty(true)
    if (nextSolveResults !== solveResultsRef.current) setSolveResults(nextSolveResults)
    // A group lands during a preview the same way a single mutation does: a
    // snapped line drawn mid-preview is not a preview-scope mutation, so it
    // escapes (commit the pending color first, then push the group normally).
    // A group made entirely of preview-scope mutations is a preview frame and
    // stays swallowed. A suppressed session swallows every group as today.
    const sessionActive = editSessionSuppressedRef.current
    const previewActive = previewOriginalDoc.current !== null
    const groupInPreviewScope = !sessionActive
      && previewActive
      && ms.every(m => PREVIEW_SCOPE.has(m.type))
    if (!sessionActive && previewActive && !groupInPreviewScope) {
      const original = previewOriginalDoc.current!
      commitPreview(previewMutationFor(original, current) ?? ms[0])
    } else if (groupInPreviewScope) {
      previewTouchedRef.current = true
    }
    if (!suppressUndoRef.current) {
      // The first mutation names the entry so the undo tooltip has a label;
      // redo round-trips it, so only the doc matters, never the list itself.
      pushUndo(ms[0], current)
    }
    docRef.current = next
    setDoc(next)
    reSolve(next, {
      _suppressFirstSolve: true,
      ...(restorable ? { _restoreSolveResults: restorable } : {}),
    })
  }, [docRef, setDoc, reSolve, setSolveResults, setSolveError, suppressUndoRef, pushUndo, solveResultsRef, commitPreview])

  // Arms the brep dimension pick/commit pair: the next mutation (the
  // projection) is applied without an undo entry and the one after it (the
  // dimension) restores the pre-gesture doc, so pick and commit read as one
  // step. The same arm-and-apply shape covers the compensating delete of a
  // cancelled pick, which must also leave no entry. The doc already captured by
  // an earlier pick in this gesture is preserved: re-arming for a second pick
  // must not forget the doc from before the first one.
  const beginBrepProjection = useCallback(() => {
    brepWithholdRef.current = { armed: true, doc: brepWithholdRef.current.doc }
  }, [])

  // Drops the armed/pending pair without a commit: the projection it covered
  // stays out of the undo history, and later mutations push normally again.
  // Called after a cancelled gesture has run its compensating delete, or by
  // the undo teardown where the doc is already being replaced.
  const cancelBrepProjection = useCallback(() => {
    brepWithholdRef.current = { armed: false, doc: null }
  }, [])

  return {
    doc,
    setDoc,
    docRef,
    docName,
    ownerUsername,
    loading,
    error,
    setError,
    solveResults,
    setSolveResults,
    featureTimings,
    bodies,
    pickBodies,
    pickStateReady,
    solving,
    solveError,
    setSolveError,
    solveResult,
    undoStack,
    redoStack,
    reSolve,
    validation,
    handleMutation,
    commitMutationGroup,
    beginBrepProjection,
    cancelBrepProjection,
    handleUndo,
    handleRedo,
    discardHistoryAndSessions,
    discardSessions,
    saveDoc,
    renameDoc,
    cloneDoc,
    permission,
    isCloudDoc,
    startPreviewMode,
    commitPreview,
    cancelPreview,
    startEditSession,
    commitEditSession,
    cancelEditSession,
    registerUndoTeardown,
  }
}
