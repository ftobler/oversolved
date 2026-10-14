import { useCallback, useEffect, useRef } from 'react'
import { stringify as stringifyYaml } from 'yaml'
import type { PartDoc, Mutation, PartFeature, SketchData } from '@/types/cad'
import { useDocumentState } from '@/hooks/useDocumentState'
import { useSolver } from '@/hooks/useSolver'
import { useUndoRedo } from '@/hooks/useUndoRedo'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { IDEMPOTENT_MUTATION } from '@/hooks/mutationIdempotence'
import { pruneSolveResults } from '@/utils/yamlMutations/solveResults'
import { cloneDocForUndo } from '@/utils/yamlMutations/undoSnapshot'
import { failLoud } from '@/stores/stateInvariants'
import { useUnsavedChangesStore, hashSavedText, type PinnedDirty } from '@/stores/unsavedChangesStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { applySetRollback } from '@/utils/yamlMutations'
import { isDimensionKind } from '@/registry/constraintRegistry'
import { MAX_UNDO_DEPTH } from '@/config/undoConfig'

export { BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS } from '@/hooks/useDocumentState'

// The mutation types the color preview can produce. Suppression is scoped to
// these: while a preview is open any OTHER mutation is an escape (see
// handleMutation) that auto-commits the preview and then pushes normally, so a
// sketch edit mid-preview is never swallowed and destroyed by a later cancel.
// A suppressed feature session does not share this scope: it owns the doc and
// swallows every mutation until commit or cancel.
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

// Whole-doc change test for the edit-session commit. Three fields are excluded,
// each written by the solve rather than by the user:
// - part_style: reconcilePartStyle fabricates entries there during a solve,
//   which would manufacture an edit out of nothing.
// - initial: the solver write-back (applyGeometryToFeature) re-bakes the solved
//   geometry of every sketch on each solve. A suppressed session is only ever
//   open on a non-sketch feature (a sketch edit runs its own unsuppressed
//   session and keeps one entry per action), so an `initial` change inside one
//   can only have come from the write-back. Counting it would push an aggregate
//   entry that restores a doc with no user change in it, and undo would then
//   re-solve to re-derive the same geometry, which reads as a dead step.
// - rollback: it is pinned during an edit (the mirror only runs when
//   editingFeatureId is null), so it can never be a user change inside a session.
// stringify is read-only, so the excluded keys are dropped by destructuring the
// rest; that keeps the remaining key order and every nested value by reference,
// and a whole-doc deep clone would only be discarded. `initial` lives one level
// down on the features, which are shared by reference with the doc, so the strip
// copies each feature object instead of deleting the key off the original.
function docDiffersForSession(a: PartDoc, b: PartDoc): boolean {
  return JSON.stringify(stripSolveWritten(a)) !== JSON.stringify(stripSolveWritten(b))
}

function stripSolveWritten(doc: PartDoc): Record<string, unknown> {
  const { part_style: _partStyle, rollback: _rollback, features, ...rest } = doc
  return {
    ...rest,
    ...(features && { features: features.map(stripSolvedGeometry) }),
  }
}

const stripSolvedGeometry = ({ initial: _initial, ...feature }: PartFeature): Record<string, unknown> => feature

