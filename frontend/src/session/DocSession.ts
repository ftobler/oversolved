import { stringify as stringifyYaml } from 'yaml'
import type { PartDoc, Mutation, SketchData } from '@/types/cad'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { IDEMPOTENT_MUTATION } from '@/hooks/mutationIdempotence'
import { describeMutation } from '@/utils/core/mutationDescriptions'
import { applySetRollback } from '@/utils/yamlMutations'
import { pruneSolveResults } from '@/utils/yamlMutations/solveResults'
import { isDimensionKind } from '@/registry/constraintRegistry'
import { MAX_UNDO_DEPTH } from '@/config/undoConfig'
import { History, type HistoryEntry } from '@/session/History'
import { BODY_STYLE_MUTATION_TYPES, GUARD_BYPASS, noOpSliceFor } from '@/session/noOpGuard'
import { reconcileDirty, type DirtyFacts, type DirtyPin } from '@/session/dirty'
import {
  errorResult,
  okResult,
  openedResult,
  type OpenedResult,
  type Result,
  type SessionErrorCode,
  type SessionFailure,
} from '@/session/result'
import type { SolveOptions, SolveScheduler, SolveSchedulerState } from '@/session/SolveScheduler'
import {
  PREVIEW_SCOPE,
  NO_FALLBACK_BREP_KINDS,
  docDiffersForSession,
  featureKindOf,
  previewMutationFor,
} from '@/session/sessionDiff'

// The editor state the session does not own: the rollback bar position and the
// open feature editor are injected so the rollback mirror and the
// transaction-boundary rules keep working without importing a store.
export interface EditorFacts {
  editingFeatureId: string | null
  rollbackPosition: number | null
}

// One durable, replayable doc change: the mutations that produced it and the
// docs on either side, handed to the journal sink synchronously inside the
// apply, before any solve can write back. The sink hashes the docs there, so a
// replay hashing right after its own apply sees the same pre-write-back state.
export interface SessionJournalChange {
  // The document the session was opened on; the sink restarts its generation
  // when this changes, so a journal can never span two documents.
  docId: string | null
  kind: 'mutation' | 'batch'
  payload: Mutation | Mutation[]
  label: string
  beforeDoc: PartDoc
  afterDoc: PartDoc
  // True when a solve was pending or running as this apply landed: the before
  // doc is authored (pre-write-back), and a replay that settles each step will
  // reach a baked state this entry cannot chain onto. False for every apply of
  // a script or CLI run, which settles each step before the next.
  unsettled: boolean
}

// The journal's view of the session. The sink is optional, so a session
// without one does no journal bookkeeping at all.
export interface SessionJournalSink {
  // Called synchronously before a mutation set runs, so the journal can open a
  // generation (draw its seed and install its id source) before any handler
  // mints an id, and note the source position the entry will start from.
  onBeforeApply(docId: string | null): void
  onDocChange(change: SessionJournalChange): void
  // The doc moved through a path no mutation can replay (undo/redo, a
  // transaction rewind). The journal restarts its generation from the doc the
  // next change starts from.
  onDocReset(): void
}

// The live document, owned by the adapter until editor-state-one-owner folds it
// in: the session reads and writes through this port, so the loader and the
// solver write-back (the one doc write outside the mutation path) stay visible
// without a second copy that could drift.
export interface DocPort {
  get(): PartDoc | null
  set(next: PartDoc | null): void
}

// The solver's result map. The session prunes it optimistically for
// content-removing edits and hands the pruned snapshots to the re-solve, so it
// reads and writes through the adapter's live copy.
export interface SolveResultsPort {
  get(): Record<string, SketchData>
  set(next: Record<string, SketchData>): void
}

export interface DocSessionDeps {
  cloneDoc: (doc: PartDoc) => PartDoc
  doc: DocPort
  solve: SolveScheduler<PartDoc>
  solveResults: SolveResultsPort
  editorFacts: () => EditorFacts
  // The live unsaved-changes facts (the UI-facing store until
  // editor-state-one-owner folds it in). The session owns the pin and the
  // reconcile decision; the facts are read at pin and reconcile time only.
  dirtyFacts: () => DirtyFacts
  docId?: string | null
  // Supplied by the adapter until editor-state-one-owner owns them; absent
  // means the inspection simply omits the field.
  getValidation?: () => unknown
  getBodies?: () => unknown
  // The journal sink (the part editor, the headless CLI). Absent in the unit
  // suites and the assembly editor: no sink, no bookkeeping. The part editor
  // supplies one in every build, because the recovery autosave borrows its
  // repro tail.
  journal?: SessionJournalSink
}

export interface SessionDiagnostic {
  code: SessionErrorCode
  message: string
}

export type TransactionId = string
export type TransactionKind = 'preview' | 'edit' | 'gesture' | 'brep'

export interface TransactionSummary {
  id: TransactionId
  kind: TransactionKind
}

export interface BeginOptions {
  // preview: the caller's original doc; cloned here so the transaction owns an
  // independent rewind point. Defaults to the live doc.
  baseline?: PartDoc
  // edit: a suppressed (feature) session folds into one aggregate entry; a
  // sketch session keeps the per-action entries.
  suppressed?: boolean
}

export interface CommitOptions {
  // preview: the mutation the caller was handed. The label is composed from
  // the part_style diff when there is one; otherwise the entry carries this
  // mutation, so a same-value apply still names what the user did.
  mutation?: Mutation
}

