// The assembly editor's document-operation policy, in one declarative table.
//
// Each entry answers three questions that used to live only in prose comments
// inside AssemblyEditor.tsx and were re-derived by every handler:
//   - bake: compose the solved transforms into the seeds before applying?
//   - undo: a one-shot step, or fold into the open editor's coalescing session?
//   - solve: re-solve now, owe the solve to the armed field, or do neither?
//
// `apply` is a pure AssemblyDoc mutation from assemblyMutations.ts. The plan
// bakes first (when the cell says so) and then calls it, so an operation never
// decides for itself whether to bake. Pure: no store, no callbacks, no React.

import type { AssemblyDoc, MateKind, MateRef, MateRefField, Transform3D } from '@/types/cad'
import { ASSEMBLY_UNDO_LABELS, type AssemblyUndoLabel } from '@/utils/core/assemblyUndoLabels'
import { cyclePath } from '@/workspace/refs'
import type { ReferenceEdges } from '@/workspace/types'
import {
  appendMate,
  appendPartInstance,
  assemblyDocEquals,
  bakeSolvedTransforms,
  clearMateRef,
  duplicateInstance,
  moveInstance,
  moveMate,
  removeInstance,
  removeMate,
  setBuiltinVisible,
  setInstanceFixedFromSolved,
  setInstancePartDoc,
  setInstancePosition,
  setInstanceRotation,
  setInstanceVisible,
  setMateLabel,
  setMateRef,
  updateMate,
  type EulerDeg,
  type MateParamPatch,
} from '@/utils/assemblyMutations'

export type AssemblyUndoPolicy = 'one-shot' | 'fold'
export type AssemblySolvePolicy = 'solve' | 'defer' | 'skip'

// The payload each operation reads. Keeping them in one map makes the
// operation id an enumerable union and gives runAssemblyOperation a typed input
// for whatever name a command carries.
export interface AddPartInput {
  docId: string
  docRev: number
  handle?: string
  featureId?: string
  transform?: Transform3D
  fixed?: boolean
}

export interface AssemblyOperationInputs {
  add_part: AddPartInput
  // The batch twin: the split STEP import places one instance per solid through
  // it, so the whole import is one undo entry and one solve.
  add_parts: readonly AddPartInput[]
  // The UI names one handle; the drive also authors the copy's ids (D10).
  duplicate_part: string | { handle: string; newHandle?: string; featureId?: string }
  delete_part: string
  set_part_visible: { handle: string; visible: boolean }
  set_builtin_visible: { id: string; visible: boolean }
  set_part_fixed: { handle: string; fixed: boolean }
  set_part_fixed_oneshot: { handle: string; fixed: boolean }
  set_part_position: { handle: string; pos: { tx: number; ty: number; tz: number } }
  set_part_rotation: { handle: string; euler: EulerDeg }
  set_part_doc: { handle: string; docId: string }
  add_mate: {
    kind: MateKind
    id: string
    label?: string
    ref_a?: MateRef
    ref_b?: MateRef
    patch?: MateParamPatch
  }
  // The one ref write the editor's aim commit and the drive share (D9).
  set_mate_ref: { id: string; field: MateRefField; ref: MateRef; patch?: MateParamPatch }
  // The chip's Remove: release one slot without touching its sibling or params.
  clear_mate_ref: { id: string; field: MateRefField }
  delete_mate: string
  update_mate: { id: string; patch: MateParamPatch }
  reorder_part: { movingHandle: string; beforeHandle: string | null }
  reorder_mate: { movingId: string; beforeId: string | null }
  rename_mate: { id: string; label: string | undefined }
}

export type AssemblyOperationId = keyof AssemblyOperationInputs

export interface AssemblyOperationDef<I> {
  readonly id: AssemblyOperationId
  /**
   * A constant for every operation but one. The built-in visibility row is
   * shared by the origin and the planes, so its label is resolved from the
   * document: the undo tooltip must name the reference geometry that was
   * hidden, not whatever one of the two the table happened to pick.
   */
  readonly label: AssemblyUndoLabel | ((doc: AssemblyDoc, input: I) => AssemblyUndoLabel)
  readonly bake: boolean
  readonly undo: AssemblyUndoPolicy
  readonly solve: AssemblySolvePolicy
  // Pure. Receives the doc AFTER the bake cell has been applied, plus the
  // solved poses that bake used, which the fixed-flag write needs for itself,
  // and the handles the solve reported as moved (absent when no report exists).
  readonly apply: (
    doc: AssemblyDoc,
    input: I,
    transforms: Record<string, Transform3D>,
    moved?: ReadonlySet<string>,
  ) => AssemblyDoc
}

