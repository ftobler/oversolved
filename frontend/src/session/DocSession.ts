import { stringify as stringifyYaml } from 'yaml'
import type { PartDoc, Mutation, PartFeature, SketchData } from '@/types/cad'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import type { MutationContext } from '@/hooks/mutationDispatch'
import type { FaceBoundaryLookup } from '@/kernel/features/faceBoundary'
import { IDEMPOTENT_MUTATION } from '@/hooks/mutationIdempotence'
import { describeMutation } from '@/utils/core/mutationDescriptions'
import { applySetRollback, setIdScope } from '@/utils/yamlMutations'
import { pruneSolveResults } from '@/utils/yamlMutations/solveResults'
import { threePointArcVertexKeys } from '@/utils/yamlMutations/sketchSugar'
import { BUILTIN_FEATURE_IDS } from '@/utils/builtins'
import { isDimensionKind } from '@/registry/constraintRegistry'
import { MAX_UNDO_DEPTH } from '@/config/undoConfig'
import { History, type HistoryEntry } from '@/session/History'
import { unresolvedSelectionAid } from '@/drive/selectionAids'
import { PART_STYLE_MUTATION_TYPES, GUARD_BYPASS, noOpSliceFor } from '@/session/noOpGuard'
import { CREATING_MUTATION_TYPES } from '@/types/mutationKinds'
import { reconcileDirty, type DirtyFacts, type DirtyPin } from '@/session/dirty'
import {
  errorResult,
  noOpResult,
  okResult,
  openedResult,
  type OpenedResult,
  type Result,
  type SessionErrorCode,
  type SessionFailure,
  type SessionSuccess,
} from '@/session/result'
import type { SolveOptions, SolveOutcome, SolveScheduler, SolveSchedulerState } from '@/session/SolveScheduler'
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
  getParts?: () => unknown
  // A face projection's member ids are derived at add time from the face's
  // current boundary. The host injects the lookup (UI: the body registry;
  // headless: the last solved bodies), keeping the session free of geometry.
  projectionBoundary?: FaceBoundaryLookup
  // A projection's body source resolves only in the settled solve; the headless
  // host answers from its last build's repository. Absent in the editor and the
  // unit suites, where the document check and the pick's own scene are the gate.
  projectionResolves?: MutationContext['projectionResolves']
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
export type TransactionKind = 'preview' | 'edit' | 'placement'

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
  parts?: unknown
}

// The events L1 emits. `historyRestored` is an undo/redo move and carries the
// entry the adapter needs for its editor writes; `inSession` says the move
// stayed inside an open unsuppressed session (the editor keeps its feature, and
// the adapter only sweeps the transients the restored doc invalidated).
// `transactionsDropped` is the editor teardown a move (or a blocked move that
// just resolved open work) performs; `changed` is every other observable state
// change, so a useSyncExternalStore adapter can re-render.
export type SessionEvent =
  | {
    type: 'historyRestored'
    direction: 'undo' | 'redo'
    entry: HistoryEntry<PartDoc, Mutation>
    inSession: boolean
  }
  | { type: 'transactionsDropped' }
  | { type: 'changed' }

// The store's rollback bar after a restore, clamped to the restored feature
// list exactly as Part.tsx clamps a loaded doc. Exported pure so the UI
// adapter derives it from an event doc without importing the session.
export function clampRollbackPosition(doc: PartDoc): number {
  const featureCount = doc.features?.length ?? 0
  return Math.min(Math.max(doc.rollback ?? featureCount, 0), featureCount)
}

/**
 * Move an already-appended feature into the slot its add named. Add handlers
 * keep appending, so the flat-log shape stays independent of where the row
 * goes; this is the one place the insertion semantics live, which is what makes
 * a recorded add and its replay agree. A non-integer index is ignored rather
 * than truncated (nothing valid produces one), and an out-of-range index clamps
 * to the neighbours it could have named.
 */
export function insertFeatureAt(doc: PartDoc, featureId: string, insertAt: number): boolean {
  const features = doc.features
  if (!features || !Number.isInteger(insertAt)) return false
  const from = features.findIndex(f => f.id === featureId)
  if (from < 0) return false
  // The bar cannot sit above the built-ins, so an add cannot either. A doc may
  // legitimately have no built-ins (fixtures, hand-authored logs): there the
  // first non-builtin is position 0 and nothing is reserved.
  const firstUserIndex = features.findIndex(f => !BUILTIN_FEATURE_IDS.has(f.id))
  const floor = firstUserIndex < 0 ? features.length : firstUserIndex
  const to = Math.max(floor, Math.min(insertAt, features.length - 1))
  if (from !== to) {
    const [feature] = features.splice(from, 1)
    features.splice(to, 0, feature)
  }
  // True even when the append position already is the target slot: the row
  // exists, it just did not have to move.
  return true
}