export interface SessionInspection {
  docId: string | null
  dirty: boolean
  featureCount: number
  rollback: number | null
  editingFeatureId: string | null
  history: { undo: string[]; redo: string[] }
  transactions: TransactionSummary[]
  solve: SolveSchedulerState
  validation?: unknown
  bodies?: unknown
}

// The events L1 emits. `historyRestored` is an undo/redo move and carries the
// entry the adapter needs for its editor writes; `transactionsDropped` is the
// editor teardown a move (or a blocked move that just resolved open work)
// performs; `changed` is every other observable state change, so a
// useSyncExternalStore adapter can re-render.
export type SessionEvent =
  | { type: 'historyRestored'; direction: 'undo' | 'redo'; entry: HistoryEntry<PartDoc, Mutation> }
  | { type: 'transactionsDropped' }
  | { type: 'changed' }

// The store's rollback bar after a restore, clamped to the restored feature
// list exactly as Part.tsx clamps a loaded doc. Exported pure so the UI
// adapter derives it from an event doc without importing the session.
export function clampRollbackPosition(doc: PartDoc): number {
  const featureCount = doc.features?.length ?? 0
  return Math.min(Math.max(doc.rollback ?? featureCount, 0), featureCount)
}

// The label a preview commit falls back to when no caller mutation is handed
// in and the part_style diff is empty.
const PREVIEW_COMMIT_FALLBACK: Mutation = { type: 'preview_commit', description: 'apply previewed color' }

// The mutations that can add a doc-addressable id (a feature, an entity, a
// constraint). The id set is only diffed for dispatches that contain one, so
// the drag path pays nothing for a field it can never fill.
const CREATING_MUTATION_TYPES = new Set<Mutation['type']>([
  'add_constraint',
  'add_entity', 'add_entity_with_constraint', 'add_projected_entity',
  'add_rect', 'add_center_rect', 'add_ngon', 'apply_offset',
  'add_sketch', 'add_plane', 'add_import_step',
  'add_extrude', 'add_revolve', 'add_sweep',
  'add_fillet', 'add_chamfer', 'add_boolean',
  'add_array', 'add_circular_array', 'add_delete_body', 'add_hole',
  'add_transform', 'add_mirror', 'add_variable', 'add_helix',
])

function contentIds(doc: PartDoc): Set<string> {
  const ids = new Set<string>()
  for (const feature of doc.features ?? []) {
    ids.add(feature.id)
    if (feature.kind !== 'sketch') continue
    for (const entity of feature.entities ?? []) ids.add(entity.id)
    for (const constraint of feature.constraints ?? []) ids.add(constraint.id)
  }
  return ids
}

function createdIdsBetween(before: PartDoc, after: PartDoc): string[] {
  const beforeIds = contentIds(before)
  const created: string[] = []
  for (const feature of after.features ?? []) {
    if (!beforeIds.has(feature.id)) created.push(feature.id)
    if (feature.kind !== 'sketch') continue
    for (const entity of feature.entities ?? []) {
      if (!beforeIds.has(entity.id)) created.push(entity.id)
    }
    for (const constraint of feature.constraints ?? []) {
      if (!beforeIds.has(constraint.id)) created.push(constraint.id)
    }
  }
  return created
}

function dragAnchorFor(m: Mutation): { featureId: string; entityId: string } | undefined {
  return m.type === 'move_vertex' || m.type === 'move_vertex_with_constraint'
    || m.type === 'move_entity' || m.type === 'resize_circle'
    ? { featureId: m.featureId, entityId: m.entityId }
    : undefined
}

type AnyHandler = (doc: PartDoc, m: Mutation) => void

// The result of running a mutation set on one clone, with the pruned solve
// results and the whole-feature snapshots a failing re-solve can restore.
interface AppliedMutations {
  next: PartDoc
  restorable: Record<string, SketchData> | null
  nextSolveResults: Record<string, SketchData>
}

interface TransactionBase {
  id: TransactionId
  kind: TransactionKind
}

interface PreviewTransaction extends TransactionBase {
  kind: 'preview'
  baseline: PartDoc
  touched: boolean
  dirty: DirtyPin
}

interface EditTransaction extends TransactionBase {
  kind: 'edit'
  baseline: PartDoc
  suppressed: boolean
  styleTouched: boolean
  dirty: DirtyPin
}

// The explicit fold for gesture-shaped work (a drag that lands as one entry):
// mutations apply live with no entries while it is open, commit banks one entry
// keyed to the baseline, cancel rewinds it.
interface GestureTransaction extends TransactionBase {
  kind: 'gesture'
  baseline: PartDoc
  firstMutation: Mutation | null
  dirty: DirtyPin
}

// The brep pick/commit pair. `armed` applies the next mutation without an
// entry; a consumed arm leaves `doc` as the pre-gesture doc the dimension
// commit restores.
interface BrepTransaction extends TransactionBase {
  kind: 'brep'
  armed: boolean
  doc: PartDoc | null
}

type Transaction = PreviewTransaction | EditTransaction | GestureTransaction | BrepTransaction