// One operation covers every built-in, but only the planes still have a tree
// eye; the origin's write is refused before it can earn an undo entry. The label
// is the only cell that reads the document, which is where the feature's kind
// lives; an id naming neither is a stale row whose toggle is a no-op anyway, and
// gets the generic wording rather than a claim about the wrong geometry.
function builtinVisibilityLabel(doc: AssemblyDoc, id: string): AssemblyUndoLabel {
  const feature = (doc.features ?? []).find(f => f.id === id)
  if (feature?.kind === 'origin') return ASSEMBLY_UNDO_LABELS.toggleOriginVisibility
  if (feature?.kind === 'plane') return ASSEMBLY_UNDO_LABELS.togglePlaneVisibility
  return ASSEMBLY_UNDO_LABELS.toggleBuiltinVisibility
}

// The one place the three policy cells are stated. `set_part_fixed` and
// `set_part_fixed_oneshot` share their body and differ only in `undo`: that is
// exactly the difference the tree's options menu used to encode by hand.
//
// The fixed cells bake, then route the flag through setInstanceFixedFromSolved.
// The plan's bake refreshes every non-fixed seed and the setter carries the
// guard the flag-only setter lost: an absent `fixed` means false, so re-setting
// false must neither charge a dead undo entry nor materialize a permanent
// `fixed: false` key in the document. It also owns the one bake the plan cannot
// do -- freezing the toggled instance's own solved pose into its seed, which is
// the point of the call and the reason it stays the write path here.
export const ASSEMBLY_OPERATIONS: {
  readonly [K in AssemblyOperationId]: AssemblyOperationDef<AssemblyOperationInputs[K]>
} = {
  add_part: {
    id: 'add_part', label: ASSEMBLY_UNDO_LABELS.addPart, bake: true, undo: 'one-shot', solve: 'solve',
    apply: (doc, input) => appendPartInstance(doc, input.docId, input.docRev, {
      ...(input.handle !== undefined && { handle: input.handle }),
      ...(input.featureId !== undefined && { featureId: input.featureId }),
      ...(input.transform !== undefined && { transform: input.transform }),
      ...(input.fixed !== undefined && { fixed: input.fixed }),
    }),
  },
  add_parts: {
    // The batch is add_part repeated: the bake runs once for the whole set, the
    // set is one undo entry and one solve. The split STEP import is its caller.
    id: 'add_parts', label: ASSEMBLY_UNDO_LABELS.addPart, bake: true, undo: 'one-shot', solve: 'solve',
    apply: (doc, parts) => parts.reduce((next, part) => appendPartInstance(next, part.docId, part.docRev, {
      ...(part.handle !== undefined && { handle: part.handle }),
      ...(part.featureId !== undefined && { featureId: part.featureId }),
      ...(part.transform !== undefined && { transform: part.transform }),
      ...(part.fixed !== undefined && { fixed: part.fixed }),
    }), doc),
  },
  duplicate_part: {
    id: 'duplicate_part', label: ASSEMBLY_UNDO_LABELS.duplicatePart, bake: true, undo: 'one-shot', solve: 'solve',
    apply: (doc, input) => typeof input === 'string'
      ? duplicateInstance(doc, input)
      : duplicateInstance(doc, input.handle, {
        ...(input.newHandle !== undefined && { handle: input.newHandle }),
        ...(input.featureId !== undefined && { featureId: input.featureId }),
      }),
  },
  delete_part: {
    id: 'delete_part', label: ASSEMBLY_UNDO_LABELS.deletePart, bake: true, undo: 'one-shot', solve: 'solve',
    apply: (doc, handle) => removeInstance(doc, handle),
  },
  set_part_visible: {
    // Visibility moves nothing on screen, so it neither bakes nor re-solves.
    id: 'set_part_visible', label: ASSEMBLY_UNDO_LABELS.toggleVisibility, bake: false, undo: 'one-shot', solve: 'skip',
    apply: (doc, input) => setInstanceVisible(doc, input.handle, input.visible),
  },
  set_builtin_visible: {
    // A reference plane is a pure render change: no bake, no solve.
    id: 'set_builtin_visible',
    label: (doc, input) => builtinVisibilityLabel(doc, input.id),
    bake: false, undo: 'one-shot', solve: 'skip',
    apply: (doc, input) => setBuiltinVisible(doc, input.id, input.visible),
  },
  set_part_fixed: {
    // Fixing a part adds no geometric constraint at its solved pose, so the
    // current view is already correct; baking keeps the seeds in step for the
    // next real solve. The editor checkbox folds into the session's step.
    id: 'set_part_fixed', label: ASSEMBLY_UNDO_LABELS.fixUnfixPart, bake: true, undo: 'fold', solve: 'skip',
    apply: (doc, input, transforms, moved) => setInstanceFixedFromSolved(doc, input.handle, input.fixed, transforms, moved),
  },
  set_part_fixed_oneshot: {
    // The options-menu toggle is a structural op: its own step even while an
    // editor session is open.
    id: 'set_part_fixed_oneshot', label: ASSEMBLY_UNDO_LABELS.fixUnfixPart, bake: true, undo: 'one-shot', solve: 'skip',
    apply: (doc, input, transforms, moved) => setInstanceFixedFromSolved(doc, input.handle, input.fixed, transforms, moved),
  },
  set_part_position: {
    id: 'set_part_position', label: ASSEMBLY_UNDO_LABELS.setPosition, bake: true, undo: 'fold', solve: 'solve',
    apply: (doc, input) => setInstancePosition(doc, input.handle, input.pos),
  },
  set_part_rotation: {
    id: 'set_part_rotation', label: ASSEMBLY_UNDO_LABELS.setRotation, bake: true, undo: 'fold', solve: 'solve',
    apply: (doc, input) => setInstanceRotation(doc, input.handle, input.euler),
  },
  set_part_doc: {
    // A rebind changes the geometry behind the placement, so the bake keeps the
    // pose on screen as the placement seed and the solve re-resolves every mate
    // that names this instance. It FOLDS like the other instance-editor
    // controls: a pick inside the open editor must be reverted by that editor's
    // Cancel. With no session open (the store path, the headless host) the fold
    // policy still lands as its own step.
    id: 'set_part_doc', label: ASSEMBLY_UNDO_LABELS.setPartDoc, bake: true, undo: 'fold', solve: 'solve',
    apply: (doc, input) => setInstancePartDoc(doc, input.handle, input.docId),
  },
  add_mate: {
    // An unreferenced mate has nothing to constrain: the editor opens and arms
    // a field, and the solve lands when that field closes.
    id: 'add_mate', label: ASSEMBLY_UNDO_LABELS.addMate, bake: false, undo: 'one-shot', solve: 'skip',
    apply: (doc, input) => appendMate(doc, input.kind, input.id, {
      ...(input.label !== undefined && { label: input.label }),
      ...(input.ref_a !== undefined && { ref_a: input.ref_a }),
      ...(input.ref_b !== undefined && { ref_b: input.ref_b }),
      ...(input.patch !== undefined && { patch: input.patch }),
    }),
  },
  set_mate_ref: {
    // One ref write shared by the editor's aim commit and the drive. It folds
    // like the mate parameter edit it always rides with, and defers the solve
    // while a chip is armed (the aim commit's contract).
    id: 'set_mate_ref', label: ASSEMBLY_UNDO_LABELS.pickMateReference, bake: false, undo: 'fold', solve: 'defer',
    apply: (doc, input) => {
      const withRef = setMateRef(doc, input.id, input.field, input.ref)
      return input.patch ? updateMate(withRef, input.id, input.patch) : withRef
    },
  },
  clear_mate_ref: {
    // A released slot leaves a half-empty mate, which the solve treats like a
    // freshly added one: stale but not an error, with no constraint to apply.
    // Re-solving settles the part the mate used to bind instead of leaving it
    // parked where the dead constraint last put it.
    id: 'clear_mate_ref', label: ASSEMBLY_UNDO_LABELS.clearMateRef, bake: false, undo: 'one-shot', solve: 'solve',
    apply: (doc, input) => clearMateRef(doc, input.id, input.field),
  },
  delete_mate: {
    id: 'delete_mate', label: ASSEMBLY_UNDO_LABELS.deleteMate, bake: true, undo: 'one-shot', solve: 'solve',
    apply: (doc, id) => removeMate(doc, id),
  },
  update_mate: {
    // A mate parameter edit must NOT bake: baking would fold the previous
    // solve's roll into the seed and the solver's seed-relative angle would
    // compound every keystroke. The solve is owed while a chip is armed.
    id: 'update_mate', label: ASSEMBLY_UNDO_LABELS.editMate, bake: false, undo: 'fold', solve: 'defer',
    apply: (doc, input) => updateMate(doc, input.id, input.patch),
  },
  reorder_part: {
    // Reordering is a pure authored-order edit: no geometry moves, no solve.
    id: 'reorder_part', label: ASSEMBLY_UNDO_LABELS.reorderPart, bake: false, undo: 'one-shot', solve: 'skip',
    apply: (doc, input) => moveInstance(doc, input.movingHandle, input.beforeHandle),
  },
  reorder_mate: {
    id: 'reorder_mate', label: ASSEMBLY_UNDO_LABELS.reorderMate, bake: false, undo: 'one-shot', solve: 'skip',
    apply: (doc, input) => moveMate(doc, input.movingId, input.beforeId),
  },
  rename_mate: {
    id: 'rename_mate', label: ASSEMBLY_UNDO_LABELS.renameMate, bake: false, undo: 'one-shot', solve: 'skip',
    apply: (doc, input) => setMateLabel(doc, input.id, input.label),
  },
}