// The bar position just past the last inserted row, or undefined when the
// apply inserted nothing (the editor facts then decide). A refused add is not
// in the list, so it cannot move the bar on its own.
function rollbackAfterInsertions(doc: PartDoc, insertedIds: readonly string[]): number | undefined {
  const features = doc.features ?? []
  let last = -1
  for (const id of insertedIds) last = Math.max(last, features.findIndex(f => f.id === id))
  return last < 0 ? undefined : last + 1
}

// The label a preview commit falls back to when no caller mutation is handed
// in and the part_style diff is empty.
const PREVIEW_COMMIT_FALLBACK: Mutation = { type: 'preview_commit', description: 'apply previewed color' }

// A placement that only materialized a brep projection (no dimension landed)
// labels its commit like the projection it banked before placements existed.
const PLACEMENT_COMMIT_FALLBACK: Mutation = { type: 'preview_commit', description: 'add projected edge' }

// The sketch target a projection mutation names in a scratch delete. A face
// projection has no entity row, but the planner still mints a phantom entity id
// and a replaced pick's delete names that same phantom; tracking it keeps the
// harmless cleanup inside the gesture. Returning null for a face source would
// resolve the placement on that delete instead.
function projectionTarget(m: Extract<Mutation, { type: 'add_projected_entity' }>): string | null {
  return m.entityId === undefined ? null : `entity:${m.featureId}:${m.entityId}`
}

// The mutations that can add a doc-addressable id (a feature, an entity, a
// constraint). The id set is only diffed for dispatches that contain one, so
// the drag path pays nothing for a field it can never fill. The list itself
// lives in types/mutationKinds because the headless step outcome needs the same
// creator set to tell a refused creator from a legitimate no-op edit.
// The helpers whose reply lists entities and counts constraints instead of
// naming every constraint id.
const COMPACT_CREATED_TYPES = new Set<Mutation['type']>([
  'add_rect', 'add_center_rect', 'add_ngon',
  // The copy/trim sugar carries a constraint per copy or corner, and a paste
  // carries the clip's whole constraint set; the reply keeps the entity order
  // and collapses those to a count like a rect.
  'mirror_entities', 'pattern_entities', 'paste_sketch_entities', 'fillet_corners',
  // A split names its new pieces and counts the joint ties it authored.
  'split_entity',
])

function contentIds(doc: PartDoc): Set<string> {
  const ids = new Set<string>()
  for (const feature of doc.features ?? []) {
    ids.add(feature.id)
    for (const id of childIds(feature)) ids.add(id)
  }
  return ids
}

// Entity and constraint ids are scoped to their sketch, so the created-id diff
// below must compare within a feature: an id a new entity shares with an entity
// in another sketch (the collision an unseeded source can mint) is still that
// sketch's new entity and must be reported.
function childIds(feature: PartFeature): Set<string> {
  const ids = new Set<string>()
  if (feature.kind !== 'sketch') return ids
  for (const entity of feature.entities ?? []) ids.add(entity.id)
  for (const constraint of feature.constraints ?? []) ids.add(constraint.id)
  return ids
}

/** The ids of the fixed constraints a freeze added. The plan's reply contract
 *  names those, not the member rows a face freeze also writes, so a freeze step
 *  reports the pins that hold the geometry rather than the baked rows. */
function createdFixedConstraintIds(before: PartDoc, after: PartDoc): string[] {
  const out: string[] = []
  for (const feature of after.features ?? []) {
    if (feature.kind !== 'sketch') continue
    const beforeFeature = before.features?.find(candidate => candidate.id === feature.id)
    const held = new Set(
      beforeFeature?.kind === 'sketch'
        ? (beforeFeature.constraints ?? []).map(constraint => constraint.id)
        : [],
    )
    for (const constraint of feature.constraints ?? []) {
      if (constraint.kind === 'fixed' && !held.has(constraint.id)) out.push(constraint.id)
    }
  }
  return out
}

function createdIdsBetween(before: PartDoc, after: PartDoc): string[] {
  const beforeIds = contentIds(before)
  const beforeChildren = new Map<string, Set<string>>()
  for (const feature of before.features ?? []) beforeChildren.set(feature.id, childIds(feature))
  const created: string[] = []
  for (const feature of after.features ?? []) {
    if (!beforeIds.has(feature.id)) created.push(feature.id)
    if (feature.kind !== 'sketch') continue
    const heldBefore = beforeChildren.get(feature.id)
    for (const entity of feature.entities ?? []) {
      if (!heldBefore?.has(entity.id)) created.push(entity.id)
    }
    for (const constraint of feature.constraints ?? []) {
      if (!heldBefore?.has(constraint.id)) created.push(constraint.id)
    }
  }
  return created
}

/** The id of a Group constraint this apply created, if any. An import_dxf
 *  authors exactly one over its rows; the reply names it beside the entity
 *  count instead of leaving the caller to read the document back. */
