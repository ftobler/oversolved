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

import type { AssemblyDoc, MateKind, Transform3D } from '@/types/cad'
import {
  appendMate,
  appendPartInstance,
  assemblyDocEquals,
  bakeSolvedTransforms,
  duplicateInstance,
  moveInstance,
  moveMate,
  removeInstance,
  removeMate,
  setBuiltinVisible,
  setInstanceFixed,
  setInstancePosition,
  setInstanceRotation,
  setInstanceVisible,
  setMateLabel,
  updateMate,
  type EulerDeg,
  type MateParamPatch,
} from '@/utils/assemblyMutations'

export type AssemblyUndoPolicy = 'one-shot' | 'fold'
export type AssemblySolvePolicy = 'solve' | 'defer' | 'skip'

// The payload each operation reads. Keeping them in one map makes the
// operation id an enumerable union and gives runAssemblyOperation a typed input
// for whatever name a command carries.
export interface AssemblyOperationInputs {
  add_part: { docId: string; docRev: number }
  duplicate_part: string
  delete_part: string
  set_part_visible: { handle: string; visible: boolean }
  set_builtin_visible: { id: string; visible: boolean }
  set_part_fixed: { handle: string; fixed: boolean }
  set_part_fixed_oneshot: { handle: string; fixed: boolean }
  set_part_position: { handle: string; pos: { tx: number; ty: number; tz: number } }
  set_part_rotation: { handle: string; euler: EulerDeg }
  add_mate: { kind: MateKind; id: string }
  delete_mate: string
  update_mate: { id: string; patch: MateParamPatch }
  reorder_part: { movingHandle: string; beforeHandle: string | null }
  reorder_mate: { movingId: string; beforeId: string | null }
  rename_mate: { id: string; label: string | undefined }
}

export type AssemblyOperationId = keyof AssemblyOperationInputs

export interface AssemblyOperationDef<I> {
  readonly id: AssemblyOperationId
  readonly label: string
  readonly bake: boolean
  readonly undo: AssemblyUndoPolicy
  readonly solve: AssemblySolvePolicy
  // Pure. Receives the doc AFTER the bake cell has been applied.
  readonly apply: (doc: AssemblyDoc, input: I) => AssemblyDoc
}

// The one place the three policy cells are stated. `set_part_fixed` and
// `set_part_fixed_oneshot` share their body and differ only in `undo`: that is
// exactly the difference the tree's options menu used to encode by hand.
//
// The fixed cells bake and then set the flag. Baking refreshes every non-fixed
// seed and `setInstanceFixed` writes the flag; together they are the old
// setInstanceFixedFromSolved(doc, handle, fixed, transforms), which is why the
// apply here is the flag-only setter rather than the solved-pose one.
export const ASSEMBLY_OPERATIONS: {
  readonly [K in AssemblyOperationId]: AssemblyOperationDef<AssemblyOperationInputs[K]>
} = {
  add_part: {
    id: 'add_part', label: 'Add part', bake: true, undo: 'one-shot', solve: 'solve',
    apply: (doc, input) => appendPartInstance(doc, input.docId, input.docRev),
  },
  duplicate_part: {
    id: 'duplicate_part', label: 'Duplicate part', bake: true, undo: 'one-shot', solve: 'solve',
    apply: (doc, handle) => duplicateInstance(doc, handle),
  },
  delete_part: {
    id: 'delete_part', label: 'Delete part', bake: true, undo: 'one-shot', solve: 'solve',
    apply: (doc, handle) => removeInstance(doc, handle),
  },
  set_part_visible: {
    // Visibility moves nothing on screen, so it neither bakes nor re-solves.
    id: 'set_part_visible', label: 'Toggle visibility', bake: false, undo: 'one-shot', solve: 'skip',
    apply: (doc, input) => setInstanceVisible(doc, input.handle, input.visible),
  },
  set_builtin_visible: {
    // A reference plane is a pure render change: no bake, no solve.
    id: 'set_builtin_visible', label: 'Toggle plane visibility', bake: false, undo: 'one-shot', solve: 'skip',
    apply: (doc, input) => setBuiltinVisible(doc, input.id, input.visible),
  },
  set_part_fixed: {
    // Fixing a part adds no geometric constraint at its solved pose, so the
    // current view is already correct; baking keeps the seeds in step for the
    // next real solve. The editor checkbox folds into the session's step.
    id: 'set_part_fixed', label: 'Fix/unfix part', bake: true, undo: 'fold', solve: 'skip',
    apply: (doc, input) => setInstanceFixed(doc, input.handle, input.fixed),
  },
  set_part_fixed_oneshot: {
    // The options-menu toggle is a structural op: its own step even while an
    // editor session is open.
    id: 'set_part_fixed_oneshot', label: 'Fix/unfix part', bake: true, undo: 'one-shot', solve: 'skip',
    apply: (doc, input) => setInstanceFixed(doc, input.handle, input.fixed),
  },
  set_part_position: {
    id: 'set_part_position', label: 'Set position', bake: true, undo: 'fold', solve: 'solve',
    apply: (doc, input) => setInstancePosition(doc, input.handle, input.pos),
  },
  set_part_rotation: {
    id: 'set_part_rotation', label: 'Set rotation', bake: true, undo: 'fold', solve: 'solve',
    apply: (doc, input) => setInstanceRotation(doc, input.handle, input.euler),
  },
  add_mate: {
    // An unreferenced mate has nothing to constrain: the editor opens and arms
    // a field, and the solve lands when that field closes.
    id: 'add_mate', label: 'Add mate', bake: false, undo: 'one-shot', solve: 'skip',
    apply: (doc, input) => appendMate(doc, input.kind, input.id),
  },
  delete_mate: {
    id: 'delete_mate', label: 'Delete mate', bake: true, undo: 'one-shot', solve: 'solve',
    apply: (doc, id) => removeMate(doc, id),
  },
  update_mate: {
    // A mate parameter edit must NOT bake: baking would fold the previous
    // solve's roll into the seed and the solver's seed-relative angle would
    // compound every keystroke. The solve is owed while a chip is armed.
    id: 'update_mate', label: 'Edit mate', bake: false, undo: 'fold', solve: 'defer',
    apply: (doc, input) => updateMate(doc, input.id, input.patch),
  },
  reorder_part: {
    // Reordering is a pure authored-order edit: no geometry moves, no solve.
    id: 'reorder_part', label: 'Reorder part', bake: false, undo: 'one-shot', solve: 'skip',
    apply: (doc, input) => moveInstance(doc, input.movingHandle, input.beforeHandle),
  },
  reorder_mate: {
    id: 'reorder_mate', label: 'Reorder mate', bake: false, undo: 'one-shot', solve: 'skip',
    apply: (doc, input) => moveMate(doc, input.movingId, input.beforeId),
  },
  rename_mate: {
    id: 'rename_mate', label: 'Rename mate', bake: false, undo: 'one-shot', solve: 'skip',
    apply: (doc, input) => setMateLabel(doc, input.id, input.label),
  },
}