export interface AssemblyOperationPlan {
  id: AssemblyOperationId
  label: AssemblyUndoLabel
  // Baked if the cell says so, then mutated.
  doc: AssemblyDoc
  changed: boolean
  undo: AssemblyUndoPolicy
  solve: AssemblySolvePolicy
}

/**
 * The cycle a placement would close, by display names, or null when the target
 * is safe. Runs against the workspace reference graph, so it covers any depth;
 * parts and files never matter because only an assembly authors an assembly
 * edge. `references` is the merged map the caller holds (the stored graph plus
 * the open document's own live instance list, which is not saved yet).
 */
function cycleError(
  ctx: {
    references?: ReferenceEdges
    assemblyDocId?: string
    nameOf?: (docId: string) => string | undefined
  },
  docId: string,
  rebind: boolean,
): Error | null {
  const host = ctx.assemblyDocId
  if (host === undefined) return null
  const path = cyclePath(ctx.references ?? {}, host, docId)
  if (path === null) return null
  if (path.length === 1 && rebind) {
    // The long-standing rebind wording: pointing an instance at its own assembly
    // is the zero-length case of the same rule.
    return new Error(`A part instance cannot point at the assembly it belongs to: ${docId}`)
  }
  const names = path.map(id => (id === host ? 'this assembly' : (ctx.nameOf?.(id) ?? id)))
  const candidate = ctx.nameOf?.(docId) ?? (docId === host ? 'this assembly' : docId)
  return new Error(`Adding ${candidate} would make a circular assembly: ${names.join(' > ')}`)
}