function createdGroupId(before: PartDoc, after: PartDoc): string | undefined {
  for (const feature of after.features ?? []) {
    if (feature.kind !== 'sketch') continue
    const beforeFeature = before.features?.find(f => f.id === feature.id)
    const beforeIds = new Set(
      beforeFeature?.kind === 'sketch' ? (beforeFeature.constraints ?? []).map(c => c.id) : [],
    )
    for (const constraint of feature.constraints ?? []) {
      if (constraint.kind === 'group' && !beforeIds.has(constraint.id)) return constraint.id
    }
  }
  return undefined
}

/**
 * The dimensional constraints a step replaced, old id to new id. Only a compact
 * sugar step can do this today: fillet_corners consumes the `length` a trimmed
 * side no longer satisfies and authors the dimension that keeps the size. The
 * reply names both ids because the old one is gone from the document and the
 * caller may need to carry a label or a selection across the step.
 */
function replacedDimensions(before: PartDoc, after: PartDoc): Array<{ from: string; to: string }> | undefined {
  const pairs: Array<{ from: string; to: string }> = []
  for (const feature of after.features ?? []) {
    if (feature.kind !== 'sketch') continue
    const beforeFeature = before.features?.find(f => f.id === feature.id)
    if (beforeFeature?.kind !== 'sketch') continue
    const afterConstraints = feature.constraints ?? []
    const beforeConstraints = beforeFeature.constraints ?? []
    const afterIds = new Set(afterConstraints.map(c => c.id))
    const beforeIds = new Set(beforeConstraints.map(c => c.id))
    const removed = beforeConstraints.filter(
      c => c.kind === 'length' && typeof c.value === 'number' && !afterIds.has(c.id),
    )
    const added = afterConstraints.filter(
      c => isDimensionKind(c.kind) && typeof c.value === 'number' && !beforeIds.has(c.id),
    )
    const used = new Set<number>()
    for (const old of removed) {
      // The overall-size rewrite keeps the value on another kind; the
      // straight-run rewrite keeps the kind and changes the value.
      let index = added.findIndex((c, i) =>
        !used.has(i) && c.kind !== 'length' && Math.abs(c.value! - old.value!) < 1e-9)
      if (index < 0) index = added.findIndex((c, i) => !used.has(i) && c.kind === 'length')
      if (index < 0) continue
      used.add(index)
      pairs.push({ from: old.id, to: added[index].id })
    }
  }
  return pairs.length > 0 ? pairs : undefined
}

function dragAnchorFor(m: Mutation): { featureId: string; entityId: string } | undefined {
  // A group move names several members; `drag_anchor` only has to make the
  // session bypass the checkpoint cache, so any member's id works and only its
  // presence matters (the transient field is ignored by the byte solver path).
  if (m.type === 'move_sketch_group') {
    const first = m.members[0]
    return first === undefined ? undefined : { featureId: m.featureId, entityId: first.entityId }
  }
  return m.type === 'move_vertex' || m.type === 'move_vertex_with_constraint'
    || m.type === 'move_entity' || m.type === 'resize_circle'
    ? { featureId: m.featureId, entityId: m.entityId }
    : undefined
}

type AnyHandler = (
  doc: PartDoc,
  m: Mutation,
  ctx?: MutationContext,
) => Mutation | void

// The result of running a mutation set on one clone, with the pruned solve
// results and the whole-feature snapshots a failing re-solve can restore.
interface AppliedMutations {
  next: PartDoc
  restorable: Record<string, SketchData> | null
  nextSolveResults: Record<string, SketchData>
  /** The mutations as journaled: an applier may hand back an enriched copy (a
   *  face projection records the member ids it derived), which replays without
   *  a live solve. The caller's mutation objects are never edited. */
  mutations: Mutation[]
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
  // The undo depth at session begin, taken after any preview resolution pushed
  // its own entry. Entries below the floor belong to the document before the
  // session, so an in-session undo stops there. A capped push trims the bottom
  // of the stack, and the floor follows the trim down.
  floor: number
  // The redo depth at session begin: entries the pre-session timeline left
  // behind, which an in-session redo must never reach. The first push inside
  // the session clears the redo branch, so it drops to zero there.
  foreignRedo: number
}

// The dimension-placement gesture. A brep pick projects an edge into the sketch
// and the placement click inserts the dimension that measures it; both are one
// gesture from the user's point of view, so neither records an entry until the
// editor commits. `baseline` is the doc the gesture started from (captured at
// begin), so cancel restores it with nothing on the undo stack, and commit
// banks exactly one entry from it to the live doc. `mutation` is the dimension
// add, kept to label that entry; a projection-only placement labels the
// projection instead. `constraintIds` are the ids the insert minted, so the
// editor's follow-up value/sign edit stays inside the gesture while any other
// constraint's edit resolves it first.
interface PlacementTransaction extends TransactionBase {
  kind: 'placement'
  baseline: PartDoc
  dirty: DirtyPin
  mutation: Mutation | null
  constraintIds: Set<string>
  // The projected entity targets this gesture materialized (`entity:<fid>:<eid>`).
  // A scratch delete is only part of the gesture when every one of its targets
  // is in here; a Delete of an ordinary selected entity is a steal.
  projectionTargets: Set<string>
}

