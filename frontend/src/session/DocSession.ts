import type { PartDoc, Mutation } from '@/types/cad'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { IDEMPOTENT_MUTATION } from '@/hooks/mutationIdempotence'
import { describeMutation } from '@/utils/core/mutationDescriptions'
import { applySetRollback } from '@/utils/yamlMutations'
import { failLoud } from '@/utils/invariants'
import { MAX_UNDO_DEPTH } from '@/config/undoConfig'
import { History, type HistoryEntry } from '@/session/History'
import { GUARD_BYPASS, noOpSliceFor } from '@/session/noOpGuard'
import {
  reconcileDirty,
  restoreDirtyFlag,
  type DirtyFacts,
  type DirtyPin,
} from '@/session/dirty'
import { errorResult, okResult, type Result, type SessionErrorCode } from '@/session/result'
import type { SolveOptions, SolveScheduler, SolveSchedulerState } from '@/session/SolveScheduler'

// The editor state the session does not own: the rollback bar position and the
// open feature editor are injected so the rollback mirror and the
// session-boundary rules keep working without importing a store.
export interface EditorFacts {
  editingFeatureId: string | null
  rollbackPosition: number | null
}

export interface DocSessionDeps {
  cloneDoc: (doc: PartDoc) => PartDoc
  solve: SolveScheduler<PartDoc>
  editorFacts: () => EditorFacts
  docId?: string | null
  // Supplied by the adapter until editor-state-one-owner owns them; absent
  // means the inspection simply omits the field.
  getValidation?: () => unknown
  getBodies?: () => unknown
}

export interface SessionDiagnostic {
  code: SessionErrorCode
  message: string
}

export interface SessionInspection {
  docId: string | null
  dirty: boolean
  featureCount: number
  rollback: number | null
  editingFeatureId: string | null
  history: { undo: string[]; redo: string[] }
  // The transaction stack lands with the transactions phase; the field exists
  // so the inspection shape does not change when it does.
  transactions: readonly never[]
  solve: SolveSchedulerState
  validation?: unknown
  bodies?: unknown
}

// L1 emits history moves so the adapter can run its UI writes (editor
// teardown, rollback clamp). The direction is the reason the move happened:
// the entry doc is what L1 already swapped in.
export type SessionEvent =
  | { type: 'historyRestored'; direction: 'undo' | 'redo'; entry: HistoryEntry<PartDoc> }

// The store's rollback bar after a restore, clamped to the restored feature
// list exactly as Part.tsx clamps a loaded doc. Exported pure so the UI
// adapter derives it from an event doc without importing the session.
export function clampRollbackPosition(doc: PartDoc): number {
  const featureCount = doc.features?.length ?? 0
  return Math.min(Math.max(doc.rollback ?? featureCount, 0), featureCount)
}

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
  'add_transform', 'add_mirror', 'add_variable',
])