// The unsaved-changes flag after a session cancel rewound the doc to `snapshot`.
// The flag has to mean one thing: the stored bytes no longer match the doc that
// just became live. So the decision is made against what a save REALLY stored --
// the fingerprint it published of the exact text it wrote -- rather than against
// the save count, which only proves that one landed. A session whose edits netted
// to zero, or that changed nothing at all, stored the very text the rewind
// restores: nothing is unsaved, and reading the moved save count as "an edit was
// stored" would flag the document dirty forever. Only a session a save actually
// landed in pays the serialization here, because that is the only one with
// anything to compare.
function restoreDirtyAfterSessionRewind(pinned: PinnedDirty, snapshot: PartDoc, rewound: boolean): void {
  const store = useUnsavedChangesStore.getState()
  const savesMoved = store.saves !== pinned.saves
  if (savesMoved && store.savedHash !== null) {
    store.setDirty(store.savedHash !== hashSavedText(stringifyYaml(snapshot)))
    return
  }
  // Nothing published what it stored. Either no save landed at all, so the pinned
  // flag is the whole story and the rewind restores the very doc it described --
  // including a session whose edits netted to zero, where every mutation set the
  // flag and nothing was thrown away. Or one landed without saying what it wrote,
  // in which case only the rewind says whether that save's bytes were discarded.
  if (!savesMoved || rewound) {
    store.restoreDirtyAfterRewind(pinned)
  }
  // A save landed without a fingerprint and the rewind threw nothing away: the
  // flag stands wherever that save left it.
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
  // `in` narrows the discriminated union, where a cast through
  // `{ featureId?: string }` could not: a variant that drops or renames either
  // key stops matching here instead of silently reading back undefined.
  // Narrowing alone is not enough though, since a variant can carry its target
  // under a key this function never learns to read; the classification is what
  // is bound to those keys, by SliceReadableMutation in mutationIdempotence.
  const featureId = 'featureId' in m ? m.featureId : undefined
  const bodyId = 'bodyId' in m ? m.bodyId : undefined
  if (bodyId === undefined && BODY_STYLE_MUTATION_TYPES.has(m.type)) {
    failLoud('[usePartDoc] body-style mutation dispatched without a bodyId')
    return GUARD_BYPASS
  }
  const slice: Record<string, unknown> = {}
  if (doc.rollback !== undefined) slice.rollback = doc.rollback
  if (m.type === 'reorder_features') {
    slice.features = (doc.features ?? []).map(f => f.id)
  } else if (m.type === 'remove_dangling_content') {
    // The cleanup names the features it might touch in its payload; slice those
    // whole, or the compare would be blind to the content it removes. Required
    // by the type, and the handler reads it before this runs, so there is no
    // absent-plan case left to absorb.
    const touched = Object.keys(m.features)
    slice.features = touched.map(id => (doc.features ?? []).find(f => f.id === id))
  } else if (featureId !== undefined) {
    slice.features = [(doc.features ?? []).find(f => f.id === featureId)]
  }
  if (bodyId !== undefined) {
    slice.part_style = { [bodyId]: doc.part_style?.[bodyId] }
  }
  return slice
}

type ReSolveFn = (d: PartDoc, opts?: { validate?: boolean; bypassCache?: boolean; dragAnchor?: { featureId: string; entityId: string }; _suppressFirstSolve?: boolean; _restoreSolveResults?: Record<string, SketchData> }) => Promise<void> | void

type SolveOptions = NonNullable<Parameters<ReSolveFn>[1]>

// The result of running a mutation set on a clone: the handlers' doc, the solve
// results the prune leaves behind, and the snapshots a whole-feature removal
// keeps for a failing re-solve.
interface AppliedMutations {
  next: PartDoc
  restorable: Record<string, SketchData> | null
  nextSolveResults: Record<string, SketchData>
}

// One slot owns "open work": a colour preview or an edit session, never both.
// The two used to be independent machines with a separately toggled suppression
// flag, and every boundary between them had to hand-restore that flag to keep
// the overlap from corrupting the undo story. With one tagged union the overlap
// is unrepresentable: suppression is a read of the session variant, a preview
// cannot survive a session boundary, and `openWorkRef` is the single place the
// hook tracks what owns the document right now.
interface PreviewWork {
  baseline: PartDoc
  touched: boolean
  dirty: PinnedDirty
}

interface SessionWork {
  baseline: PartDoc
  suppressed: boolean
  styleTouched: boolean
  dirty: PinnedDirty
}

type OpenWork =
  | ({ kind: 'preview' } & PreviewWork)
  | ({ kind: 'session' } & SessionWork)
  | null

function previewOf(work: OpenWork): ({ kind: 'preview' } & PreviewWork) | null {
  return work?.kind === 'preview' ? work : null
}