// The framework-free L1 session: it owns the history, the transaction stack,
// the dirty policy and solve scheduling; every doc write goes through execute,
// executeGroup, a transaction boundary or undo/redo. It imports no React and no
// store, so it runs headless in node; the UI adapter mirrors its state into
// React and the stores.
export class DocSession {
  private readonly deps: DocSessionDeps
  private readonly history: History<PartDoc, Mutation>
  private readonly listeners = new Set<(event: SessionEvent) => void>()
  private readonly diagnosticsLog: SessionDiagnostic[] = []
  // The stack of open transactions, oldest first. Preview and edit are
  // mutually exclusive by begin's rules; a brep arm nests inside either; a
  // gesture runs alone.
  private openTransactions: Transaction[] = []
  // Retained pruned solve results, keyed by feature id, held across the undo
  // boundary. Edits hand their pruned snapshot to their own re-solve, but an
  // undo carries no solve results, so this stash is the one fallback a restored
  // entry can render from when the re-solve fails.
  private restoreStash: Record<string, SketchData> = {}
  private dirtyOverride: boolean | null = null
  private idCounter = 0
  private versionCounter = 0

  constructor(deps: DocSessionDeps) {
    this.deps = deps
    this.history = new History({ cloneDoc: deps.cloneDoc, cap: MAX_UNDO_DEPTH })
  }

  getDoc(): PartDoc | null {
    return this.deps.doc.get()
  }

  // ─── Change notification ───

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  // Bumps on every emitted event; the adapter's useSyncExternalStore snapshot.
  version(): number {
    return this.versionCounter
  }

  // ─── Editing ───

  execute(mutation: Mutation): Result {
    return this.apply([mutation], false)
  }

  executeGroup(mutations: Mutation[]): Result {
    if (mutations.length === 0) return okResult()
    return this.apply(mutations, true)
  }

  undo(): boolean {
    return this.move('undo')
  }

  redo(): boolean {
    return this.move('redo')
  }

  idle(): Promise<void> {
    return this.deps.solve.idle()
  }

  // A solve of the current doc with no edit semantics: the adapter's session
  // exit paths (a cancel with no open session) use it to refresh the viewport.
  refreshSolve(): void {
    const doc = this.deps.doc.get()
    if (doc) void this.deps.solve.request(doc)
  }

  // Drops the retained pre-delete snapshot once a solve genuinely produced a
  // fresh result for it; called by the adapter from the solver's applied-solve
  // hook, after the request-id staleness guard.
  clearStashForSolved(featureIds: string[]): void {
    for (const featureId of featureIds) delete this.restoreStash[featureId]
  }

  // Records a caller-supplied snapshot as an edit entry. The transaction paths
  // push through here too; the shared undo-contract suite drives it directly
  // with fixture docs.
  pushUndo(label: string, doc: PartDoc, meta?: Mutation): void {
    this.history.push(label, doc, meta)
    this.emit({ type: 'changed' })
  }

  historyEntries(): { undo: readonly HistoryEntry<PartDoc, Mutation>[]; redo: readonly HistoryEntry<PartDoc, Mutation>[] } {
    return { undo: this.history.undoEntries(), redo: this.history.redoEntries() }
  }

  // ─── Transactions ───

  begin(kind: TransactionKind, opts: BeginOptions = {}): OpenedResult {
    switch (kind) {
      case 'preview': return this.beginPreview(opts)
      case 'edit': return this.beginEdit(opts)
      case 'gesture': return this.beginGesture()
      case 'brep': return this.beginBrep()
    }
  }

  commit(id: TransactionId, opts: CommitOptions = {}): Result {
    const txn = this.findById(id)
    if (!txn) {
      return this.fault('unknown-transaction', `no open transaction with id '${id}'`)
    }
    switch (txn.kind) {
      case 'preview': return this.commitPreviewTransaction(txn, opts.mutation)
      case 'edit': return this.commitEditTransaction(txn)
      case 'gesture': return this.commitGestureTransaction(txn)
      case 'brep': return this.commitBrepTransaction(txn)
    }
  }

  cancel(id: TransactionId): Result {
    const txn = this.findById(id)
    if (!txn) {
      return this.fault('unknown-transaction', `no open transaction with id '${id}'`)
    }
    switch (txn.kind) {
      case 'preview': return this.cancelRestoreTransaction(txn)
      case 'edit': return this.cancelEditTransaction(txn)
      case 'gesture': return this.cancelRestoreTransaction(txn)
      case 'brep':
        // The caller already ran the compensating delete: dropping the
        // withhold is the whole cancel, no rewind and no entry.
        this.removeTransaction(txn)
        this.emit({ type: 'changed' })
        return okResult()
    }
  }

  transactions(): TransactionSummary[] {
    return this.openTransactions.map(txn => ({ id: txn.id, kind: txn.kind }))
  }

  // ─── Dirty policy ───

  isDirty(): boolean {
    return this.dirtyOverride !== null ? this.dirtyOverride : this.deps.dirtyFacts().dirty
  }

  // The dirty decision the last session call produced, if any, handed to the
  // adapter exactly once for the store mirror. Consuming it is what keeps a
  // no-op call from re-asserting a stale decision over a newer external set:
  // the workspace seam can move the live flag between session calls, and the
  // old funnel left the store untouched on a no-op dispatch.
  takeDirtyDecision(): boolean | null {
    const decision = this.dirtyOverride
    this.dirtyOverride = null
    return decision
  }

  // The pin reads the live facts, exactly as the hook's store.pinDirty() did:
  // an external clear (a save without the save count moving, a test) must be
  // the pin, not the session's own stale view of its last edit.
  pinDirty(): DirtyPin {
    const facts = this.deps.dirtyFacts()
    return { dirty: facts.dirty, saves: facts.saves }
  }

