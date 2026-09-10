import type { MateKind } from '@/types/cad'
import { MATE_KINDS } from '@/utils/mateKinds'
import type { AssemblySubject } from '@/utils/assemblySelection'
import type { AssemblyOperationId } from '@/utils/assemblyOperations'
import type { CommandEntry } from '@/pages/hooks/useCommandRegistration'

/**
 * The canonical assembly command list. Names are strings so a tree row can
 * carry its subject as a payload through `executeCommand(name, payload)`.
 */
export const ASSEMBLY_COMMAND_NAMES = [
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
  ...MATE_KINDS.map(k => `insert_mate_${k}`),
] as const

export type AssemblyCommandName = typeof ASSEMBLY_COMMAND_NAMES[number]

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

export type AssemblyCommandHandlers = Record<AssemblyCommandName, (payload?: unknown) => void>

export function buildAssemblyCommandEntries(handlers: AssemblyCommandHandlers): CommandEntry[] {
  return ASSEMBLY_COMMAND_NAMES.map(name => ({ name, fn: handlers[name] }))
}

export function insertMateCommand(kind: MateKind): AssemblyCommandName {
  return `insert_mate_${kind}`
}

/**
 * The page's inputs for the command table. Every document mutation is expressed
 * here as `runOperation`, so the wiring from command name to operation is in one
 * place and a test can execute the handlers and observe which operations fired.
 * The delete commands are the exception: they hand off to the store's one
 * `deleteSubject`, which runs the delete operation cell itself, so the [Delete]
 * key and the tree rows cannot drift. The remaining deps are the UI side effects
 * (open the picker/export, open a fresh mate's editor) and the id minting.
 */
export interface AssemblyHandlerDeps {
  runOperation: (id: AssemblyOperationId, payload: unknown) => void
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
}

// The single wiring from command name to mutation. `delete_*` hand off to the
// store's one delete action (which runs the delete operation cell) and the
// `insert_mate_*` commands open the new mate's editor; every other mutating
// command is a direct runOperation call.
export function buildAssemblyHandlers(deps: AssemblyHandlerDeps): AssemblyCommandHandlers {
  return {
    undo: deps.undo,
    redo: deps.redo,
    delete_selected: deps.deleteSelected,
    cancel_edit: deps.cancelEdit,
    export_assembly: deps.openExport,
    insert_part_instance: deps.openInsertPart,
    add_part: (payload) => deps.runOperation('add_part', payload),
    duplicate_part: (payload) => deps.runOperation('duplicate_part', payload),
    set_part_visible: (payload) => deps.runOperation('set_part_visible', payload),
    set_builtin_visible: (payload) => deps.runOperation('set_builtin_visible', payload),
    set_part_fixed: (payload) => deps.runOperation('set_part_fixed', payload),
    set_part_fixed_oneshot: (payload) => deps.runOperation('set_part_fixed_oneshot', payload),
    set_part_position: (payload) => deps.runOperation('set_part_position', payload),
    set_part_rotation: (payload) => deps.runOperation('set_part_rotation', payload),
    update_mate: (payload) => deps.runOperation('update_mate', payload),
    reorder_part: (payload) => deps.runOperation('reorder_part', payload),
    reorder_mate: (payload) => deps.runOperation('reorder_mate', payload),
    rename_mate: (payload) => deps.runOperation('rename_mate', payload),
    delete_part: (payload) => deps.deleteSubject({ kind: 'part', handle: payload as string }),
    delete_mate: (payload) => deps.deleteSubject({ kind: 'mate', id: payload as string }),
    ...Object.fromEntries(MATE_KINDS.map(kind => [insertMateCommand(kind), () => {
      const id = deps.mintMateId()
      deps.closeOpenEditor()
      deps.runOperation('add_mate', { kind, id })
      deps.onMateInserted(id, kind)
    }])),
  }
}
