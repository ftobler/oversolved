import type { MateKind } from '@/types/cad'
import { MATE_KINDS, MATE_KIND_LABELS } from '@/utils/mateKinds'
import type { AssemblySubject } from '@/utils/assemblySelection'
import type { AssemblyOperationId, AssemblyOperationInputs } from '@/utils/assemblyOperations'
import type { MateParamPatch } from '@/utils/assemblyMutations'
import { okResult } from '@/session/result'
import { ASSEMBLY_KEYBINDINGS } from '@/utils/core/commandRegistry'
import type { CommandName } from '@/utils/core/commandNames'
import {
  noParams, objectParams, valueParam, Field,
  type CommandContext, type CommandResult, type ErasedCommandSpec, type FieldSpec, type ParamsSpec,
} from '@/utils/core/commandSpec'

// Every assembly command except the per-kind mate inserts. A tree row carries
// its subject as a payload through `executeCommand(name, payload)`.
const ASSEMBLY_FIXED_COMMAND_NAMES = [
  'undo',
  'redo',
  'delete_selected',
  'cancel_edit',
  'export_assembly',
  'insert_part_instance',
  'add_part',
  'duplicate_part',
  'delete_part',
  'set_part_visible',
  'set_builtin_visible',
  'set_part_fixed',
  'set_part_fixed_oneshot',
  'set_part_position',
  'set_part_rotation',
  'delete_mate',
  'update_mate',
  'reorder_part',
  'reorder_mate',
  'rename_mate',
] as const

export type MateInsertCommandName = `insert_mate_${MateKind}`

export type AssemblyCommandName = (typeof ASSEMBLY_FIXED_COMMAND_NAMES)[number] | MateInsertCommandName

export const ASSEMBLY_COMMAND_NAMES: readonly AssemblyCommandName[] = [
  ...ASSEMBLY_FIXED_COMMAND_NAMES,
  ...MATE_KINDS.map(insertMateCommand),
]

/**
 * Which assembly operation each mutating command resolves to. UI-only commands
 * (undo/redo/delete_selected/delete_part/delete_mate/cancel_edit/export/
 * insert_part_instance) are absent: they either touch no document, open a picker
 * before the operation runs, or route through the store's one delete action.
 * This is the map the coverage test reads, so a new operation without a command
 * fails to be reachable.
 */
export const ASSEMBLY_OPERATION_BY_COMMAND: Readonly<Record<string, AssemblyOperationId>> = {
  add_part: 'add_part',
  duplicate_part: 'duplicate_part',
  set_part_visible: 'set_part_visible',
  set_builtin_visible: 'set_builtin_visible',
  set_part_fixed: 'set_part_fixed',
  set_part_fixed_oneshot: 'set_part_fixed_oneshot',
  set_part_position: 'set_part_position',
  set_part_rotation: 'set_part_rotation',
  update_mate: 'update_mate',
  reorder_part: 'reorder_part',
  reorder_mate: 'reorder_mate',
  rename_mate: 'rename_mate',
  ...Object.fromEntries(MATE_KINDS.map(k => [`insert_mate_${k}`, 'add_mate' as const])),
}

export function insertMateCommand(kind: MateKind): MateInsertCommandName {
  return `insert_mate_${kind}`
}

/**
 * The page's inputs for the assembly command table, plus the store-backed
 * history depths the enabled verdicts read. Every document mutation is
 * expressed here as `runOperation`, so the wiring from command name to
 * operation is in one place and a test can execute the specs and observe which
 * operations fired. The delete commands are the exception: they hand off to the
 * store's one `deleteSubject`, which runs the delete operation cell itself, so
 * the [Delete] key and the tree rows cannot drift. The remaining deps are the
 * UI side effects (open the picker/export, open a fresh mate's editor) and the
 * id minting.
 */
export interface AssemblyCommandContext extends CommandContext {
  editor: 'assembly'
  runOperation: <K extends AssemblyOperationId>(id: K, payload: AssemblyOperationInputs[K]) => void
  undo: () => void
  redo: () => void
  deleteSelected: () => void
  cancelEdit: () => void
  openInsertPart: () => void
  openExport: () => void
  // A fresh mate's feature id and the editor side effects after its append.
  mintMateId: () => string
  closeOpenEditor: () => void
  onMateInserted: (id: string, kind: MateKind) => void
  // The store's one delete path, shared with the [Delete] key.
  deleteSubject: (subject: AssemblySubject) => void
  /**
   * The undo first stage, the part editor's stage for a half-placed draw
   * point. Both halves are page-supplied so this wiring stays store-free, the
   * same as every other dep here: `manipulationLive` asks whether a drag is
   * under the held button, and `cancelManipulation` retires it through the
   * store's own cancel path, which is exactly the teardown Escape runs.
   */
  manipulationLive: () => boolean
  cancelManipulation: () => void
  // The assembly store's history depths, the source the toolbar mirrors.
  undoDepth: () => number
  redoDepth: () => number
}