// Build the next doc for an operation, or null when there is no doc to act on.
// The no-op guard mirrors the old mutate funnel: a structural compare catches
// the value no-ops a reference fast path misses.
//
// I8: `add_part` is the only site that authors an outward link, so it refuses
// when the named doc is not a live part entry in the open workspace. The batch
// twin `add_parts` refuses the whole set if any one id is not live, before the
// bake or any append, so a split import can never half-land. The guard rides the
// context because the pure mutation has no store access; an absent
// `knownPartIds` (a caller that does not scope its picks) skips the check.
export function planAssemblyOperation<K extends AssemblyOperationId>(
  id: K,
  input: AssemblyOperationInputs[K],
  ctx: {
    doc: AssemblyDoc | null
    transforms: Record<string, Transform3D>
    moved?: ReadonlySet<string>
    knownPartIds?: ReadonlySet<string>
    // The live assembly entries, so an assembly is an insertable target exactly
    // when the reference graph allows it. Absent means no assembly may be added.
    knownAssemblyIds?: ReadonlySet<string>
    // The workspace reference graph plus the open document's own live instance
    // list, which the stored graph cannot show before the document is saved.
    references?: ReferenceEdges
    // Display names for the cycle message's path.
    nameOf?: (docId: string) => string | undefined
    assemblyDocId?: string
  },
): AssemblyOperationPlan | null {
  if (!ctx.doc) return null
  const def = ASSEMBLY_OPERATIONS[id] as AssemblyOperationDef<AssemblyOperationInputs[K]>
  if (id === 'add_part' || id === 'add_parts') {
    const requested = id === 'add_part'
      ? [(input as AssemblyOperationInputs['add_part']).docId]
      : (input as AssemblyOperationInputs['add_parts']).map(part => part.docId)
    for (const docId of requested) {
      // The cycle refusal comes first so a circular assembly reports why rather
      // than as an unknown id (the two answers can both be true).
      const cycle = cycleError(ctx, docId, false)
      if (cycle) throw cycle
      if (ctx.knownPartIds && !ctx.knownPartIds.has(docId) && !ctx.knownAssemblyIds?.has(docId)) {
        throw new Error(`Part is not a live entry in this workspace: ${docId}`)
      }
    }
  }
  // A rebind authors the same outward link add_part does, plus the one link that
  // would make the document point at itself. The cycle rule covers both.
  if (id === 'set_part_doc') {
    const { docId } = input as AssemblyOperationInputs['set_part_doc']
    if (docId === '') {
      throw new Error('A part instance needs a non-empty part doc_id')
    }
    const cycle = cycleError(ctx, docId, true)
    if (cycle) throw cycle
    if (ctx.knownPartIds && !ctx.knownPartIds.has(docId) && !ctx.knownAssemblyIds?.has(docId)) {
      throw new Error(`Part is not a live entry in this workspace: ${docId}`)
    }
  }
  const pre = ctx.doc
  const label = typeof def.label === 'function' ? def.label(pre, input) : def.label
  const baked = def.bake ? bakeSolvedTransforms(pre, ctx.transforms, ctx.moved) : pre
  const doc = def.apply(baked, input, ctx.transforms, ctx.moved)
  // Measure the change against the BAKED doc, not the pre-op one: a bake:true
  // operation whose value is already what it sets only differs in the seeds, so
  // comparing against `pre` would push an undo step whose whole diff is the
  // bake. Undoing that restores the stale seeds the bake was meant to refresh.
  const changed = !(doc === baked || assemblyDocEquals(baked, doc))
  return { id, label, doc, changed, undo: def.undo, solve: def.solve }
}