  // A save landed: the facts now describe the stored bytes, so the session's
  // override (if any) has done its job and the live flag decides again.
  noteSaved(): void {
    this.dirtyOverride = null
  }

  // ─── Inspection ───

  diagnostics(): readonly SessionDiagnostic[] {
    return this.diagnosticsLog
  }

  inspect(): SessionInspection {
    const doc = this.deps.doc.get()
    const facts = this.deps.editorFacts()
    const validation = this.deps.getValidation?.()
    const bodies = this.deps.getBodies?.()
    return {
      docId: this.deps.docId ?? null,
      dirty: this.isDirty(),
      featureCount: doc?.features?.length ?? 0,
      rollback: doc?.rollback ?? null,
      editingFeatureId: facts.editingFeatureId,
      history: { undo: this.history.undoLabels(), redo: this.history.redoLabels() },
      transactions: this.transactions(),
      solve: this.deps.solve.state(),
      ...(validation !== undefined && { validation }),
      ...(bodies !== undefined && { bodies }),
    }
  }

  // ─── Mutation funnels ───

  private apply(mutations: Mutation[], group: boolean): Result {
    const current = this.deps.doc.get()
    if (!current) {
      return this.fault('no-document', 'execute called with no document')
    }
    const unsyncedRollback = this.unsyncedRollback(mutations)
    if (unsyncedRollback) {
      // The payload is advisory: the store owns the position and the mirror
      // writes it into the doc, so a dispatch without a pre-synced store would
      // silently no-op while still pushing an entry. Abort in every
      // environment; the adapter voices the pinned failLoud message.
      return this.fault('rollback-unsynced', 'set_rollback dispatched with the rollback store not pre-synced')
    }
    // Read the solve state before this apply requests its own solve: a busy
    // solve means the live doc is still authored, which the journal marks.
    const unsettled = this.solveBusy()
    // The journal opens its generation (and installs its id source) before the
    // handlers run, so an id a handler mints internally is a function of the
    // recorded seed.
    this.deps.journal?.onBeforeApply(this.deps.docId ?? null)
    const applied = this.runMutations(current, mutations)
    if (this.isNoOp(mutations, current, applied.next, group)) {
      // A no-op is still "the next mutation" as far as the brep arm is
      // concerned, so the arm is consumed here too.
      this.consumeBrepArm(current)
      return okResult()
    }
    const gesture = this.findTransaction('gesture')
    if (gesture) {
      // A gesture frame lands live but records nothing; the commit banks one
      // entry keyed to the baseline.
      if (!gesture.firstMutation) gesture.firstMutation = mutations[0]
      this.landApplied(current, mutations, applied)
      this.reportDocChange(mutations, group, current, applied.next, unsettled)
      return okResult(this.createdIdsFor(mutations, current, applied.next))
    }
    const result = this.landMutations(mutations, current, applied)
    this.reportDocChange(mutations, group, current, applied.next, unsettled)
    return result
  }

  // Hand one durable apply to the journal sink with the docs as they stood
  // around it. Synchronous by construction: no solve can write back between
  // the apply and the sink's hash, which is the state a replay hashes too.
  private reportDocChange(mutations: Mutation[], group: boolean, before: PartDoc, after: PartDoc, unsettled: boolean): void {
    const journal = this.deps.journal
    if (!journal) return
    journal.onDocChange({
      docId: this.deps.docId ?? null,
      kind: group ? 'batch' : 'mutation',
      payload: group ? mutations : mutations[0],
      label: describeMutation(mutations[0]),
      beforeDoc: before,
      afterDoc: after,
      unsettled,
    })
  }

  // Whether a solve is still in flight as an apply lands. One worker, so
  // pending and running are the same slot; either means the live doc has not
  // received its write-back yet.
  private solveBusy(): boolean {
    const state = this.deps.solve.state()
    return state.pending || state.running
  }

  // The shared tail of both funnels, run once the mutations are known to
  // change the doc: the dirty flag, the solve-result prune and its stash, then
  // the transaction branch (swallow, preview escape, or push), then the doc
  // swap and the re-solve.
  private landMutations(mutations: Mutation[], current: PartDoc, applied: AppliedMutations): Result {
    // A mutation the color preview cannot produce while a preview is open is an
    // escape: the popover is non-modal, so a sketch edit mid-preview folds the
    // pending color into its own entry and then pushes normally below, instead
    // of being swallowed and destroyed by a later cancel. A group made entirely
    // of preview-scope mutations is a preview frame and stays swallowed.
    const inPreviewScope = mutations.every(m => PREVIEW_SCOPE.has(m.type))
    const preview = this.findTransaction('preview')
    if (preview && !inPreviewScope) {
      this.commitPreviewTransaction(preview, mutations[0])
    }
    // Re-read the stack after the escape: the commit above removed the
    // transaction, so the branches below see the world the mutation is
    // actually landing in.
    const edit = this.findTransaction('edit')
    if (edit?.suppressed) {
      // A suppressed session swallows every mutation: it owns the doc until
      // commit or cancel, and its aggregate entry reverts the work wholesale.
      // A swallowed part_style mutation is a real user change the session diff
      // cannot see (it strips part_style), so remember it.
      if (mutations.some(m => BODY_STYLE_MUTATION_TYPES.has(m.type))) {
        edit.styleTouched = true
      }
      // A swallow still fulfils the withhold's "next mutation" contract.
      this.consumeBrepArm(current)
    } else {
      const livePreview = this.findTransaction('preview')
      if (livePreview) {
        // A live top-level preview swallows only the part_style mutations it
        // produces; anything else escaped above. The touched flag is what lets
        // the commit gate tell a user color change from a part_style entry the
        // solve fabricated.
        livePreview.touched = true
        this.consumeBrepArm(current)
      } else {
        // The first mutation names the entry so the undo tooltip has a label;
        // redo round-trips it, so only the doc matters, never the list itself.
        this.applyWithholdOrPush(mutations[0], current)
      }
    }

    this.landApplied(current, mutations, applied)
    this.emit({ type: 'changed' })
    return okResult(this.createdIdsFor(mutations, current, applied.next))
  }