export type AssemblyCommandSpec = ErasedCommandSpec<AssemblyCommandContext>

// The canonical shortcut per command, first binding wins.
function firstShortcut(): Map<CommandName, string> {
  const map = new Map<CommandName, string>()
  for (const binding of ASSEMBLY_KEYBINDINGS) {
    if (!map.has(binding.command)) map.set(binding.command, binding.key)
  }
  return map
}

const ASSEMBLY_SHORTCUTS = firstShortcut()

function shortcut(id: CommandName): string | undefined {
  return ASSEMBLY_SHORTCUTS.get(id)
}

// The mate patch is validated key by key by the operation; the registry only
// checks that an object arrived.
const matePatchField: FieldSpec<MateParamPatch> = {
  type: 'object',
  parse: raw => typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? { ok: true, value: raw as MateParamPatch }
    : { ok: false, error: 'expected an object' },
}

interface SpecOptions<P> {
  id: CommandName
  label: string
  params: ParamsSpec<P>
  enabled?: (ctx: AssemblyCommandContext) => true | string
  undoable?: boolean
  run: (ctx: AssemblyCommandContext, params: P) => CommandResult
}

/**
 * One spec with the common defaults: the shortcut comes from the assembly
 * keybindings and a spec is undoable and enabled unless it says otherwise. The
 * erasing wrapper is the single cast, here where the schema and the body are
 * written side by side.
 */
function spec<P>(options: SpecOptions<P>): AssemblyCommandSpec {
  return {
    id: options.id,
    label: options.label,
    shortcut: shortcut(options.id),
    params: options.params,
    enabled: options.enabled ?? (() => true),
    undoable: options.undoable ?? true,
    run: (ctx, params) => options.run(ctx, params as P),
  }
}

const MATE_INSERT_SPECS: AssemblyCommandSpec[] = MATE_KINDS.map((kind): AssemblyCommandSpec => ({
  id: insertMateCommand(kind),
  label: `Insert ${MATE_KIND_LABELS[kind]} mate`,
  params: noParams(),
  enabled: () => true,
  undoable: true,
  run: ctx => {
    const id = ctx.mintMateId()
    ctx.closeOpenEditor()
    ctx.runOperation('add_mate', { kind, id })
    ctx.onMateInserted(id, kind)
    return okResult()
  },
}))

/**
 * The assembly editor's full command table. Static data: every body reads its
 * inputs from the context it is handed, so the list can be registered for any
 * mounted editor and enumerated in tests without a DOM.
 */