// The context and effects an operation runs against. `doc` and `transforms` are
// the page's live state at the moment of the call; the four effects are the
// only ways an operation is allowed to touch the editor.
export interface AssemblyOperationContext {
  doc: AssemblyDoc | null
  transforms: Record<string, Transform3D>
  /** Handles the last solve moved. Absent means no report was available, in
   *  which case the bake writes every solved pose. */
  moved?: ReadonlySet<string>
  // I8's live-part set: the ids `add_part` is allowed to reference. Optional so
  // an unscoped caller (the store's delete path) needs no workspace.
  knownPartIds?: ReadonlySet<string>
  // The live assembly entries a sub-assembly can name.
  knownAssemblyIds?: ReadonlySet<string>
  // The reference graph the cycle rule walks.
  references?: ReferenceEdges
  nameOf?: (docId: string) => string | undefined
  /** The open assembly's own doc id, so a `set_part_doc` cannot point an
   *  instance at the assembly that owns it. Absent in the headless session,
   *  where the assembly has no workspace identity. */
  assemblyDocId?: string
}

export interface AssemblyOperationHost extends AssemblyOperationContext {
  mutateSession: (label: AssemblyUndoLabel, fn: (d: AssemblyDoc) => AssemblyDoc) => void
  mutateOneShot: (label: AssemblyUndoLabel, fn: (d: AssemblyDoc) => AssemblyDoc) => void
  requestSolve: () => void
  requestSolveOrDefer: () => void
}

// Execute an operation against a host. The plan is built first; a no-op returns
// without touching the doc, and the undo and solve cells decide exactly which
// effect fires. The page never decides a cell again.
//
// Intentional behavior change from the old hand-written handlers: a value no-op
// (visibility set to what it already is, rename to the same label) now returns
// before the solve cell, so it fires no re-solve. The old handlers pushed their
// mutation and called requestSolve unconditionally, even when the doc did not
// change; the funnel's no-op guard only skipped the undo step, not the solve.
export function runAssemblyOperation<K extends AssemblyOperationId>(
  id: K,
  input: AssemblyOperationInputs[K],
  host: AssemblyOperationHost,
): void {
  const ctx = {
    transforms: host.transforms,
    knownPartIds: host.knownPartIds,
    knownAssemblyIds: host.knownAssemblyIds,
    references: host.references,
    nameOf: host.nameOf,
    assemblyDocId: host.assemblyDocId,
  }
  // host.doc is the caller's mirror and only decides whether this operation is
  // worth running. The apply is handed to the mutation funnel as a function of
  // the LIVE doc: two operations in one handler (a pattern, a ref pick after a
  // sibling edit) must compose instead of each starting from the mirror that
  // the previous one has not updated yet.
  const plan = planAssemblyOperation(id, input, { doc: host.doc, ...ctx })
  if (!plan || !plan.changed) return
  // The funnel applies its function synchronously against the live doc, so the
  // live re-plan settles the changed decision before the mutate call returns.
  // A live no-op (the mirror was stale) must not spend a solve.
  let liveChanged = false
  const apply = (d: AssemblyDoc) => {
    const live = planAssemblyOperation(id, input, { doc: d, ...ctx })
    if (!live || !live.changed) return d
    liveChanged = true
    return live.doc
  }
  if (plan.undo === 'one-shot') host.mutateOneShot(plan.label, apply)
  else host.mutateSession(plan.label, apply)
  if (!liveChanged) return
  if (plan.solve === 'solve') host.requestSolve()
  else if (plan.solve === 'defer') host.requestSolveOrDefer()
}