  // The doc swap and the solve request, shared by every path that lands a
  // mutation set (including a gesture frame).
  private landApplied(current: PartDoc, mutations: Mutation[], applied: AppliedMutations): void {
    const { next, restorable, nextSolveResults } = applied
    // Every doc edit funnels through here, so this is the one place that flags
    // the document as having changes not yet saved.
    this.dirtyOverride = true
    if (nextSolveResults !== this.deps.solveResults.get()) {
      this.deps.solveResults.set(nextSolveResults)
    }
    this.stashRestorable(current, restorable)
    this.deps.doc.set(next)
    this.requestSolve(next, mutations, restorable)
  }

  private runMutations(current: PartDoc, mutations: Mutation[]): AppliedMutations {
    const next = this.deps.cloneDoc(current)
    const handlers = mutationHandlers as Record<string, AnyHandler | undefined>
    let restorable: Record<string, SketchData> | null = null
    let nextSolveResults = this.deps.solveResults.get()
    for (const m of mutations) {
      const handler = handlers[m.type]
      if (import.meta.env.DEV && !handler) {
        console.error(`[DocSession] no handler for mutation type: ${m.type}`)
      }
      handler?.(next, m)
      // Content-removing edits invalidate the affected features' last solve;
      // prune it so stale geometry cannot linger while the re-solve is in
      // flight. Only whole-feature removals carry a restorable snapshot.
      const pruned = pruneSolveResults(m, nextSolveResults)
      nextSolveResults = pruned.next
      if (pruned.restorable) restorable = { ...(restorable ?? {}), ...pruned.restorable }
    }

    // The rollback bar is document content, but only a user-parked position
    // is: during an edit the bar is pinned just after the edited feature, which
    // is transient. Outside an edit the mirror runs so an append or delete can
    // never leave a stale position behind.
    const facts = this.deps.editorFacts()
    if (facts.editingFeatureId === null) {
      applySetRollback(next, facts.rollbackPosition)
    }
    return { next, restorable, nextSolveResults }
  }

  // The pre-sync guard the mirror comment promises: outside an edit, a
  // set_rollback payload that disagrees with the store means the store was
  // never synced and the dispatch would no-op while looking like a real edit.
  private unsyncedRollback(mutations: Mutation[]): boolean {
    const facts = this.deps.editorFacts()
    if (facts.editingFeatureId !== null) return false
    const rollback = mutations.find(m => m.type === 'set_rollback') as
      | Extract<Mutation, { type: 'set_rollback' }>
      | undefined
    return rollback !== undefined && facts.rollbackPosition !== rollback.position
  }

  private isNoOp(mutations: Mutation[], current: PartDoc, next: PartDoc, group: boolean): boolean {
    // The group funnel always compares the whole doc: a group can mix kinds
    // the O(touched) slice does not cover.
    if (group) return JSON.stringify(current) === JSON.stringify(next)
    const m = mutations[0]
    if (IDEMPOTENT_MUTATION[m.type]) {
      const slice = noOpSliceFor(m, current)
      // GUARD_BYPASS means the slice cannot represent the change (a body-style
      // mutation missing its bodyId), so the mutation always lands.
      return slice !== GUARD_BYPASS
        && JSON.stringify(slice) === JSON.stringify(noOpSliceFor(m, next))
    }
    if (m.type === 'add_constraint' || m.type === 'delete') {
      // These two are classified false because their real targets can span
      // features; their handlers can still leave the doc byte-identical, so
      // compare the whole doc.
      return JSON.stringify(current) === JSON.stringify(next)
    }
    return false
  }

  private createdIdsFor(mutations: Mutation[], before: PartDoc, after: PartDoc): string[] {
    return mutations.some(m => CREATING_MUTATION_TYPES.has(m.type))
      ? createdIdsBetween(before, after)
      : []
  }

  private requestSolve(doc: PartDoc, mutations: Mutation[], restorable: Record<string, SketchData> | null): void {
    let opts: SolveOptions
    if (mutations.length > 1) {
      opts = { _suppressFirstSolve: true }
    } else {
      const dragAnchor = mutations.length === 1 ? dragAnchorFor(mutations[0]) : undefined
      opts = { bypassCache: dragAnchor !== undefined, dragAnchor, _suppressFirstSolve: true }
    }
    if (restorable) opts._restoreSolveResults = restorable
    void this.deps.solve.request(doc, opts)
  }

  // ─── Undo / redo ───

