import { useCallback, useEffect, useRef } from 'react'
import type { PartDoc, Mutation, SketchData } from '@/types/cad'
import { useDocumentState } from '@/hooks/useDocumentState'
import { useSolver } from '@/hooks/useSolver'
import { useUndoRedo } from '@/hooks/useUndoRedo'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { pruneSolveResults } from '@/utils/yamlMutations/solveResults'
import { cloneDocForUndo } from '@/utils/yamlMutations/undoSnapshot'
import { failLoud } from '@/stores/stateInvariants'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { applySetRollback } from '@/utils/yamlMutations'
import { isDimensionKind } from '@/registry/constraintRegistry'
import { MAX_UNDO_DEPTH } from '@/config/undoConfig'

export { BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS } from '@/hooks/useDocumentState'

// Mutations that write a value which may already equal the current one. Only
// these pay for the deep-compare in handleMutation; every other mutation adds
// or removes content and can never be a no-op, so comparing would waste O(doc)
// work on every sketch drag. The add_* toggle family (add_*_edge, add_*_tool,
// add_delete_body_ref, add_transform_body, add_*_profile, add_sweep_path) is
// deliberately absent: re-applying an already-listed entry toggles it back out,
// a real change, so a guard would swallow it. set_rollback is the bar being
// dragged to where it already is (or the end, when the key is absent);
// toggle_*_plane_visibility and a delete_feature on a builtin or absent feature
// can also no-op, but the UI derives both from the current doc so they are
// effectively unreachable, and neither narrows to a single feature.
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
  'set_rollback',
  // Index/predicate-driven removals can target an entry that is already gone:
  // a splice past the end and a filter that matches nothing both leave the
  // feature identical. noOpSliceFor already slices the whole touched feature,
  // so the compare is O(feature) and covers each of these for free.
  'remove_extrude_profile',
  'remove_revolve_profile',
  'remove_sweep_profile',
  'remove_sweep_path',
  'remove_fillet_edge',
  'remove_chamfer_edge',
  'remove_boolean_tool',
  'remove_delete_body_ref',
  'remove_transform_body',
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

// The kinds whose pruned solve result is the ONLY thing that can re-render them
// after a failing solve: they produce body geometry with no `initial`-style doc
// fallback (the plan's BREP/import scope). A sketch renders from `initial`
// (Viewport/index.tsx), a plane solves trivially, a variable carries no
// geometry, so retaining their snapshots would only consume the stash cap.
const NO_FALLBACK_BREP_KINDS = new Set([
  'extrude', 'revolve', 'sweep',
  'fillet', 'chamfer',
  'boolean', 'hole',
  'array', 'circular_array',
  'transform', 'mirror',
  'delete_body', 'import_step',
])

// The kind of the named feature in `doc`, or undefined when absent. The stash
// gate needs the kind of a feature about to be pruned; both funnels run before
// the pre-mutation doc is replaced, so it still carries the feature.
function featureKindOf(doc: PartDoc | null, featureId: string): string | undefined {
  return (doc?.features ?? []).find(f => f.id === featureId)?.kind
}

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

// The body-style mutations whose no-op slice keys on a single part_style
// entry. A missing bodyId writes part_style[undefined] - a real doc change the
// slice cannot represent - so these are the ones the guard must never swallow.
const BODY_STYLE_MUTATION_TYPES = new Set<Mutation['type']>([
  'rename_part',
  'set_body_visibility',
  'set_part_color',
  'set_part_transparency',
  'set_part_metalness',
  'set_part_roughness',
  'set_part_transmission',
])

// The slice value meaning "do not no-op guard this mutation". A body-style
// mutation without a bodyId is a programming error (failLoud flags it, like
// the set_rollback pre-sync guard) but the doc change is still real, so in
// prod the mutation must always push; the bypass skips the stringify compare.
const GUARD_BYPASS = Symbol('noOpSliceFor.guardBypass')

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
  if (bodyId === undefined && BODY_STYLE_MUTATION_TYPES.has(m.type)) {
    failLoud('[usePartDoc] body-style mutation dispatched without a bodyId')
    return GUARD_BYPASS
  }
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

