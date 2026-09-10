import type { MateKind } from '@/types/cad'
import { MATE_KINDS } from '@/utils/mateKinds'
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
 * (undo/redo/delete_selected/cancel_edit/export/insert_part_instance) are absent:
 * they either touch no document or open a picker before the operation runs.
 * This is the map the coverage test reads, so a new operation without a command
 * fails to be reachable.
 */
export const ASSEMBLY_OPERATION_BY_COMMAND: Readonly<Record<string, AssemblyOperationId>> = {
  add_part: 'add_part',
  duplicate_part: 'duplicate_part',
  delete_part: 'delete_part',
  set_part_visible: 'set_part_visible',
  set_builtin_visible: 'set_builtin_visible',
  set_part_fixed: 'set_part_fixed',
  set_part_fixed_oneshot: 'set_part_fixed_oneshot',
  set_part_position: 'set_part_position',
  set_part_rotation: 'set_part_rotation',
  delete_mate: 'delete_mate',
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