  private move(direction: 'undo' | 'redo'): boolean {
    const committed = this.commitOpenWorkBeforeHistory()
    const current = this.deps.doc.get()
    const stackLength = direction === 'undo' ? this.history.undoLength() : this.history.redoLength()
    if (stackLength === 0 || !current) {
      // The one exception to a dead keystroke: a caller that just resolved open
      // work had that push clear this very branch, so the move is a no-op
      // BECAUSE of the work it consumed. The editor that work opened still has
      // to come down.
      if (committed) {
        this.history.clearSnapshot()
        this.dropAllTransactions()
      }
      return false
    }
    this.history.clearSnapshot()
    this.dropAllTransactions()
    const entry = direction === 'undo' ? this.history.undo(current) : this.history.redo(current)
    if (!entry) return false
    // The restored doc is no longer the saved content, so it counts unsaved
    // until the user saves again.
    this.dirtyOverride = true
    this.deps.doc.set(entry.doc)
    // A history move installs a whole doc no mutation chain produced, so the
    // journal's recorded suffix no longer leads to the live doc: restart it.
    this.deps.journal?.onDocReset()
    this.emit({ type: 'historyRestored', direction, entry })
    this.emit({ type: 'changed' })
    this.restoreAwareSolve(entry.doc)
    return true
  }

  // An undo or redo mid-edit first commits the open work as its own entry, so
  // the history move reverts (undo) or reaches (redo) exactly that work.
  // Returns true exactly when it pushed open work.
  private commitOpenWorkBeforeHistory(): boolean {
    let committed = false
    // A brep pick's projection is applied without an entry until its dimension
    // commits. Outside a suppressed session (whose aggregate already covers it)
    // it is open work like any other: bank it so the move reverts exactly the
    // projection.
    const brep = this.findTransaction('brep')
    const edit = this.findTransaction('edit')
    if (brep?.doc && edit?.suppressed !== true) {
      committed = this.bankBrepProjection(brep) || committed
    }
    const editNow = this.findTransaction('edit')
    if (editNow?.suppressed) {
      if (this.sessionWouldPush(editNow)) {
        this.commitEditTransaction(editNow)
        committed = true
      }
    } else {
      const preview = this.findTransaction('preview')
      if (preview && this.previewWouldPush(preview)) {
        this.commitPreviewTransaction(preview, PREVIEW_COMMIT_FALLBACK)
        committed = true
      }
    }
    return committed
  }

  private restoreAwareSolve(doc: PartDoc): void {
    const restore: Record<string, SketchData> = {}
    const entryIds = new Set((doc.features ?? []).map(f => f.id))
    for (const [featureId, snapshot] of Object.entries(this.restoreStash)) {
      if (entryIds.has(featureId)) restore[featureId] = snapshot
    }
    const restoreKeys = Object.keys(restore)
    void this.deps.solve.request(doc, restoreKeys.length > 0 ? { _restoreSolveResults: restore } : undefined)
  }

  // ─── Transaction internals ───

  private beginPreview(opts: BeginOptions): OpenedResult {
    if (this.findTransaction('preview')) {
      return this.fault('preview-already-open', 'preview refused: a preview is already open')
    }
    if (this.findTransaction('edit')) {
      return this.fault('preview-over-session', 'preview refused: an edit session owns the document')
    }
    const source = opts.baseline ?? this.deps.doc.get()
    if (!source) {
      return this.fault('no-document', 'preview refused: no document')
    }
    const txn: PreviewTransaction = {
      id: this.freshId(),
      kind: 'preview',
      baseline: this.deps.cloneDoc(source),
      touched: false,
      dirty: this.pinDirty(),
    }
    this.openTransaction(txn)
    return openedResult(txn.id)
  }

  private beginEdit(opts: BeginOptions): OpenedResult {
    const current = this.deps.doc.get()
    if (!current) {
      return this.fault('no-document', 'edit session refused: no document')
    }
    if (this.findTransaction('edit')) {
      return this.fault('edit-already-open', 'edit session refused: an edit session is already open')
    }
    // A preview open at session start is a defined edge, not an error: resolve
    // it FIRST, with its own entry, so the baseline below is taken after it
    // (color kept, with its own entry).
    const preview = this.findTransaction('preview')
    if (preview) {
      this.commitPreviewTransaction(preview, PREVIEW_COMMIT_FALLBACK)
    }
    const txn: EditTransaction = {
      id: this.freshId(),
      kind: 'edit',
      baseline: this.deps.cloneDoc(current),
      suppressed: opts.suppressed ?? false,
      styleTouched: false,
      dirty: this.pinDirty(),
    }
    this.openTransaction(txn)
    // The pre-session restore point; cancel restores it and commit drops it.
    this.history.saveSnapshot()
    return openedResult(txn.id)
  }

  private beginGesture(): OpenedResult {
    if (this.openTransactions.length > 0) {
      return this.fault('gesture-already-open', 'gesture refused: another transaction is open')
    }
    const current = this.deps.doc.get()
    if (!current) {
      return this.fault('no-document', 'gesture refused: no document')
    }
    const txn: GestureTransaction = {
      id: this.freshId(),
      kind: 'gesture',
      baseline: this.deps.cloneDoc(current),
      firstMutation: null,
      dirty: this.pinDirty(),
    }
    this.openTransaction(txn)
    return openedResult(txn.id)
  }