function contentIds(doc: PartDoc): Set<string> {
  const ids = new Set<string>()
  for (const feature of doc.features ?? []) {
    ids.add(feature.id)
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

// The framework-free L1 session: it owns the document, the history, the dirty
// policy and solve scheduling, and every doc write goes through execute,
// executeGroup, undo or redo. It imports no React and no store, so it runs
// headless in node; the UI adapter mirrors its state into React and the stores.
export class DocSession {
  private docValue: PartDoc | null
  private readonly deps: DocSessionDeps
  private readonly history: History<PartDoc>
  private readonly listeners = new Set<(event: SessionEvent) => void>()
  private readonly diagnosticsLog: SessionDiagnostic[] = []
  private dirtyFlag = false
  private saves = 0
  private savedHash: number | null = null

  constructor(initialDoc: PartDoc | null, deps: DocSessionDeps) {
    this.docValue = initialDoc
    this.deps = deps
    this.history = new History({ cloneDoc: deps.cloneDoc, cap: MAX_UNDO_DEPTH })
  }

  getDoc(): PartDoc | null {
    return this.docValue
  }

  // The recorded illegal states, oldest first; the Result already told the
  // caller, this is for the driver and the debug surface.
  diagnostics(): readonly SessionDiagnostic[] {
    return this.diagnosticsLog
  }

  execute(mutation: Mutation): Result {
    return this.apply([mutation], false)
  }

  executeGroup(mutations: Mutation[]): Result {
    if (mutations.length === 0) return okResult([])
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

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  inspect(): SessionInspection {
    const doc = this.docValue
    const facts = this.deps.editorFacts()
    const validation = this.deps.getValidation?.()
    const bodies = this.deps.getBodies?.()
    return {
      docId: this.deps.docId ?? null,
      dirty: this.dirtyFlag,
      featureCount: doc?.features?.length ?? 0,
      rollback: doc?.rollback ?? null,
      editingFeatureId: facts.editingFeatureId,
      history: { undo: this.history.undoLabels(), redo: this.history.redoLabels() },
      transactions: [],
      solve: this.deps.solve.state(),
      ...(validation !== undefined && { validation }),
      ...(bodies !== undefined && { bodies }),
    }
  }

  // ─── Dirty policy ───

  pinDirty(): DirtyPin {
    return { dirty: this.dirtyFlag, saves: this.saves }
  }

  markSaved(savedHash?: number, clean = true): void {
    this.dirtyFlag = clean ? false : this.dirtyFlag
    this.saves += 1
    this.savedHash = savedHash ?? null
  }

  clearForNewDocument(): void {
    this.dirtyFlag = false
    this.saves = 0
    this.savedHash = null
  }

  restoreDirtyAfterRewind(pin: DirtyPin): void {
    this.dirtyFlag = restoreDirtyFlag(this.dirtyFacts(), pin)
  }

  reconcileDirtyAfterRewind(pin: DirtyPin, rewound: boolean, serializeRestored: () => string): void {
    const next = reconcileDirty(this.dirtyFacts(), pin, rewound, serializeRestored)
    if (next !== null) this.dirtyFlag = next
  }

  private dirtyFacts(): DirtyFacts {
    return { dirty: this.dirtyFlag, saves: this.saves, savedHash: this.savedHash }
  }

  // ─── Editing ───

  private apply(mutations: Mutation[], group: boolean): Result {
    const current = this.docValue
    if (!current) {
      return this.fault('no-document', 'execute called with no document')
    }
    const unknown = mutations.find(m => !Object.prototype.hasOwnProperty.call(mutationHandlers, m.type))
    if (unknown) {
      return this.fault('unknown-mutation', `no handler for mutation type '${unknown.type}'`)
    }
    const next = this.runMutations(current, mutations)
    if (this.isNoOp(mutations, current, next, group)) {
      return okResult([])
    }
    this.history.push(describeMutation(mutations[0]), current)
    this.dirtyFlag = true
    this.docValue = next
    this.requestSolve(next, mutations)
    return okResult(this.createdIdsFor(mutations, current, next))
  }

  private runMutations(current: PartDoc, mutations: Mutation[]): PartDoc {
    const next = this.deps.cloneDoc(current)
    const handlers = mutationHandlers as Record<string, AnyHandler | undefined>
    for (const m of mutations) {
      handlers[m.type]?.(next, m)
    }
    // The rollback bar is document content, but only a user-parked position
    // is: during an edit the bar is pinned just after the edited feature,
    // which is transient. Outside an edit the mirror runs so an append or
    // delete can never leave a stale position behind.
    const facts = this.deps.editorFacts()
    if (facts.editingFeatureId === null) {
      const rollback = mutations.find(m => m.type === 'set_rollback') as
        | Extract<Mutation, { type: 'set_rollback' }>
        | undefined
      if (rollback && facts.rollbackPosition !== rollback.position) {
        failLoud('[DocSession] set_rollback dispatched with the rollback store not pre-synced')
      }
      applySetRollback(next, facts.rollbackPosition)
    }
    return next
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

  private requestSolve(doc: PartDoc, mutations: Mutation[]): void {
    let opts: SolveOptions
    if (mutations.length > 1) {
      opts = { _suppressFirstSolve: true }
    } else {
      const dragAnchor = dragAnchorFor(mutations[0])
      opts = { bypassCache: dragAnchor !== undefined, dragAnchor, _suppressFirstSolve: true }
    }
    void this.deps.solve.request(doc, opts)
  }

  private move(direction: 'undo' | 'redo'): boolean {
    const current = this.docValue
    if (!current) return false
    const entry = direction === 'undo' ? this.history.undo(current) : this.history.redo(current)
    if (!entry) return false
    // The restored doc is no longer the saved content, so it counts unsaved
    // until the user saves again. Session-boundary reconciles own the pin.
    this.dirtyFlag = true
    this.docValue = entry.doc
    for (const listener of [...this.listeners]) {
      listener({ type: 'historyRestored', direction, entry })
    }
    // Undo/redo re-solves the restored doc; nothing to suppress, exactly as
    // the hook's restore-aware reSolve calls it.
    void this.deps.solve.request(entry.doc)
    return true
  }

  private fault(code: SessionErrorCode, message: string): Result {
    this.diagnosticsLog.push({ code, message })
    // Throws in test mode (pinning the guard), warns in dev, silent in prod;
    // the error Result is returned in every environment that does not throw.
    failLoud(`[DocSession] ${message}`)
    return errorResult(code, message)
  }
}

export function createDocSession(initialDoc: PartDoc | null, deps: DocSessionDeps): DocSession {
  return new DocSession(initialDoc, deps)
}