export function usePartDoc(uuid: string | undefined, { solveOnLoad = true, onFirstSolve, workspace }: { solveOnLoad?: boolean; onFirstSolve?: () => void; workspace?: string } = {}) {
  const reSolveRef = useRef<ReSolveFn | null>(null)

  // Retained pruned solve results, keyed by feature id, held across the undo
  // boundary. handleMutation prunes a deleted feature's solve result
  // optimistically and hands it to the delete's OWN re-solve as
  // _restoreSolveResults, so a failing forward solve re-renders the feature.
  // The undo entry stores no solve results (they are not doc content), so the
  // undo re-solve has nothing to restore; this stash is that one-shot contract
  // extended across the boundary. Only whole-feature removals of body-producing
  // kinds are appended, and a successful solve for a feature clears it.
  const restoreStashRef = useRef<Record<string, SketchData>>({})

  // Drops the retained snapshot of a feature once a solve genuinely produced a
  // fresh result for it: the fresh result supersedes the snapshot, so keeping
  // it would only leak memory and could resurrect stale geometry. Fires only on
  // an APPLIED solve (useSolver calls it from the success path, after the
  // request-id staleness guard), never on the failure-restore path, so a
  // failing forward delete cannot eat the entry a later undo still needs.
  const clearStashForSolved = useCallback((featureIds: string[]) => {
    const stash = restoreStashRef.current
    for (const featureId of featureIds) {
      delete stash[featureId]
    }
  }, [])

  const {
    doc, setDoc, docRef, docName,
    loading, error, setError,
    saveDoc, renameDoc, cloneDoc,
  } = useDocumentState(uuid, reSolveRef, { solveOnLoad, workspace })

  const {
    solveResults, setSolveResults, bodies, pickBodies, pickStateReady,
    solving, solveError, setSolveError,
    featureTimings, reSolve,
    validation,
  } = useSolver(uuid, { onFirstSolve, onSolveApplied: clearStashForSolved }, docRef, setDoc)

  useEffect(() => { reSolveRef.current = reSolve }, [reSolve])

  // Append a pruned snapshot for a whole-feature removal, keyed by feature id.
  // Capped like the undo stack: beyond MAX_UNDO_DEPTH the oldest entry falls
  // out and the feature simply renders via the normal re-solve after a
  // successful undo, matching undo-stack semantics.
  const stashPrunedResult = useCallback((featureId: string, snapshot: SketchData) => {
    const stash = restoreStashRef.current
    const keys = Object.keys(stash)
    if (!(featureId in stash) && keys.length >= MAX_UNDO_DEPTH) delete stash[keys[0]]
    stash[featureId] = snapshot
  }, [])

  // The reSolve handed to useUndoRedo. applyUndoRedo restores an entry's doc and
  // re-solves it, and that entry carries no solve results, so the re-solve has
  // nothing to show while it runs - and nothing to fall back to if it fails. The
  // stash is that fallback, filtered to the features the restored entry doc
  // actually contains so a stale entry for a feature the doc lacks is never
  // read.
  const restoreAwareReSolve = useCallback((d: PartDoc) => {
    const restore: Record<string, SketchData> = {}
    const entryIds = new Set((d.features ?? []).map(f => f.id))
    for (const [featureId, snapshot] of Object.entries(restoreStashRef.current)) {
      if (entryIds.has(featureId)) restore[featureId] = snapshot
    }
    const restoreKeys = Object.keys(restore)
    return restoreKeys.length > 0
      ? reSolve(d, { _restoreSolveResults: restore })
      : reSolve(d)
  }, [reSolve])

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
  // Whether the suppressed (feature) edit session swallowed a part_style
  // mutation. The session diff excludes part_style (the solver fabricates
  // entries there), so a genuine user color/visibility change during the
  // session would otherwise leave no undo entry to revert it. This flag forces
  // the aggregate entry when that happened.
  const sessionStyleTouchedRef = useRef(false)
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
    sessionStyleTouchedRef.current = false
    undoTeardownRef.current?.()
  }, [])

  const {
    undoStack, redoStack, suppressUndoRef, pushUndo, handleUndo, handleRedo,
    saveUndoStackSnapshot, restoreUndoStackSnapshot, clearUndoStackSnapshot,
  } = useUndoRedo(docRef, setDoc, restoreAwareReSolve, tearDownEditorState)

  const startPreviewMode = useCallback((originalDoc: PartDoc) => {
    if (previewOriginalDoc.current !== null) {
      failLoud('[usePartDoc] startPreviewMode called while a preview is already active (nested preview not supported)')
      // A nested preview must not overwrite the live baseline.
      return
    }
    previewOriginalDoc.current = cloneDocForUndo(originalDoc)
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

  // Shared "does this mutation earn an undo entry?" branch for the
  // single-mutation funnel and the gesture-group funnel, so a withheld brep
  // projection and its dimension commit cannot be split differently by the
  // two paths. `preDoc` is the doc the entry restores to when no withhold is
  // pending; the withhold, when armed, overrides it with the pre-gesture doc.
  const applyWithholdOrPush = useCallback((mutation: Mutation, preDoc: PartDoc) => {
    const brep = brepWithholdRef.current
    if (brep.armed) {
      // The brep dimension projection, or the compensating delete of a
      // cancelled one: apply without an entry and remember the pre-gesture doc
      // so the commit that follows can restore past it. A later pick in the
      // same gesture keeps the EARLIEST captured doc, or the first pick's
      // projection would be orphaned by the commit's undo.
      brepWithholdRef.current = { armed: false, doc: brep.doc ?? preDoc }
    } else if (brep.doc && mutation.type === 'add_constraint' && isDimensionKind(mutation.kind)) {
      // The brep dimension commit: one entry restoring the pre-projection doc,
      // so undo removes the dimension and its projection in a single step. The
      // type gate keeps an unrelated mid-gesture mutation (a rename, a delete)
      // from stealing the withhold and pushing an entry keyed to the pre-pick
      // doc, which would silently unpair the projection. The kind gate stops a
      // geometric add_constraint (e.g. a coincident applied mid-gesture) from
      // being mistaken for the commit: only a dimension kind restores the
      // pre-pick doc, and the registry is the single source of that split.
      const withheldDoc = brep.doc
      brepWithholdRef.current = { armed: false, doc: null }
      pushUndo(mutation, withheldDoc)
    } else {
      pushUndo(mutation, preDoc)
      // A non-`add_constraint` mutation landing mid-gesture (a "steal", e.g. a
      // rename or a delete) clears the withhold: keeping the pre-pick doc means
      // a later dimension commit keys to it and restores a world without the
      // projection, whose own entry then re-materialises it alone. The steal's
      // entry restores the current doc (projection included), so the projection
      // is owned by a normal entry chain and never orphaned.
      brepWithholdRef.current = { armed: false, doc: null }
    }
  }, [pushUndo])

  // The single predicate deciding whether a live preview is open OUTSIDE a
  // suppressed feature session, i.e. whether an incompatible mutation escapes
  // it (auto-commits the pending color, then pushes normally) rather than
  // being swallowed whole by the session's own 'all' scope. Shared by the
  // single-mutation and gesture-group funnels so they cannot disagree about
  // what escapes: they used to gate on different refs (suppressUndoRef vs.
  // editSessionSuppressedRef alone), which is exactly the half-open state a
  // preview left open across a session boundary used to expose.
  const previewOpenOutsideSession = useCallback(() =>
    suppressUndoRef.current
    && !editSessionSuppressedRef.current
    && previewOriginalDoc.current !== null,
  [suppressUndoRef])

  const handleMutation = useCallback((m: Mutation) => {
    setSolveError(null)
    const current = docRef.current
    if (!current) return

    // The handler runs on the clone first so the no-op guard below can compare
    // the result against the pre-mutation doc before anything is committed. The
    // clone is a plain deep copy; the document holds references, not bytes.
    const next: PartDoc = cloneDocForUndo(current)
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
    // the whole doc, a plain O(touched) optimization for large feature lists.
    if (IDEMPOTENT_MUTATION_TYPES.has(m.type)) {
      const slice = noOpSliceFor(m, current)
      // GUARD_BYPASS means the slice cannot represent the change (a body-style
      // mutation missing its bodyId), so the compare is skipped entirely and
      // the mutation always lands: the guard is never the reason a doc
      // mutation goes unrecorded.
      if (slice !== GUARD_BYPASS
        && JSON.stringify(slice) === JSON.stringify(noOpSliceFor(m, next))) {
        // A no-op is still "the next mutation" as far as the gesture is
        // concerned: consuming the arm here mirrors the suppression branch
        // below, because leaving it armed would swallow the next unrelated
        // mutation as "the projection".
        const brep = brepWithholdRef.current
        if (brep.armed) {
          brepWithholdRef.current = { armed: false, doc: brep.doc ?? current }
        }
        return
      }
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
    // The restorable snapshot is also retained for the undo boundary (the undo
    // re-solve has no other source for it), limited to body-producing kinds.
    const { next: nextSolveResults, restorable } = pruneSolveResults(m, solveResultsRef.current)
    if (nextSolveResults !== solveResultsRef.current) setSolveResults(nextSolveResults)
    if (restorable) {
      for (const featureId of Object.keys(restorable)) {
        const kind = featureKindOf(current, featureId)
        if (kind && NO_FALLBACK_BREP_KINDS.has(kind)) {
          stashPrunedResult(featureId, restorable[featureId])
        }
      }
    }

    const brep = brepWithholdRef.current
    // A mutation the color preview cannot produce while a preview is open is an
    // escape: the popover is non-modal, so a sketch edit mid-preview folds the
    // pending color into its own entry (commitPreview) and then pushes normally
    // below, instead of being swallowed and destroyed by a later cancel. A
    // suppressed feature session keeps its 'all' scope and swallows everything.
    let escapedPreview = false
    if (previewOpenOutsideSession() && !PREVIEW_SCOPE.has(m.type)) {
      const original = previewOriginalDoc.current!
      commitPreview(previewMutationFor(original, current) ?? m)
      escapedPreview = true
    }
    if (suppressUndoRef.current && !escapedPreview) {
      // A suppressed session swallows every mutation; a live preview swallows
      // only the part_style mutations it produces.
      if (previewOriginalDoc.current !== null && PREVIEW_SCOPE.has(m.type)) {
        previewTouchedRef.current = true
      }
      // A swallowed part_style mutation is a real user change the session diff
      // cannot see (it strips part_style); remember it so commit pushes an
      // entry that can revert the color/visibility, not just the feature spec.
      if (BODY_STYLE_MUTATION_TYPES.has(m.type)) {
        sessionStyleTouchedRef.current = true
      }
      // A swallow still fulfils the withhold's "next mutation" contract: the
      // mutation applies without an entry, so consume the arm exactly like the
      // projection branch does. Leaving it armed would leak past the
      // suppression boundary and swallow the next unrelated mutation as
      // "the projection".
      if (brep.armed) {
        brepWithholdRef.current = { armed: false, doc: brep.doc ?? current }
      }
    } else {
      applyWithholdOrPush(m, current)
    }

    docRef.current = next
    setDoc(next)
    const dragAnchor =
      m.type === 'move_vertex' || m.type === 'move_vertex_with_constraint' || m.type === 'move_entity' || m.type === 'resize_circle'
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
  }, [docRef, setDoc, reSolve, setSolveResults, setSolveError, suppressUndoRef, solveResultsRef, commitPreview, applyWithholdOrPush, previewOpenOutsideSession, stashPrunedResult])

  const startEditSession = useCallback((suppressUndo: boolean) => {
    if (!docRef.current) return
    if (editSnapshotRef.current !== null) {
      failLoud('[usePartDoc] startEditSession called while an edit session is already active (nested edit session not supported)')
      // In prod failLoud only warns, so without this return the call below
      // would overwrite editSnapshotRef with the CURRENT (already-edited) doc,
      // moving the outer session's restore point past its own edits and
      // making them permanently non-undoable. Refuse instead: the caller is
      // responsible for closing the active session before opening another.
      return
    }
    // A preview left open when a session starts is the same half-open state
    // commitEditSession guards against at the commit boundary: its swallowed
    // part_style mutation would bake into the snapshot clone below, and a later
    // cancel would rewind to a doc that carries the cancelled preview color
    // with no undo entry for it. Resolve it FIRST so the snapshot is taken
    // after the preview_commit (color kept, with its own entry). failLoud
    // throws in test but only warns in prod, where the resolution still runs.
    if (previewOriginalDoc.current !== null) {
      failLoud('[usePartDoc] startEditSession called while a preview is active (preview must be resolved before a session starts)')
      commitPreview({ type: 'preview_commit', description: 'preview resolved at session start' })
    }
    editSnapshotRef.current = cloneDocForUndo(docRef.current)
    // Which kind of session this is decides what commitEditSession does: a
    // suppressed (feature) session folds into one aggregate entry, a sketch
    // session keeps its per-action entries and pushes nothing extra.
    editSessionSuppressedRef.current = suppressUndo
    // A fresh session starts with no swallowed part_style; the flag is only
    // meaningful within one session and must not leak across boundaries.
    sessionStyleTouchedRef.current = false
    saveUndoStackSnapshot()
    if (suppressUndo) {
      suppressUndoRef.current = true
    }
  }, [docRef, saveUndoStackSnapshot, suppressUndoRef, commitPreview])

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
      // A part_style mutation swallowed by the session is a real user change
      // the diff cannot see, so it forces the entry too -- unless an open
      // preview is about to resolve it on its own below, in which case the
      // preview_commit already reverts the color and a second entry would be
      // redundant.
      const changed = docDiffersForSession(snapshot, docRef.current)
        || (sessionStyleTouchedRef.current && previewOriginalDoc.current === null)
      if (changed) {
        // The store still holds the edited feature here (commitEditSession runs
        // before the caller's exit cleanup clears it), so the undo label can name
        // the feature instead of rendering an empty one.
        const featureId = usePartEditorStore.getState().editingFeatureId ?? ''
        pushUndo({ type: 'edit_session', featureId }, snapshot)
      }
    }
    // An open preview left at the session boundary (its own Apply was never
    // clicked) has no other resolver, so it folds in here. This must run AFTER
    // the aggregate edit_session push above: the preview is the last action
    // the user took, so its entry belongs on top. Reversed, the first undo
    // would revert both the edits and the color, and the second would re-apply
    // the edits alone -- two undos would not return to the pre-session doc.
    // The resolution is unconditional: every session boundary clears an open
    // preview, or a later popover Apply keys its preview_commit to a doc that
    // predates the session.
    if (previewOriginalDoc.current !== null) {
      commitPreview({ type: 'preview_commit', description: 'preview resolved at session commit' })
    }
    clearUndoStackSnapshot()
  }, [suppressUndoRef, pushUndo, clearUndoStackSnapshot, docRef, commitPreview])

  const cancelEditSession = useCallback(() => {
    const snapshot = editSnapshotRef.current
    // No snapshot means no session was ever started (add-and-enter only sets
    // editingFeatureId), so there is nothing to rewind -- but the exit still
    // needs the re-solve below.
    if (snapshot !== null) {
      // Invariant: previewOriginalDoc may not survive a session boundary. The
      // session snapshot predates the preview, so the rewind below already
      // discards any preview work; dropping the refs WITHOUT pushing (rather
      // than routing through cancelPreview, which would push nothing anyway
      // but reads as if there were something to resolve) leaves cancelPreview
      // finding no active preview afterward, so the popover's own Cancel
      // becomes a null no-op instead of a second, stale rewind.
      previewOriginalDoc.current = null
      previewTouchedRef.current = false
      sessionStyleTouchedRef.current = false
      editSnapshotRef.current = null
      editSessionSuppressedRef.current = false
      suppressUndoRef.current = false
      // Doc rewind and stack restore are ONE unit (see useUndoRedo's snapshot
      // pairing contract): the stacks only describe the pre-session doc again
      // once the live doc has been rewound to it. Restoring in the other
      // order, or without the rewind, would leave the stack top naming a doc
      // the live doc is not.
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

    const next: PartDoc = cloneDocForUndo(current)
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
        if (pruned.restorable) {
          restorable = { ...(restorable ?? {}), ...pruned.restorable }
          for (const featureId of Object.keys(pruned.restorable)) {
            const kind = featureKindOf(current, featureId)
            if (kind && NO_FALLBACK_BREP_KINDS.has(kind)) {
              stashPrunedResult(featureId, pruned.restorable[featureId])
            }
          }
        }
      }
    }

    const editorStore = usePartEditorStore.getState()
    if (editorStore.editingFeatureId === null) {
      // Mirror the single-mutation funnel's guard: a set_rollback whose payload
      // disagrees with the store was dispatched without pre-syncing it, which
      // would silently no-op while still pushing a dead entry.
      const rollback = ms.find(m => m.type === 'set_rollback') as Extract<Mutation, { type: 'set_rollback' }> | undefined
      if (rollback && editorStore.rollbackPosition !== rollback.position) {
        failLoud('[usePartDoc] set_rollback dispatched with the rollback store not pre-synced')
      }
      applySetRollback(next, editorStore.rollbackPosition)
    }

    // A group whose handlers all no-opped (e.g. a re-drop of a selection) must
    // not leave a dead entry or waste a solve, mirroring the single-mutation
    // guard in handleMutation.
    if (JSON.stringify(current) === JSON.stringify(next)) {
      // Same withhold contract as handleMutation's no-op guard: the no-op
      // group fulfils "the next mutation" and consumes the arm, or a later
      // real mutation is swallowed as "the projection".
      const brep = brepWithholdRef.current
      if (brep.armed) {
        brepWithholdRef.current = { armed: false, doc: brep.doc ?? current }
      }
      return
    }

    useUnsavedChangesStore.getState().setDirty(true)
    if (nextSolveResults !== solveResultsRef.current) setSolveResults(nextSolveResults)
    // A group lands during a preview the same way a single mutation does: a
    // snapped line drawn mid-preview is not a preview-scope mutation, so it
    // escapes (commit the pending color first, then push the group normally).
    // A group made entirely of preview-scope mutations is a preview frame and
    // stays swallowed. A suppressed session swallows every group as today.
    const groupInPreviewScope = previewOpenOutsideSession()
      && ms.every(m => PREVIEW_SCOPE.has(m.type))
    const brep = brepWithholdRef.current
    let escapedPreview = false
    if (previewOpenOutsideSession() && !groupInPreviewScope) {
      const original = previewOriginalDoc.current!
      commitPreview(previewMutationFor(original, current) ?? ms[0])
      escapedPreview = true
    } else if (groupInPreviewScope) {
      previewTouchedRef.current = true
    }
    if (suppressUndoRef.current && !escapedPreview) {
      // A group made entirely of preview-scope mutations is a preview frame
      // and a suppressed session swallows every group. The swallow must also
      // consume a pending brep withhold (exactly like handleMutation), or the
      // arm leaks past the suppression boundary and the next unrelated
      // mutation is swallowed as "the projection".
      if (brep.armed) {
        brepWithholdRef.current = { armed: false, doc: brep.doc ?? current }
      }
      // A swallowed preview frame must still mark the preview as touched,
      // exactly like the single-mutation funnel: without this, an all-preview
      // group landed by a suppressed session fails both commitPreview's style
      // gate and the session's own aggregate, so the color change has no entry.
      if (previewOriginalDoc.current !== null && ms.every(m => PREVIEW_SCOPE.has(m.type))) {
        previewTouchedRef.current = true
      }
      // Mirror the single-mutation funnel: a swallowed part_style mutation must
      // still earn an undo entry at commit.
      if (ms.some(m => BODY_STYLE_MUTATION_TYPES.has(m.type))) {
        sessionStyleTouchedRef.current = true
      }
    } else {
      // The first mutation names the entry so the undo tooltip has a label;
      // redo round-trips it, so only the doc matters, never the list itself.
      // A pending brep withhold is honored: the group is the projection, so it
      // applies without an entry and the pre-gesture doc waits for the commit.
      applyWithholdOrPush(ms[0], current)
    }
    docRef.current = next
    setDoc(next)
    reSolve(next, {
      _suppressFirstSolve: true,
      ...(restorable ? { _restoreSolveResults: restorable } : {}),
    })
  }, [docRef, setDoc, reSolve, setSolveResults, setSolveError, suppressUndoRef, solveResultsRef, commitPreview, applyWithholdOrPush, previewOpenOutsideSession, stashPrunedResult])

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
    saveDoc,
    renameDoc,
    cloneDoc,
    startPreviewMode,
    commitPreview,
    cancelPreview,
    startEditSession,
    commitEditSession,
    cancelEditSession,
    registerUndoTeardown,
  }
}