  private beginBrep(): OpenedResult {
    const existing = this.findTransaction('brep')
    if (existing) {
      // Re-arming for a later pick in the same gesture must not forget the doc
      // captured before the first one.
      existing.armed = true
      this.emit({ type: 'changed' })
      return openedResult(existing.id)
    }
    const txn: BrepTransaction = { id: this.freshId(), kind: 'brep', armed: true, doc: null }
    this.openTransaction(txn)
    return openedResult(txn.id)
  }

  private commitPreviewTransaction(txn: PreviewTransaction, handedMutation?: Mutation): Result {
    const current = this.deps.doc.get()
    if (current && this.previewWouldPush(txn)) {
      // The popover applies set_part_color no matter what was edited, so the
      // label is composed from the actual part_style diff; a preview whose
      // change was elsewhere keeps the mutation it was handed.
      // `txn.baseline` is already an independent throwaway clone, so the
      // snapshot push skips the redundant re-clone.
      const label = previewMutationFor(txn.baseline, current) ?? handedMutation ?? PREVIEW_COMMIT_FALLBACK
      this.history.pushSnapshot(describeMutation(label), txn.baseline, label)
    }
    this.removeTransaction(txn)
    this.emit({ type: 'changed' })
    return okResult()
  }

  private previewWouldPush(txn: PreviewTransaction): boolean {
    const current = this.deps.doc.get()
    if (!current) return false
    return docDiffersForSession(txn.baseline, current)
      || (txn.touched && previewMutationFor(txn.baseline, current) !== null)
  }

  private commitEditTransaction(txn: EditTransaction): Result {
    const push = this.sessionWouldPush(txn)
    this.removeTransaction(txn)
    if (push) {
      // The editor facts still hold the edited feature here (the caller
      // commits before its exit cleanup clears it), so the label names it.
      const featureId = this.deps.editorFacts().editingFeatureId ?? ''
      const mutation: Mutation = { type: 'edit_session', featureId }
      this.history.pushSnapshot(describeMutation(mutation), txn.baseline, mutation)
    } else if (txn.suppressed) {
      // A suppressed session that netted to zero pushes no entry, but each of
      // its mutations set the dirty flag on the way through. The committed doc
      // equals the baseline modulo the solve-written fields, so reconcile the
      // flag the same way the cancel twin does: there is nothing left to save.
      this.reconcile(txn.dirty, false, txn.baseline)
    }
    // No preview can be open here: the stack never holds a session and a
    // preview together, so there is no second entry to fold in after the
    // aggregate.
    this.history.clearSnapshot()
    this.emit({ type: 'changed' })
    return okResult()
  }

  // Whether committing the open suppressed (feature) session would push its
  // aggregate entry. A sketch session already left one undo entry per action;
  // an aggregate on top would double-record the same work, so only a
  // suppressed session needs the collapse into one step.
  private sessionWouldPush(txn: EditTransaction): boolean {
    const current = this.deps.doc.get()
    if (!txn.suppressed || !current) return false
    return docDiffersForSession(txn.baseline, current) || txn.styleTouched
  }

  private commitGestureTransaction(txn: GestureTransaction): Result {
    const current = this.deps.doc.get()
    const changed = current !== null && JSON.stringify(current) !== JSON.stringify(txn.baseline)
    this.removeTransaction(txn)
    if (changed && txn.firstMutation) {
      this.history.pushSnapshot(describeMutation(txn.firstMutation), txn.baseline, txn.firstMutation)
    }
    this.emit({ type: 'changed' })
    return okResult()
  }

  private commitBrepTransaction(txn: BrepTransaction): Result {
    this.bankBrepProjection(txn)
    return okResult()
  }

  // Banks a pending projection (an edge projected by a brep dimension pick) as
  // its own entry, keyed to the pre-pick doc, so a history move reverts exactly
  // the projection. An armed-but-unconsumed pick has nothing to bank.
  private bankBrepProjection(txn: BrepTransaction): boolean {
    if (!txn.doc) return false
    const mutation: Mutation = { type: 'preview_commit', description: 'add projected edge' }
    this.history.push(describeMutation(mutation), txn.doc, mutation)
    this.removeTransaction(txn)
    this.emit({ type: 'changed' })
    return true
  }

  // A cancel that rewinds to the baseline: preview and gesture. Doc rewind and
  // the dirty reconcile are one unit; the re-solve below owns the viewport.
  private cancelRestoreTransaction(txn: PreviewTransaction | GestureTransaction): Result {
    const current = this.deps.doc.get()
    if (current) {
      // The write-back installs a fresh doc object on every solve, so object
      // identity says nothing here and the rewind is judged on content.
      const rewound = JSON.stringify(txn.baseline) !== JSON.stringify(current)
      this.deps.doc.set(txn.baseline)
      // A rewind discards the mutations recorded since the transaction opened;
      // the journal restarts from the doc the user is left with.
      if (rewound) this.deps.journal?.onDocReset()
      this.reconcile(txn.dirty, rewound, txn.baseline)
      void this.deps.solve.request(txn.baseline)
    }
    this.removeTransaction(txn)
    this.emit({ type: 'changed' })
    return okResult()
  }