function sessionOf(work: OpenWork): ({ kind: 'session' } & SessionWork) | null {
  return work?.kind === 'session' ? work : null
}

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

  // The open-work slot. Its variants carry what the old per-machine refs each
  // held: the baseline a cancel rewinds to, the unsaved-changes pin a cancel
  // restores, and the flags the commit gates read (touched for a preview,
  // styleTouched for a suppressed session).
  const openWorkRef = useRef<OpenWork>(null)
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

  // Dropping the open-work slot is what makes a nested session unreachable
  // after an undo: without it the next commit/cancel would still hold the
  // pre-undo world and write it back. The page callback runs FIRST so it can
  // still read which feature was being edited (Part.tsx decides the panel
  // fallback from the id); closing the store's editor fields here keeps this
  // the complete "abandon the editor" unit even with no page attached, so a
  // redo whose open-work commit empties the redo branch still closes the editor
  // when applyUndoRedo stops at its own guard.
  const tearDownEditorState = useCallback(() => {
    openWorkRef.current = null
    brepWithholdRef.current = { armed: false, doc: null }
    undoTeardownRef.current?.()
    usePartEditorStore.getState().setEditingFeatureId(null)
    usePartEditorStore.getState().setPickBoundary(null)
  }, [])

  const {
    undoStack, redoStack, pushUndo, pushUndoSnapshot, applyUndoRedo,
    saveUndoStackSnapshot, restoreUndoStackSnapshot, clearUndoStackSnapshot,
  } = useUndoRedo(docRef, setDoc, restoreAwareReSolve, tearDownEditorState)

  const startPreviewMode = useCallback((originalDoc: PartDoc) => {
    const open = openWorkRef.current
    if (open?.kind === 'preview') {
      failLoud('[usePartDoc] startPreviewMode called while a preview is already active (nested preview not supported)')
      // A nested preview must not overwrite the live baseline.
      return
    }
    if (open?.kind === 'session') {
      failLoud('[usePartDoc] startPreviewMode called while an edit session is active (a session owns the document until commit or cancel)')
      // A session owns the doc until it commits or cancels; a preview opened
      // over it would apply mutations the session's own undo story cannot see
      // and its cancel would rewind past edits the session still owns.
      return
    }
    openWorkRef.current = {
      kind: 'preview',
      baseline: cloneDocForUndo(originalDoc),
      touched: false,
      dirty: useUnsavedChangesStore.getState().pinDirty(),
    }
  }, [])

  // Whether committing the open preview would push an entry. Same-value apply
  // (e.g. a preview that never changed the color) restores the pre-preview doc
  // on undo, so it must not leave a dead step behind. The change gate excludes
  // solve-fabricated part_style entries the way the edit-session diff does:
  // only a real non-part_style change, or a preview that actually swallowed a
  // scope mutation, earns an entry. Shared with the undo pre-commit so the two
  // cannot disagree about whether there is anything to commit.
  const previewWouldPush = useCallback(() => {
    const work = previewOf(openWorkRef.current)
    const current = docRef.current
    if (!work || !current) return false
    return docDiffersForSession(work.baseline, current)
      || (work.touched && previewMutationFor(work.baseline, current) !== null)
  }, [docRef])

  const commitPreview = useCallback((mutation: Mutation) => {
    const work = previewOf(openWorkRef.current)
    if (!work) {
      failLoud('[usePartDoc] commitPreview called with no active preview')
      return
    }
    const current = docRef.current
    if (current && previewWouldPush()) {
      // The popover applies set_part_color no matter what was edited, so the
      // label is composed from the actual part_style diff; a preview whose
      // change was elsewhere keeps the mutation it was handed.
      // `work.baseline` is the preview baseline, already an independent
      // throwaway clone (startPreviewMode) that commitPreview drops below, so
      // the snapshot push skips the redundant re-clone.
      pushUndoSnapshot(previewMutationFor(work.baseline, current) ?? mutation, work.baseline)
    }
    openWorkRef.current = null
  }, [pushUndoSnapshot, docRef, previewWouldPush])

  const cancelPreview = useCallback(() => {
    const work = previewOf(openWorkRef.current)
    if (!work) {
      // No live preview: it already committed (an escape), so there is nothing
      // to rewind. null tells the caller to just close the popover.
      return null
    }
    openWorkRef.current = null
    // Doc rewind, flag restore and re-solve are one unit owned here, like
    // cancelEditSession: the doc is a Mutation-only surface of this hook, so the
    // page that closes the popover never writes it. The returned doc is the
    // snapshot the live doc was rewound to.
    if (docRef.current) {
      docRef.current = work.baseline
      setDoc(work.baseline)
      reSolve(work.baseline)
    }
    useUnsavedChangesStore.getState().restoreDirtyAfterRewind(work.dirty)
    return work.baseline
  }, [docRef, setDoc, reSolve])

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

  // Arms-and-consumes the brep withhold for a mutation that applies without an
  // entry. Consuming it on every such path keeps the arm from outliving the
  // "next mutation" it covers: left armed, it would swallow the next unrelated
  // mutation as "the projection". `fallback` is the pre-gesture doc, kept only
  // when no earlier pick in the gesture already captured one.
  const consumeBrepArm = useCallback((fallback: PartDoc) => {
    const brep = brepWithholdRef.current
    if (brep.armed) {
      brepWithholdRef.current = { armed: false, doc: brep.doc ?? fallback }
    }
  }, [])

  // Runs the mutations in order on one clone of `current`. Pure apart from the
  // DEV handler warning and failLoud, so the callers decide whether the result
  // is a no-op before anything is applied. The clone is a plain deep copy; the
  // document holds references, not bytes.
  const runMutationsOnClone = useCallback((current: PartDoc, ms: Mutation[]): AppliedMutations => {
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
      // Content-removing edits invalidate the affected features' last solve;
      // prune it so stale geometry cannot linger while the re-solve is in flight.
      // Only whole-feature removals carry a restorable snapshot (a partial
      // delete's snapshot would redraw deleted entities after a failing solve);
      // partial deletes stay pruned and the doc-driven fallback renders them.
      const pruned = pruneSolveResults(m, nextSolveResults)
      nextSolveResults = pruned.next
      if (pruned.restorable) restorable = { ...(restorable ?? {}), ...pruned.restorable }
    }

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
      const rollback = ms.find(m => m.type === 'set_rollback') as Extract<Mutation, { type: 'set_rollback' }> | undefined
      if (rollback && editorStore.rollbackPosition !== rollback.position) {
        failLoud('[usePartDoc] set_rollback dispatched with the rollback store not pre-synced')
      }
      applySetRollback(next, editorStore.rollbackPosition)
    }

    return { next, restorable, nextSolveResults }
  }, [solveResultsRef])

  // The shared tail of both funnels, run once the mutations are known to change
  // the doc: the dirty flag, the solve-result prune and its stash, then the undo
  // branch (swallow, preview escape, or push), then the doc swap and re-solve.
  const landMutations = useCallback((
    ms: Mutation[],
    current: PartDoc,
    applied: AppliedMutations,
    solveOptions: SolveOptions,
  ) => {
    const { next, restorable, nextSolveResults } = applied
    // Every doc edit funnels through here (direct mutations, drags, and preview
    // commits all call handleMutation), so this is the one place that flags the
    // document as having changes not yet saved to its store.
    useUnsavedChangesStore.getState().setDirty(true)
    if (nextSolveResults !== solveResultsRef.current) setSolveResults(nextSolveResults)
    // The restorable snapshot is also retained for the undo boundary (the undo
    // re-solve has no other source for it), limited to body-producing kinds.
    if (restorable) {
      for (const featureId of Object.keys(restorable)) {
        const kind = featureKindOf(current, featureId)
        if (kind && NO_FALLBACK_BREP_KINDS.has(kind)) {
          stashPrunedResult(featureId, restorable[featureId])
        }
      }
    }

    // A mutation the color preview cannot produce while a preview is open is an
    // escape: the popover is non-modal, so a sketch edit mid-preview folds the
    // pending color into its own entry (commitPreview) and then pushes normally
    // below, instead of being swallowed and destroyed by a later cancel. A
    // group made entirely of preview-scope mutations is a preview frame and
    // stays swallowed.
    const inPreviewScope = ms.every(m => PREVIEW_SCOPE.has(m.type))
    const preview = previewOf(openWorkRef.current)
    if (preview && !inPreviewScope) {
      commitPreview(previewMutationFor(preview.baseline, current) ?? ms[0])
    }
    // Re-read the slot after the escape: the commit above nulled it, so the
    // branches below see the world the mutation is actually landing in. The
    // union guarantees at most one of preview/session is live.
    const session = sessionOf(openWorkRef.current)
    if (session?.suppressed) {
      // A suppressed session swallows every mutation: it owns the doc until
      // commit or cancel, and its aggregate entry reverts the work wholesale.
      // A swallowed part_style mutation is a real user change the session diff
      // cannot see (it strips part_style); remember it so commit pushes an
      // entry that can revert the color/visibility, not just the feature spec.
      if (ms.some(m => BODY_STYLE_MUTATION_TYPES.has(m.type))) {
        session.styleTouched = true
      }
      // A swallow still fulfils the withhold's "next mutation" contract.
      consumeBrepArm(current)
    } else {
      const livePreview = previewOf(openWorkRef.current)
      if (livePreview) {
        // A live top-level preview swallows only the part_style mutations it
        // produces; anything else escaped above. The touched flag is what lets
        // the commit gate tell a user color change from a part_style entry the
        // solve fabricated.
        livePreview.touched = true
        consumeBrepArm(current)
      } else {
        // The first mutation names the entry so the undo tooltip has a label;
        // redo round-trips it, so only the doc matters, never the list itself.
        applyWithholdOrPush(ms[0], current)
      }
    }

    docRef.current = next
    setDoc(next)
    reSolve(next, {
      ...solveOptions,
      ...(restorable ? { _restoreSolveResults: restorable } : {}),
    })
  }, [docRef, setDoc, reSolve, setSolveResults, solveResultsRef, commitPreview, applyWithholdOrPush, stashPrunedResult, consumeBrepArm])

  const handleMutation = useCallback((m: Mutation) => {
    setSolveError(null)
    const current = docRef.current
    if (!current) return

    // The no-op guard compares the result against the pre-mutation doc before
    // anything is committed, so a dead step never reaches the stack.
    const applied = runMutationsOnClone(current, [m])
    const next = applied.next

    // A value mutation that leaves the doc byte-identical is a dead undo step,
    // and re-solving for it wastes a build: skip the push, the dirty flag and
    // the solve together. The rollback write is part of the compare, so a
    // mirror-visible rollback change still counts as a real edit. The slice
    // limits the stringify to the touched feature/part_style entry instead of
    // the whole doc, a plain O(touched) optimization for large feature lists.
    if (IDEMPOTENT_MUTATION[m.type]) {
      const slice = noOpSliceFor(m, current)
      // GUARD_BYPASS means the slice cannot represent the change (a body-style
      // mutation missing its bodyId), so the compare is skipped entirely and
      // the mutation always lands: the guard is never the reason a doc
      // mutation goes unrecorded.
      if (slice !== GUARD_BYPASS
        && JSON.stringify(slice) === JSON.stringify(noOpSliceFor(m, next))) {
        // A no-op is still "the next mutation" as far as the gesture is
        // concerned, so the arm is consumed here too.
        consumeBrepArm(current)
        return
      }
    }

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
    landMutations([m], current, applied, {
      bypassCache: dragAnchor !== undefined,
      dragAnchor,
      _suppressFirstSolve: true,
    })
  }, [docRef, setSolveError, runMutationsOnClone, consumeBrepArm, landMutations])

  const startEditSession = useCallback((suppressUndo: boolean) => {
    if (!docRef.current) return
    const open = openWorkRef.current
    if (open?.kind === 'session') {
      failLoud('[usePartDoc] startEditSession called while an edit session is already active (nested edit session not supported)')
      // In prod failLoud is a silent no-op, so without this return the call
      // below would overwrite the baseline with the CURRENT (already-edited)
      // doc, moving the outer session's restore point past its own edits and
      // making them permanently non-undoable. Refuse instead: the caller is
      // responsible for closing the active session before opening another.
      return
    }
    // A preview open at session start is a defined edge, not an error: resolve
    // it FIRST, with the same mutation/push semantics as commitPreview, so the
    // baseline below is taken after the entry (color kept, with its own entry).
    // A session opened over a live preview would bake the preview into its
    // baseline, and a later cancel would rewind to a doc carrying a color with
    // no undo entry for it. Label-only: the entry reverts the colour and its
    // wording shows in the undo tooltip (PartToolbar), so the internal reason
    // (resolved here rather than by the popover's Apply) stays in this comment.
    if (open?.kind === 'preview') {
      commitPreview({ type: 'preview_commit', description: 'apply previewed color' })
    }
    openWorkRef.current = {
      kind: 'session',
      baseline: cloneDocForUndo(docRef.current),
      // Which kind of session this is decides what commitEditSession does: a
      // suppressed (feature) session folds into one aggregate entry, a sketch
      // session keeps its per-action entries and pushes nothing extra.
      suppressed: suppressUndo,
      styleTouched: false,
      dirty: useUnsavedChangesStore.getState().pinDirty(),
    }
    saveUndoStackSnapshot()
  }, [docRef, saveUndoStackSnapshot, commitPreview])

  // Whether committing the open suppressed (feature) session would push its
  // aggregate entry. A sketch session already left one undo entry per action;
  // an aggregate on top would double-record the same work, so only a
  // suppressed session needs the collapse into one step. Entering an edit and
  // leaving it without touching anything must not leave an undo step behind:
  // it would restore an identical doc, so undo would look dead to the user.
  // The whole-doc diff excludes the solve-written fields part_style and initial,
  // and rollback (the mirror is gated on editingFeatureId === null, so it cannot
  // drift here). A part_style mutation swallowed by the session is a real user
  // change the diff cannot see, so it forces the entry too.
  const sessionWouldPush = useCallback(() => {
    const work = sessionOf(openWorkRef.current)
    if (!work || !work.suppressed || !docRef.current) return false
    return docDiffersForSession(work.baseline, docRef.current) || work.styleTouched
  }, [docRef])

  const commitEditSession = useCallback(() => {
    const work = sessionOf(openWorkRef.current)
    if (!work) {
      // No active session (e.g. add+enter pattern where only editingFeatureId
      // was set without starting a session). Silently skip.
      return
    }
    const push = sessionWouldPush()
    openWorkRef.current = null
    if (push) {
      // The store still holds the edited feature here (commitEditSession runs
      // before the caller's exit cleanup clears it), so the undo label can name
      // the feature instead of rendering an empty one.
      // `work.baseline` is the session baseline, already an independent
      // throwaway clone (startEditSession) that this commit drops below, so the
      // snapshot push skips the redundant re-clone.
      const featureId = usePartEditorStore.getState().editingFeatureId ?? ''
      pushUndoSnapshot({ type: 'edit_session', featureId }, work.baseline)
    }
    // No preview can be open here: the one slot never holds a session and a
    // preview together, so there is no second entry to fold in after the
    // aggregate (the old session-commit resolution).
    clearUndoStackSnapshot()
  }, [pushUndoSnapshot, clearUndoStackSnapshot, sessionWouldPush])

  // An undo or redo mid-edit first commits the open work as its own entry, so
  // the history move reverts (undo) or reaches (redo) exactly that work. Without
  // it the teardown dropped the session or preview and the move carried those
  // edits along with an unrelated step. Only work that would push is committed:
  // closing a session that changed nothing would leave the editor open with its
  // session gone, and a move on the then-still-empty stack would never tear it
  // down. Both directions commit, matching the assembly engine.
  //
  // Returns true exactly when it pushed open work, false when it did nothing.
  const commitOpenWorkBeforeHistory = useCallback(() => {
    let committed = false
    // A brep pick's projection is applied without an entry until its dimension
    // commits. Outside a suppressed session (whose aggregate already covers it)
    // it is open work like any other: give it the entry the commit would have,
    // keyed to the pre-pick doc, so the history move reverts exactly the
    // projection.
    const pendingBrep = brepWithholdRef.current.doc
    if (pendingBrep && sessionOf(openWorkRef.current)?.suppressed !== true && docRef.current) {
      // The pending projection (an edge projected onto the sketch by a brep
      // dimension pick) is banked as its own entry because the history move is
      // about to carry it away. Undo removes the projection, so the label names
      // what the step added.
      pushUndo({ type: 'preview_commit', description: 'add projected edge' }, pendingBrep)
      brepWithholdRef.current = { armed: false, doc: null }
      committed = true
    }
    if (sessionOf(openWorkRef.current)?.suppressed) {
      // A suppressed session is the only undo owner of its doc: no preview can
      // be open beside it, so there is no second work to resolve.
      if (sessionWouldPush()) {
        commitEditSession()
        committed = true
      }
    } else if (previewWouldPush()) {
      // Resolved here because the history move arrived first, not because the
      // popover's Apply was clicked; the entry still just reverts the color.
      commitPreview({ type: 'preview_commit', description: 'apply previewed color' })
      committed = true
    }
    return committed
  }, [sessionWouldPush, previewWouldPush, commitEditSession, commitPreview, pushUndo, docRef])

  // Both directions are the same move: resolve the open work, then let the engine
  // apply it. The commit may push, and a push clears the redo branch the move is
  // about to read, so a redo that follows cannot move -- that is the fact the
  // engine cannot see from the stack alone, and it is passed along as
  // openWorkCommitted instead of being compensated for here. Undo never needs it
  // (the commit's entry lands on the undo stack, so the move proceeds and tears
  // down in its normal place), and saying so costs one boolean.
  const moveWithOpenWork = useCallback((direction: 'undo' | 'redo') => {
    const committed = commitOpenWorkBeforeHistory()
    applyUndoRedo(direction, { openWorkCommitted: committed })
  }, [commitOpenWorkBeforeHistory, applyUndoRedo])

  const handleUndoWithOpenWork = useCallback(() => { moveWithOpenWork('undo') }, [moveWithOpenWork])

  const handleRedoWithOpenWork = useCallback(() => { moveWithOpenWork('redo') }, [moveWithOpenWork])

  const cancelEditSession = useCallback(() => {
    const work = sessionOf(openWorkRef.current)
    // No session means none was ever started (add-and-enter only sets
    // editingFeatureId), so there is nothing to rewind -- but the exit still
    // needs the re-solve below.
    if (work) {
      // The baseline predates every in-session edit, so the rewind below
      // discards them wholesale; the one-slot union means there is no separate
      // preview to drop, and clearing the session leaves the popover's own
      // Cancel finding nothing, so it becomes a null no-op instead of a second,
      // stale rewind.
      openWorkRef.current = null
      // Doc rewind and stack restore are ONE unit (see useUndoRedo's snapshot
      // pairing contract): the stacks only describe the pre-session doc again
      // once the live doc has been rewound to it. Restoring in the other
      // order, or without the rewind, would leave the stack top naming a doc
      // the live doc is not.
      //
      // The write-back installs a fresh doc object on every solve, so object
      // identity says nothing here and the rewind has to be judged on content.
      const rewound = JSON.stringify(work.baseline) !== JSON.stringify(docRef.current)
      docRef.current = work.baseline
      setDoc(work.baseline)
      restoreUndoStackSnapshot()
      // The bar travels back with the doc it belongs to. The re-solve below reads
      // its position off the STORE (useSolver), not off the doc, so a bar left
      // where some other path parked it would rebuild a stack the restored doc
      // says is rolled back -- and since doc.rollback is what a reload reads, the
      // two would then disagree about what is visible. Re-derived from the
      // restored doc exactly as applyUndoRedo does, clamp included.
      const restoredCount = work.baseline.features?.length ?? 0
      usePartEditorStore.getState().setRollbackPosition(
        Math.min(Math.max(work.baseline.rollback ?? restoredCount, 0), restoredCount),
      )
      restoreDirtyAfterSessionRewind(work.dirty, work.baseline, rewound)
    }
    // Rewinding the doc is this function's own doing, so it owns the re-solve
    // too. Leaving it to the caller's exit cleanup meant any other route into
    // cancel left the viewport on the discarded edit.
    if (docRef.current) reSolve(docRef.current)
  }, [docRef, setDoc, reSolve, restoreUndoStackSnapshot])

  // Applies a set of mutations a single gesture produced (an end-snapped line,
  // a multi-face projection, a multi-feature delete) as ONE undo entry and one
  // re-solve. The handlers run in order on one clone; the entry restores the
  // pre-gesture doc, so undo undoes the whole gesture at once.
  const commitMutationGroup = useCallback((ms: Mutation[]) => {
    setSolveError(null)
    const current = docRef.current
    if (!current || ms.length === 0) return

    const applied = runMutationsOnClone(current, ms)

    // A group whose handlers all no-opped (e.g. a re-drop of a selection) must
    // not leave a dead entry or waste a solve. Unlike the single-mutation path
    // this compares the whole doc, since a group can mix kinds the slice does
    // not cover.
    if (JSON.stringify(current) === JSON.stringify(applied.next)) {
      consumeBrepArm(current)
      return
    }

    landMutations(ms, current, applied, { _suppressFirstSolve: true })
  }, [docRef, setSolveError, runMutationsOnClone, consumeBrepArm, landMutations])

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
    handleUndo: handleUndoWithOpenWork,
    handleRedo: handleRedoWithOpenWork,
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
