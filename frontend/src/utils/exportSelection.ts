// Export "what": which parts a download covers and how they bundle. Pure and
// viewport-free, so the dialog's choices are unit-testable without rendering it
// (the project goal: delete the Viewport and the logic still passes).
//
// Three modes, matching the dialog's radio group:
//   everything: every part in one file (the pre-feature behaviour).
//   selected:   only the ticked parts, still one file.
//   separate:   one file per ticked part, bundled into a single zip.
//
// The caller owns the actual bytes; this module only decides the files, their
// names and which part ids each file carries.

import { buildZipFromEntries } from '@/workspace/zipCarrier'
import { sanitizeBaseName } from '@/utils/core/exportFileName'

export type ExportMode = 'everything' | 'selected' | 'separate'

export interface ExportPart {
  id: string
  name: string
}

export interface ExportSelection {
  mode: ExportMode
  // The ticked ids. Ignored for `everything`, where the whole list is covered.
  selectedIds: string[]
}

export const DEFAULT_EXPORT_SELECTION: ExportSelection = { mode: 'everything', selectedIds: [] }

/** One output file: its name (extension included) and the parts it combines. */
export interface ExportFilePlan {
  name: string
  partIds: string[]
}

/** The parts a selection covers, in the order given. */
export function selectedParts(parts: readonly ExportPart[], selection: ExportSelection): ExportPart[] {
  if (selection.mode === 'everything') return [...parts]
  const ticked = new Set(selection.selectedIds)
  return parts.filter(part => ticked.has(part.id))
}

/** False when a selection mode has nothing ticked: the export button is disabled
 *  rather than writing an empty file or an empty zip. */
export function exportHasOutput(parts: readonly ExportPart[], selection: ExportSelection): boolean {
  return selectedParts(parts, selection).length > 0
}

/**
 * The files an export writes, in the order the parts appear. Everything and
 * selected collapse into one file named `fileName`; separate gives one entry per
 * ticked part, named after the part with a deterministic ` (2)`, ` (3)` suffix on
 * a duplicate, so no entry overwrites another in the zip. An empty selection
 * yields no files (the button is disabled, but the plan stays defined).
 */
export function planExport(
  parts: readonly ExportPart[],
  selection: ExportSelection,
  extension: string,
  fileName: string,
): ExportFilePlan[] {
  const chosen = selectedParts(parts, selection)
  if (chosen.length === 0) return []
  if (selection.mode !== 'separate') {
    return [{ name: fileName, partIds: chosen.map(part => part.id) }]
  }
  const seen = new Map<string, number>()
  return chosen.map(part => {
    const stem = zipEntryStem(part.name)
    const count = (seen.get(stem) ?? 0) + 1
    seen.set(stem, count)
    const suffix = count === 1 ? '' : ` (${count})`
    return { name: `${stem}${suffix}.${extension}`, partIds: [part.id] }
  })
}

/** A part name flattened into a single zip entry: path separators and `..`
 *  would otherwise nest or escape the archive instead of naming one entry. */
function zipEntryStem(name: string): string {
  const flattened = sanitizeBaseName(name).replace(/[\\/]+/g, '_').replace(/\.{2,}/g, '_')
  return flattened.replace(/^\.+/, '') || 'part'
}

/** Bundle one file per part into a single archive, reusing the workspace zip
 *  writer so the bytes are as deterministic as a document export. */
export function zipExportFiles(
  files: readonly { name: string; bytes: Uint8Array }[],
): Promise<Uint8Array> {
  return buildZipFromEntries(files.map(file => ({ path: file.name, data: file.bytes })))
}