type Transaction = PreviewTransaction | EditTransaction | PlacementTransaction

// The framework-free L1 session: it owns the history, the transaction stack,
// the dirty policy and solve scheduling; every doc write goes through execute,
// executeGroup, a transaction boundary or undo/redo. It imports no React and no
// store, so it runs headless in node; the UI adapter mirrors its state into
// React and the stores.
export class DocSession {
  private readonly deps: DocSessionDeps
  private readonly cloneDoc: (doc: PartDoc) => PartDoc
  private readonly history: History<PartDoc, Mutation>
  private readonly listeners = new Set<(event: SessionEvent) => void>()
  private readonly diagnosticsLog: SessionDiagnostic[] = []
  // The stack of open transactions, oldest first. Preview and edit are
  // mutually exclusive by begin's rules; a placement nests inside either (a
  // sketch edit is unsuppressed, and its dimension gesture records no entry of
  // its own until the editor commits).
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
    // Capture the injected cloner and call it free. DocSession invokes it
    // directly in runMutations and at transaction begin as well as through
    // History, so guarding only History would leave those calls exposed if a
    // native cloner is ever injected. The production dep is cloneDocForUndo (a
    // plain function), but the same rule must hold for every owner.
    const cloneDoc = deps.cloneDoc
    this.cloneDoc = doc => cloneDoc(doc)
    this.history = new History({ cloneDoc: this.cloneDoc, cap: MAX_UNDO_DEPTH })
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

  // Whether a move would do anything, from the same floor rule move() applies.
  // The command table greys Undo/Redo from this, so a sketch standing on its
  // first entry does not offer a keystroke that resolves to nothing, and a redo
  // branch made entirely of pre-session entries reads as unavailable too.
  canUndo(): boolean {
    return this.moveAvailable('undo')
  }

  canRedo(): boolean {
    return this.moveAvailable('redo')
  }

  idle(): Promise<void> {
    return this.deps.solve.idle()
  }

  // Every re-solve outside a mutation rides this: a document load, an edit
  // enter/exit, Rebuild, Clear cache. Routing them all through the scheduler is
  // what keeps pending/idle and inspect().solve honest, so a caller waiting on
  // idle() cannot be released mid-solve. Null means no document is open.
  requestSolve(opts?: SolveOptions): Promise<SolveOutcome> | null {
    const doc = this.deps.doc.get()
    if (!doc) return null
    return this.deps.solve.request(doc, opts)
  }