export const ASSEMBLY_COMMAND_SPECS: readonly AssemblyCommandSpec[] = [
  // A live drag owns the first press, mirroring the part editor's undo stage:
  // it is abandoned through the store's cancel path, which retires the
  // session and asks for the restoring solve, and history is left untouched.
  // Falling through to the pop instead made one keystroke both drop the drag
  // (applyUndoRedo's transient reset did that silently) and restore an older
  // doc, which is two changes from one press.
  spec({
    id: 'undo',
    label: 'Undo',
    params: noParams(),
    undoable: false,
    enabled: ctx => (ctx.undoDepth() === 0 ? 'nothing to undo' : true),
    run: ctx => {
      if (ctx.manipulationLive()) {
        ctx.cancelManipulation()
        return okResult()
      }
      ctx.undo()
      return okResult()
    },
  }),
  spec({
    id: 'redo',
    label: 'Redo',
    params: noParams(),
    undoable: false,
    enabled: ctx => (ctx.redoDepth() === 0 ? 'nothing to redo' : true),
    run: ctx => {
      ctx.redo()
      return okResult()
    },
  }),
  spec({
    id: 'delete_selected',
    label: 'Delete selection',
    params: noParams(),
    run: ctx => {
      ctx.deleteSelected()
      return okResult()
    },
  }),
  spec({
    id: 'cancel_edit',
    label: 'Cancel edit',
    params: noParams(),
    undoable: false,
    run: ctx => {
      ctx.cancelEdit()
      return okResult()
    },
  }),
  spec({
    id: 'export_assembly',
    label: 'Export assembly',
    params: noParams(),
    undoable: false,
    run: ctx => {
      ctx.openExport()
      return okResult()
    },
  }),
  spec({
    id: 'insert_part_instance',
    label: 'Insert part',
    params: noParams(),
    undoable: false,
    run: ctx => {
      ctx.openInsertPart()
      return okResult()
    },
  }),
  spec({
    id: 'add_part',
    label: 'Add part',
    params: objectParams({ docId: Field.string(), docRev: Field.number() }),
    run: (ctx, params) => {
      ctx.runOperation('add_part', params)
      return okResult()
    },
  }),
  spec({
    id: 'duplicate_part',
    label: 'Duplicate part',
    params: valueParam(Field.string()),
    run: (ctx, handle) => {
      ctx.runOperation('duplicate_part', handle)
      return okResult()
    },
  }),
  spec({
    id: 'delete_part',
    label: 'Delete part',
    params: valueParam(Field.string()),
    run: (ctx, handle) => {
      ctx.deleteSubject({ kind: 'part', handle })
      return okResult()
    },
  }),
  spec({
    id: 'set_part_visible',
    label: 'Set part visibility',
    params: objectParams({ handle: Field.string(), visible: Field.boolean() }),
    run: (ctx, params) => {
      ctx.runOperation('set_part_visible', params)
      return okResult()
    },
  }),
  spec({
    id: 'set_builtin_visible',
    label: 'Set builtin visibility',
    params: objectParams({ id: Field.string(), visible: Field.boolean() }),
    run: (ctx, params) => {
      ctx.runOperation('set_builtin_visible', params)
      return okResult()
    },
  }),
  spec({
    id: 'set_part_fixed',
    label: 'Fix part',
    params: objectParams({ handle: Field.string(), fixed: Field.boolean() }),
    run: (ctx, params) => {
      ctx.runOperation('set_part_fixed', params)
      return okResult()
    },
  }),
  spec({
    id: 'set_part_fixed_oneshot',
    label: 'Fix part (one-shot)',
    params: objectParams({ handle: Field.string(), fixed: Field.boolean() }),
    run: (ctx, params) => {
      ctx.runOperation('set_part_fixed_oneshot', params)
      return okResult()
    },
  }),
  spec({
    id: 'set_part_position',
    label: 'Set part position',
    params: objectParams({
      handle: Field.string(),
      pos: Field.object({ tx: Field.number(), ty: Field.number(), tz: Field.number() }),
    }),
    run: (ctx, params) => {
      ctx.runOperation('set_part_position', params)
      return okResult()
    },
  }),
  spec({
    id: 'set_part_rotation',
    label: 'Set part rotation',
    params: objectParams({
      handle: Field.string(),
      euler: Field.object({ rx: Field.number(), ry: Field.number(), rz: Field.number() }),
    }),
    run: (ctx, params) => {
      ctx.runOperation('set_part_rotation', params)
      return okResult()
    },
  }),
  spec({
    id: 'delete_mate',
    label: 'Delete mate',
    params: valueParam(Field.string()),
    run: (ctx, featureId) => {
      ctx.deleteSubject({ kind: 'mate', id: featureId })
      return okResult()
    },
  }),
  spec({
    id: 'update_mate',
    label: 'Update mate',
    params: objectParams({ id: Field.string(), patch: matePatchField }),
    run: (ctx, params) => {
      ctx.runOperation('update_mate', params)
      return okResult()
    },
  }),
  spec({
    id: 'reorder_part',
    label: 'Reorder part',
    params: objectParams({ movingHandle: Field.string(), beforeHandle: Field.nullableString() }),
    run: (ctx, params) => {
      ctx.runOperation('reorder_part', params)
      return okResult()
    },
  }),
  spec({
    id: 'reorder_mate',
    label: 'Reorder mate',
    params: objectParams({ movingId: Field.string(), beforeId: Field.nullableString() }),
    run: (ctx, params) => {
      ctx.runOperation('reorder_mate', params)
      return okResult()
    },
  }),
  spec({
    id: 'rename_mate',
    label: 'Rename mate',
    params: objectParams({ id: Field.string(), label: Field.nullableString() }),
    run: (ctx, params) => {
      ctx.runOperation('rename_mate', { id: params.id, label: params.label ?? undefined })
      return okResult()
    },
  }),
  ...MATE_INSERT_SPECS,
]
