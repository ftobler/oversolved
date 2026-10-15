// The machine-readable command catalog: one entry per spec of an editor's
// command table, carrying the spec's metadata plus its param fields, the same
// schema the registry parses a call against and the Registry docs page reads.
// The CLI and the MCP server enumerate the public surface through this, so a
// new command appears on every external surface without a second table.
//
// No spec is run from here and no context store is touched beyond the
// `enabled` verdict the caller supplies: a catalog read is safe on any host.

import type { CommandContext, ErasedCommandSpec } from '@/utils/core/commandSpec'
import type { CommandName } from '@/utils/core/commandNames'

/** One param of a command payload: the field name and its human-readable type. */
export interface CommandCatalogField {
  name: string
  type: string
}

export interface CommandCatalogEntry {
  id: string
  label: string
  shortcut?: string
  undoable: boolean
  params: CommandCatalogField[]
  // true, or the reason the command is disabled in the context the caller
  // evaluated against.
  enabled: true | string
}

/**
 * Build the catalog from an editor's spec table, sorted by id so two runs on
 * the same table produce the same bytes. `enabled` is the registry's live
 * verdict function.
 */
export function commandCatalog<Ctx extends CommandContext>(
  specs: readonly ErasedCommandSpec<Ctx>[],
  enabled: (id: CommandName) => true | string,
): CommandCatalogEntry[] {
  return specs
    .map(spec => ({
      id: spec.id,
      label: spec.label,
      ...(spec.shortcut !== undefined && { shortcut: spec.shortcut }),
      undoable: spec.undoable,
      params: spec.params.fields.map(field => ({ name: field.name, type: field.type })),
      enabled: enabled(spec.id),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}