export interface AssemblyOperationPlan {
  id: AssemblyOperationId
  label: string
  // Baked if the cell says so, then mutated.
  doc: AssemblyDoc
  changed: boolean
  undo: AssemblyUndoPolicy
  solve: AssemblySolvePolicy
}

// Build the next doc for an operation, or null when there is no doc to act on.
// The no-op guard mirrors the old mutate funnel: a structural compare catches
// the value no-ops a reference fast path misses.
export function planAssemblyOperation<K extends AssemblyOperationId>(
  id: K,
  input: AssemblyOperationInputs[K],
  ctx: { doc: AssemblyDoc | null; transforms: Record<string, Transform3D> },
): AssemblyOperationPlan | null {
  if (!ctx.doc) return null
  const def = ASSEMBLY_OPERATIONS[id] as AssemblyOperationDef<AssemblyOperationInputs[K]>
  const pre = ctx.doc
  const baked = def.bake ? bakeSolvedTransforms(pre, ctx.transforms) : pre
  const doc = def.apply(baked, input)
  const changed = !(doc === pre || assemblyDocEquals(pre, doc))
  return { id, label: def.label, doc, changed, undo: def.undo, solve: def.solve }
}

// The context and effects an operation runs against. `doc` and `transforms` are
// the page's live state at the moment of the call; the four effects are the
// only ways an operation is allowed to touch the editor.
export interface AssemblyOperationContext {
  doc: AssemblyDoc | null
  transforms: Record<string, Transform3D>
}

export interface AssemblyOperationHost extends AssemblyOperationContext {
  mutateSession: (label: string, fn: (d: AssemblyDoc) => AssemblyDoc) => void
  mutateOneShot: (label: string, fn: (d: AssemblyDoc) => AssemblyDoc) => void
  requestSolve: () => void
  requestSolveOrDefer: () => void
}

// Execute an operation against a host. The plan is built first; a no-op returns
// without touching the doc, and the undo and solve cells decide exactly which
// effect fires. The page never decides a cell again.
export function runAssemblyOperation<K extends AssemblyOperationId>(
  id: K,
  input: AssemblyOperationInputs[K],
  host: AssemblyOperationHost,
): void {
  const plan = planAssemblyOperation(id, input, { doc: host.doc, transforms: host.transforms })
  if (!plan || !plan.changed) return
  const apply = () => plan.doc
  if (plan.undo === 'one-shot') host.mutateOneShot(plan.label, apply)
  else host.mutateSession(plan.label, apply)
  if (plan.solve === 'solve') host.requestSolve()
  else if (plan.solve === 'defer') host.requestSolveOrDefer()
}