  private cancelEditTransaction(txn: EditTransaction): Result {
    const current = this.deps.doc.get()
    // Doc rewind and stack restore are ONE unit (the pairing contract): the
    // stacks only describe the pre-session doc again once the live doc has
    // been rewound to it. The baseline is restored even from a null live doc,
    // exactly as the old engine did (its JSON compare read null as rewound):
    // the session baseline is the doc the cancel promised.
    const rewound = JSON.stringify(txn.baseline) !== JSON.stringify(current)
    this.deps.doc.set(txn.baseline)
    this.history.restoreSnapshot()
    // The session's mutations are gone with the rewind, so the journal's
    // recorded suffix no longer leads here: restart it from the baseline.
    if (rewound) this.deps.journal?.onDocReset()
    this.reconcile(txn.dirty, rewound, txn.baseline)
    this.removeTransaction(txn)
    // Rewinding the doc is this path's own doing, so it owns the re-solve too;
    // an exit with no session still refreshes the viewport.
    const doc = this.deps.doc.get()
    if (doc) void this.deps.solve.request(doc)
    this.emit({ type: 'changed' })
    return okResult()
  }

  // Mutations that change nothing still count as "the next mutation" for the
  // brep arm: it applies the projection without an entry, so consuming the arm
  // keeps it from outliving the gesture it covers.
  private consumeBrepArm(fallback: PartDoc): void {
    const brep = this.findTransaction('brep')
    if (brep?.armed) {
      brep.armed = false
      brep.doc = brep.doc ?? fallback
    }
  }

  // The shared "does this mutation earn an undo entry?" branch for both
  // funnels. `preDoc` is the doc the entry restores when no withhold is
  // pending; the withhold, when pending, overrides it with the pre-gesture doc.
  private applyWithholdOrPush(mutation: Mutation, preDoc: PartDoc): void {
    const brep = this.findTransaction('brep')
    if (brep?.armed) {
      // The projection, or the compensating delete of a cancelled pick: apply
      // without an entry and remember the pre-gesture doc so the commit that
      // follows can restore past it. A later pick in the same gesture keeps the
      // EARLIEST captured doc, or the first pick's projection would be orphaned
      // by the commit's undo.
      brep.armed = false
      brep.doc = brep.doc ?? preDoc
      return
    }
    if (brep?.doc && mutation.type === 'add_constraint' && isDimensionKind(mutation.kind)) {
      // The brep dimension commit: one entry restoring the pre-projection doc,
      // so undo removes the dimension and its projection in a single step. The
      // kind gate stops a geometric add_constraint (e.g. a coincident applied
      // mid-gesture) from being mistaken for the commit.
      const withheldDoc = brep.doc
      this.removeTransaction(brep)
      this.history.push(describeMutation(mutation), withheldDoc, mutation)
      return
    }
    this.history.push(describeMutation(mutation), preDoc, mutation)
    // A non-dimension mutation landing mid-gesture (a "steal", e.g. a rename or
    // a delete) clears the withhold: the steal's entry owns the projection from
    // here, so it can never be orphaned.
    if (brep) this.removeTransaction(brep)
  }

  // ─── Solve-result retention ───

  private stashRestorable(current: PartDoc, restorable: Record<string, SketchData> | null): void {
    if (!restorable) return
    for (const featureId of Object.keys(restorable)) {
      const kind = featureKindOf(current, featureId)
      if (kind && NO_FALLBACK_BREP_KINDS.has(kind)) {
        this.stashPrunedResult(featureId, restorable[featureId])
      }
    }
  }

  // Capped like the undo stack: beyond MAX_UNDO_DEPTH the oldest entry falls
  // out and the feature renders via the normal re-solve after a successful
  // undo.
  private stashPrunedResult(featureId: string, snapshot: SketchData): void {
    const stash = this.restoreStash
    const keys = Object.keys(stash)
    if (!(featureId in stash) && keys.length >= MAX_UNDO_DEPTH) delete stash[keys[0]]
    stash[featureId] = snapshot
  }

  // ─── Dirty internals ───

  private reconcile(pin: DirtyPin, rewound: boolean, restored: PartDoc): void {
    this.dirtyOverride = reconcileDirty(
      this.deps.dirtyFacts(),
      pin,
      rewound,
      () => stringifyYaml(restored),
    )
  }

  // ─── Small helpers ───

  private openTransaction(txn: Transaction): void {
    this.openTransactions.push(txn)
    this.emit({ type: 'changed' })
  }

  private findTransaction<K extends TransactionKind>(kind: K): Extract<Transaction, { kind: K }> | null {
    return (this.openTransactions.find(txn => txn.kind === kind) as Extract<Transaction, { kind: K }> | undefined) ?? null
  }

  private findById(id: TransactionId): Transaction | null {
    return this.openTransactions.find(txn => txn.id === id) ?? null
  }

  private removeTransaction(txn: Transaction): void {
    const index = this.openTransactions.indexOf(txn)
    if (index >= 0) this.openTransactions.splice(index, 1)
  }

  private dropAllTransactions(): void {
    this.openTransactions = []
    // Emitted unconditionally on the move path, exactly as the old engine's
    // teardown ran unconditionally: a move tears the editor down even when
    // nothing was open, so the page callback sees every move.
    this.emit({ type: 'transactionsDropped' })
  }

  private freshId(): TransactionId {
    return `txn-${++this.idCounter}`
  }

  private emit(event: SessionEvent): void {
    this.versionCounter++
    for (const listener of [...this.listeners]) listener(event)
  }

  private fault(code: SessionErrorCode, message: string): SessionFailure {
    this.diagnosticsLog.push({ code, message })
    return errorResult(code, message)
  }
}

export function createDocSession(deps: DocSessionDeps): DocSession {
  return new DocSession(deps)
}
