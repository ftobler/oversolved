import type { CommandContext, ErasedCommandSpec } from '@/utils/core/commandSpec'
import { PART_COMMAND_SPECS } from '@/pages/commandEntries'
import { ASSEMBLY_COMMAND_SPECS } from '@/pages/assemblyCommandEntries'

// The Registry page's command table and the docs block derive from the same
// spec tables the editors register, so neither can advertise a command the app
// does not run. Same drift-guard shape as keybindingRows.ts.

/** Which editor(s) register the command; the three shared names are 'both'. */
export type CommandEditor = 'sketch/part' | 'assembly' | 'both'

export interface CommandRow {
  id: string
  label: string
  // Canonical key string, or an empty string when the command has no shortcut.
  shortcut: string
  undoable: boolean
  editor: CommandEditor
}

function rowFromSpec<Ctx extends CommandContext>(spec: ErasedCommandSpec<Ctx>, editor: CommandEditor): CommandRow {
  return {
    id: spec.id,
    label: spec.label,
    shortcut: spec.shortcut ?? '',
    undoable: spec.undoable,
    editor,
  }
}

export function buildCommandRows(): CommandRow[] {
  const rows = new Map<string, CommandRow>()
  for (const spec of PART_COMMAND_SPECS) rows.set(spec.id, rowFromSpec(spec, 'sketch/part'))
  for (const spec of ASSEMBLY_COMMAND_SPECS) {
    const existing = rows.get(spec.id)
    if (existing) {
      // undo/redo/delete_selected are registered by both editors; the row
      // names both rather than picking one editor's wording.
      rows.set(spec.id, { ...existing, editor: 'both', undoable: existing.undoable || spec.undoable })
      continue
    }
    rows.set(spec.id, rowFromSpec(spec, 'assembly'))
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export const COMMAND_TABLE_START = '<!-- command-table:start -->'
export const COMMAND_TABLE_END = '<!-- command-table:end -->'

export const EDITOR_LABEL: Readonly<Record<CommandEditor, string>> = {
  'sketch/part': 'sketch/part',
  assembly: 'assembly',
  both: 'any',
}

/** The markdown block docs/command_system.md checks in between the markers. */
export function renderCommandTable(): string {
  const lines = [
    COMMAND_TABLE_START,
    '',
    '| Command | Label | Shortcut | Undo | Editor |',
    '|---|---|---|---|---|',
    ...buildCommandRows().map(row => [
      `| \`${row.id}\``,
      row.label,
      row.shortcut ? `\`${row.shortcut}\`` : '-',
      row.undoable ? 'yes' : 'no',
      `${EDITOR_LABEL[row.editor]} |`,
    ].join(' | ')),
    '',
    COMMAND_TABLE_END,
  ]
  return lines.join('\n')
}

/**
 * Replaces the marker-delimited block in a docs file's text with `block`.
 * Returns null when either marker is missing, so the caller can report the
 * drift instead of silently appending a second table.
 */
export function replaceCommandTable(docs: string, block: string): string | null {
  const start = docs.indexOf(COMMAND_TABLE_START)
  const end = docs.indexOf(COMMAND_TABLE_END)
  if (start < 0 || end < start) return null
  return docs.slice(0, start) + block + docs.slice(end + COMMAND_TABLE_END.length)
}

/** The checked-in block, or null when the markers are missing. */
export function extractCommandTable(docs: string): string | null {
  const start = docs.indexOf(COMMAND_TABLE_START)
  const end = docs.indexOf(COMMAND_TABLE_END)
  if (start < 0 || end < start) return null
  return docs.slice(start, end + COMMAND_TABLE_END.length)
}