  // A solve of the current doc with no edit semantics: the adapter's session
  // exit paths (a cancel with no open session) use it to refresh the viewport.
  refreshSolve(): void {
    void this.requestSolve()
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
    this.pushHistory(label, doc, meta, false)
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
      case 'placement': return this.beginPlacement()
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
      case 'placement': return this.commitPlacementTransaction(txn)
    }
  }

  cancel(id: TransactionId): Result {
    const txn = this.findById(id)
    if (!txn) {
      return this.fault('unknown-transaction', `no open transaction with id '${id}'`)
    }
    switch (txn.kind) {
      case 'preview': return this.cancelPreviewTransaction(txn)
      case 'edit': return this.cancelEditTransaction(txn)
      case 'placement': return this.cancelPlacementTransaction(txn)
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
    const parts = this.deps.getParts?.()
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
      ...(parts !== undefined && { parts }),
    }
  }

  // ─── Mutation funnels ───

  private apply(mutations: Mutation[], group: boolean): Result {
    const current = this.deps.doc.get()
    if (!current) {
      return this.fault('no-document', 'execute called with no document')
    }
    // The union makes a missing handler unreachable inside the app, but the
    // drive surface casts untyped JSON to Mutation. Refuse before any clone,
    // journal entry or history push, in every build: a missing handler is a
    // bug wherever it appears, never a silent no-op.
    const handlers = mutationHandlers as Record<string, AnyHandler | undefined>
    for (const mutation of mutations) {
      // hasOwn, not a truthy lookup: 'constructor' and '__proto__' resolve
      // through Object.prototype and would otherwise pass as handlers.
      if (!Object.hasOwn(handlers, mutation.type)) {
        return this.fault('unknown-mutation', `no handler for mutation type '${mutation.type}'`)
      }
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
    const appliedMutations = applied.mutations
    if (this.isNoOp(appliedMutations, current, applied.next, group)) {
      // The result says so explicitly: a headless step has to report a refused
      // creator instead of the ok the UI wants (a refused add must record no
      // undo entry). A placement stays open: its gesture's next mutation may
      // still land.
      return noOpResult()
    }
    const result = this.landMutations(appliedMutations, current, applied)
    this.reportDocChange(appliedMutations, group, current, applied.next, unsettled)
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
    // A placement resolves before the ordinary push. Its own gesture mutations
    // (the projection, a scratch delete, the insert and the editor's edit of
    // the inserted constraint) are withheld; anything else commits the placement
    // first, so half a gesture can never be left open behind an unrelated edit.
    const created = this.createdIdsFor(mutations, current, applied.next)
    const placement = this.findTransaction('placement')
    const placementScope = placement !== null && this.placementSwallows(placement, mutations)
    if (placement && !placementScope) {
      this.commitPlacementTransaction(placement)
    }
    if (placementScope) {
      this.recordPlacementMutations(placement, mutations, created.ok ? created.createdIds : [])
    }
    // Re-read the stack after the escapes: the commits above removed their
    // transactions, so the branches below see the world the mutation is
    // actually landing in.
    const edit = this.findTransaction('edit')
    if (edit?.suppressed) {
      // A suppressed session swallows every mutation: it owns the doc until
      // commit or cancel, and its aggregate entry reverts the work wholesale.
      // A swallowed part_style mutation is a real user change the session diff
      // cannot see (it strips part_style), so remember it.
      if (mutations.some(m => PART_STYLE_MUTATION_TYPES.has(m.type))) {
        edit.styleTouched = true
      }
    } else {
      const livePreview = this.findTransaction('preview')
      if (livePreview) {
        // A live top-level preview swallows only the part_style mutations it
        // produces; anything else escaped above. The touched flag is what lets
        // the commit gate tell a user color change from a part_style entry the
        // solve fabricated.
        livePreview.touched = true
      } else if (!placementScope) {
        // The first mutation names the entry so the undo tooltip has a label;
        // redo round-trips it, so only the doc matters, never the list itself.
        this.pushHistory(describeMutation(mutations[0]), current, mutations[0], false)
      }
    }

    this.landApplied(current, mutations, applied)
    this.emit({ type: 'changed' })
    return created
  }

  // The doc swap and the solve request, shared by every path that lands a
  // mutation set.
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
    this.solveAfterMutation(next, mutations, restorable)
  }

  private runMutations(current: PartDoc, mutations: Mutation[]): AppliedMutations {
    const next = this.cloneDoc(current)
    const handlers = mutationHandlers as Record<string, AnyHandler | undefined>
    // A copy: an applier that enriches its mutation (a face projection's derived
    // member ids) replaces the entry here, and the journal records the enriched
    // form without editing the caller's object.
    const appliedMutations = [...mutations]
    let restorable: Record<string, SketchData> | null = null
    let nextSolveResults = this.deps.solveResults.get()
    // The features this apply inserted. The bar lands just past the last one.
    const insertedIds: string[] = []
    let attemptedInsertion = false
    // A minted id must not duplicate one the document already holds, or a
    // document-wide lookup (delete, createdIds) conflates the two. The scope is
    // the starting document's ids plus every id this apply mints; a source that
    // restarts at a recorded position (replay, a per-document seed) draws past a
    // collision instead of handing it out, and the same draws happen on replay
    // because the starting document is the same.
    const outerScope = setIdScope(contentIds(current))
    try {
      for (let index = 0; index < appliedMutations.length; index++) {
        const m = appliedMutations[index]
        const handler = Object.hasOwn(handlers, m.type) ? handlers[m.type] : undefined
        // Every covered pick field is resolved by the headless drive before the
        // session, and the value rules refuse one on the bridge. A selector that
        // arrives here came through an internal caller, so fail loudly rather
        // than let an applier store an authoring aid in the document.
        const unresolvedPick = unresolvedSelectionAid(m)
        if (unresolvedPick !== null) {
          throw new Error(
            `a {selector} pick reached ${unresolvedPick} unresolved; the drive resolves it before the step runs`,
          )
        }
        // A feature add may carry the rollback bar's slot. The handler appends it
        // like every other add, then the row moves into place. Detecting the
        // creation (the id was absent before the handler) keeps this keyed on the
        // document rather than a hand-maintained list of add kinds; a mutation
        // that edits an existing feature and happens to carry the field moves
        // nothing. Check the slot first so the drag path never pays for a scan.
        const insertAt = 'insertAt' in m ? m.insertAt : undefined
        if (insertAt !== undefined) attemptedInsertion = true
        const addedId = insertAt !== undefined && 'featureId' in m && !next.features?.some(f => f.id === m.featureId)
          ? m.featureId
          : null
        const enriched = handler?.(next, m, {
          projectionBoundary: this.deps.projectionBoundary,
          projectionResolves: this.deps.projectionResolves,
        })
        if (enriched !== undefined) appliedMutations[index] = enriched
        if (addedId !== null && insertAt !== undefined && insertFeatureAt(next, addedId, insertAt)) {
          insertedIds.push(addedId)
        }
        // Content-removing edits invalidate the affected features' last solve;
        // prune it so stale geometry cannot linger while the re-solve is in
        // flight. Only whole-feature removals carry a restorable snapshot.
        const pruned = pruneSolveResults(m, nextSolveResults)
        nextSolveResults = pruned.next
        if (pruned.restorable) restorable = { ...(restorable ?? {}), ...pruned.restorable }
      }
    } finally {
      setIdScope(outerScope)
    }

    // The rollback bar is document content, but only a user-parked position
    // is: during an edit the bar is pinned just after the edited feature, which
    // is transient. Outside an edit the mirror runs so an append or delete can
    // never leave a stale position behind.
    //
    // An insertion derives the bar from the rows it actually added, not only
    // from the editor facts: the mutation payload is then self-describing, so a
    // journal replay (whose editor facts are empty) writes the same position
    // the recording did. The added rows are located after every mutation so a
    // group that deletes earlier features cannot leave the bar one row off.
    // A refused add added no row: the store may have staged a position for it,
    // so keep the doc's existing park instead of moving the bar for nothing.
    const facts = this.deps.editorFacts()
    if (facts.editingFeatureId === null) {
      if (insertedIds.length > 0) {
        applySetRollback(next, rollbackAfterInsertions(next, insertedIds) ?? facts.rollbackPosition)
      } else if (attemptedInsertion) {
        applySetRollback(next, current.rollback ?? null)
      } else {
        applySetRollback(next, facts.rollbackPosition)
      }
    }
    return { next, restorable, nextSolveResults, mutations: appliedMutations }
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
    if (m.type === 'delete' || CREATING_MUTATION_TYPES.has(m.type)) {
      // These are classified false because their real targets can span
      // features; their handlers can still leave the doc byte-identical, so
      // compare the whole doc. A create handler that refuses a pick (a
      // duplicate projection, an unrecognizable midpoint) writes nothing, and
      // the noOp result is what tells a headless step that was a refusal.
      return JSON.stringify(current) === JSON.stringify(next)
    }
    return false
  }

  private createdIdsFor(mutations: Mutation[], before: PartDoc, after: PartDoc): SessionSuccess {
    // A freeze's reply names the fixed constraints that now pin the geometry.
    // A face freeze also writes member entity rows; those keep derived ids the
    // caller already knows, and reporting them would bury the pins.
    if (mutations.length > 0 && mutations.every(m => m.type === 'freeze_projection')) {
      return okResult(createdFixedConstraintIds(before, after))
    }
    if (!mutations.some(m => CREATING_MUTATION_TYPES.has(m.type))) return okResult()
    const created = createdIdsBetween(before, after)
    // An import's group is a constraint, not an imported entity: the reply
    // names it separately so `createdCount` keeps meaning rows. It is in
    // `created` (a new sketch child), so drop it from the id list.
    const groupId = mutations.some(m => m.type === 'import_dxf')
      ? createdGroupId(before, after)
      : undefined
    const entityIds = groupId === undefined ? created : created.filter(id => id !== groupId)
    const withGroup = (result: SessionSuccess): SessionSuccess =>
      groupId === undefined ? result : { ...result, groupId }
    const vertexKeys = mutations.length === 1 && mutations[0].type === 'add_three_point_arc'
      ? threePointArcVertexKeys(mutations[0].start, mutations[0].through, mutations[0].end) ?? undefined
      : undefined
    if (!mutations.every(m => COMPACT_CREATED_TYPES.has(m.type))) {
      return withGroup(okResult(entityIds, undefined, vertexKeys))
    }
    // A rect, n-gon, mirror, pattern or fillet mints several constraints beside
    // its entities. The ids list keeps the entities in minting order and the
    // constraints collapse to a count; the document resource has their ids.
    // Only constraints this apply CREATED count: filtering against every
    // constraint in the document would drop an authored entity id that happens
    // to match another sketch's constraint id.
    const createdConstraintIds = new Set<string>()
    for (const feature of after.features ?? []) {
      if (feature.kind !== 'sketch') continue
      const beforeFeature = before.features?.find(f => f.id === feature.id)
      const heldBefore = new Set(
        beforeFeature?.kind === 'sketch' ? (beforeFeature.constraints ?? []).map(c => c.id) : [],
      )
      for (const c of feature.constraints ?? []) {
        if (!heldBefore.has(c.id)) createdConstraintIds.add(c.id)
      }
    }
    const ids = entityIds.filter(id => !createdConstraintIds.has(id))
    return withGroup(okResult(ids, entityIds.length - ids.length, undefined, replacedDimensions(before, after)))
  }

  private solveAfterMutation(doc: PartDoc, mutations: Mutation[], restorable: Record<string, SketchData> | null): void {
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

  // Every push goes through here so the open session's floor and foreign-redo
  // markers stay true. A push clears the redo branch, so any redo entry left
  // afterwards is one the session's own undos produced; and a capped push that
  // trims the oldest entry moves the floor down with it, or the first
  // in-session undo would look blocked (or reach past the session).
  private pushHistory(label: string, doc: PartDoc, meta: Mutation | undefined, snapshot: boolean): void {
    const trimmed = snapshot
      ? this.history.pushSnapshot(label, doc, meta)
      : this.history.push(label, doc, meta)
    const edit = this.findTransaction('edit')
    if (!edit) return
    edit.foreignRedo = 0
    if (trimmed > 0) edit.floor = Math.max(0, edit.floor - trimmed)
  }

  private move(direction: 'undo' | 'redo'): boolean {
    // An open placement resolves before the history move: undo cancels the
    // gesture (the dimension and its projections go back to the baseline with
    // no entry) and is that gesture's undo, while redo keeps the dimension by
    // committing it first.
    const placement = this.findTransaction('placement')
    if (placement) {
      if (direction === 'undo') {
        this.cancelPlacementTransaction(placement)
        return true
      }
      this.commitPlacementTransaction(placement)
    }
    const committed = this.commitOpenWorkBeforeHistory()
    const current = this.deps.doc.get()
    // An unsuppressed edit session (a sketch) owns its own per-action entries,
    // so a move whose target is above the session floor stays inside it.
    const edit = this.findTransaction('edit')
    const inSession = edit !== null && !edit.suppressed
    if (edit && inSession) {
      if (!this.moveAvailable(direction) || !current) {
        // At the floor (or with only a foreign redo branch left) the keystroke
        // is dead: the session stays open, nothing is emitted and no editor is
        // torn down.
        return false
      }
      return this.moveInSession(direction, current)
    }
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
    this.emit({ type: 'historyRestored', direction, entry, inSession: false })
    this.emit({ type: 'changed' })
    this.restoreAwareSolve(entry.doc)
    return true
  }

  // The in-session move: the same doc swap and re-solve, without the teardown
  // and without consuming the parked pre-session snapshot. The stacks below the
  // floor never move, so a later cancel still rewinds to the doc it promised.
  private moveInSession(direction: 'undo' | 'redo', current: PartDoc): boolean {
    const entry = direction === 'undo'
      ? this.history.undo(current, { preserveSnapshot: true })
      : this.history.redo(current, { preserveSnapshot: true })
    if (!entry) return false
    this.dirtyOverride = true
    this.deps.doc.set(entry.doc)
    this.deps.journal?.onDocReset()
    this.emit({ type: 'historyRestored', direction, entry, inSession: true })
    this.emit({ type: 'changed' })
    this.restoreAwareSolve(entry.doc)
    return true
  }

  // The one availability rule, shared with the in-session branch of move(): a
  // move inside an unsuppressed session is limited by the session's own
  // window; anywhere else the plain stack length decides.
  private moveAvailable(direction: 'undo' | 'redo'): boolean {
    const edit = this.findTransaction('edit')
    if (edit && !edit.suppressed) {
      return direction === 'undo'
        ? this.history.undoLength() > edit.floor
        : this.history.redoLength() > edit.foreignRedo
    }
    return direction === 'undo' ? this.history.undoLength() > 0 : this.history.redoLength() > 0
  }

  // An undo or redo mid-edit first commits the open work as its own entry, so
  // the history move reverts (undo) or reaches (redo) exactly that work. The
  // placement gesture is resolved by move() itself (undo cancels it, redo
  // commits it), so it is not open work here. Returns true exactly when it
  // pushed open work.
  private commitOpenWorkBeforeHistory(): boolean {
    let committed = false
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
      baseline: this.cloneDoc(source),
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
      baseline: this.cloneDoc(current),
      suppressed: opts.suppressed ?? false,
      styleTouched: false,
      dirty: this.pinDirty(),
      // Taken after the preview above resolved: its entry is pre-session work,
      // so the floor sits above it and an in-session undo never reverts it.
      floor: this.history.undoLength(),
      foreignRedo: this.history.redoLength(),
    }
    this.openTransaction(txn)
    // The pre-session restore point; cancel restores it and commit drops it.
    this.history.saveSnapshot()
    return openedResult(txn.id)
  }

  private beginPlacement(): OpenedResult {
    const existing = this.findTransaction('placement')
    if (existing?.constraintIds.size === 0) {
      // A later pick in the same gesture joins the open placement: re-beginning
      // must not move the baseline the cancel path promised to restore.
      return openedResult(existing.id)
    }
    if (existing) {
      // The previous insert's editor was never resolved (a stray second
      // placement or a double-clicked label): its gesture is finished and banks
      // its entry, and the new placement starts from the doc it leaves behind.
      this.commitPlacementTransaction(existing)
    }
    const current = this.deps.doc.get()
    if (!current) return this.fault('no-document', 'placement refused: no document')
    const txn: PlacementTransaction = {
      id: this.freshId(),
      kind: 'placement',
      baseline: this.cloneDoc(current),
      dirty: this.pinDirty(),
      mutation: null,
      constraintIds: new Set(),
      projectionTargets: new Set(),
    }
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
      this.pushHistory(describeMutation(label), txn.baseline, label, true)
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
    // A placement still open at the session boundary is resolved here: its
    // entry must land before the aggregate's cancel point, or it would outlive
    // the session and bank a second entry later. A suppressed session already
    // swallowed the placement's mutations, so its aggregate covers them and the
    // transaction is only dropped.
    const placement = this.findTransaction('placement')
    if (placement) {
      if (txn.suppressed) this.removeTransaction(placement)
      else this.commitPlacementTransaction(placement)
    }
    const push = this.sessionWouldPush(txn)
    this.removeTransaction(txn)
    if (push) {
      // The editor facts still hold the edited feature here (the caller
      // commits before its exit cleanup clears it), so the label names it.
      const featureId = this.deps.editorFacts().editingFeatureId ?? ''
      const mutation: Mutation = { type: 'edit_session', featureId }
      this.pushHistory(describeMutation(mutation), txn.baseline, mutation, true)
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

  private commitPlacementTransaction(txn: PlacementTransaction): Result {
    const current = this.deps.doc.get()
    const changed = current !== null && docDiffersForSession(txn.baseline, current)
    this.removeTransaction(txn)
    if (changed) {
      // The insert names the entry exactly like an ordinary add; a placement
      // that only projected an edge keeps the projection's own label. The
      // baseline is already the transaction's own clone and the transaction is
      // dropped below, so the push takes it without cloning the whole doc again.
      const mutation = txn.mutation ?? PLACEMENT_COMMIT_FALLBACK
      this.pushHistory(describeMutation(mutation), txn.baseline, mutation, true)
    }
    this.emit({ type: 'changed' })
    return okResult()
  }

  // A preview cancel rewinds to its baseline. Doc rewind and the dirty
  // reconcile are one unit; the re-solve below owns the viewport.
  private cancelPreviewTransaction(txn: PreviewTransaction): Result {
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
    // The session baseline predates any open placement, so the rewind below
    // removes that gesture's work too; dropping it keeps a cancelled boundary
    // from leaving a transaction open against a doc it no longer describes.
    const placement = this.findTransaction('placement')
    if (placement) this.removeTransaction(placement)
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

  // A placement cancel rewinds to its baseline with no entry, which removes
  // the inserted constraint and every scratch projection in one doc write. The
  // dirty reconcile and the re-solve mirror the preview cancel.
  private cancelPlacementTransaction(txn: PlacementTransaction): Result {
    const current = this.deps.doc.get()
    const rewound = JSON.stringify(txn.baseline) !== JSON.stringify(current)
    this.deps.doc.set(txn.baseline)
    if (rewound) this.deps.journal?.onDocReset()
    this.reconcile(txn.dirty, rewound, txn.baseline)
    this.removeTransaction(txn)
    const doc = this.deps.doc.get()
    if (doc) void this.deps.solve.request(doc)
    this.emit({ type: 'changed' })
    return okResult()
  }

  // Which mutations the open placement withholds. The gesture is a brep pick's
  // projection, the scratch delete that replaces such a projection, the
  // dimension insert, and the editor's own edit of the constraint that insert
  // minted. Anything else is a steal that resolves the placement first: a
  // constraint command, a Delete of an ordinary selected entity, a rename.
  private placementSwallows(txn: PlacementTransaction, mutations: Mutation[]): boolean {
    const projections = new Set(txn.projectionTargets)
    const constraintIds = new Set(txn.constraintIds)
    for (const m of mutations) {
      switch (m.type) {
        case 'add_projected_entity': {
          const target = projectionTarget(m)
          if (target !== null) projections.add(target)
          break
        }
        case 'delete':
          // Every target must be a projection this placement materialized; a
          // delete that touches authored geometry is not scratch cleanup.
          if (!m.targets.every(t => projections.has(t))) return false
          break
        case 'add_constraint':
          // A dimension add the caller named (the editor addresses that id).
          // A value-less or id-less add is a command or a script, not this
          // gesture's insert.
          if (!isDimensionKind(m.kind) || m.id === undefined) return false
          constraintIds.add(m.id)
          break
        case 'set_constraint_value':
        case 'set_constraint_sign':
        case 'set_constraint_driven':
          if (!constraintIds.has(m.constraintId)) return false
          break
        default:
          return false
      }
    }
    return true
  }

  // Remembers the dimension add (for the commit label), the ids it minted (the
  // applier may substitute on collision, so the created id is the real one) and
  // the projection targets a following scratch delete may name.
  private recordPlacementMutations(
    txn: PlacementTransaction,
    mutations: Mutation[],
    createdIds: readonly string[],
  ): void {
    for (const m of mutations) {
      if (m.type === 'add_projected_entity') {
        const target = projectionTarget(m)
        if (target !== null) txn.projectionTargets.add(target)
        continue
      }
      if (m.type !== 'add_constraint') continue
      txn.mutation = m
      if (createdIds.length > 0) {
        for (const id of createdIds) txn.constraintIds.add(id)
      } else if (m.id !== undefined) {
        txn.constraintIds.add(m.id)
      }
    }
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
