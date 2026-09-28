import type { ExportFormat } from '@/components/dialogs/ExportDialog'
import { downloadBlob } from '@/utils/core/downloadBlob'
import { exportMime, exportPartBytes, partExportSpec, partSpecFromText, type FileResolver } from '@/utils/partExport'
import type { EntryMeta, WorkspaceEntry } from '@/workspace/types'

// The workspace list's per-entry export, without React: which formats a row can
// offer, and the download itself once the user picked one.

const PART_FORMATS: readonly ExportFormat[] = ['step', 'stl', 'yaml']

// An assembly offers its source only. Its STEP needs every instance's solved
// pose, and its STL the solved meshes: both live in the assembly editor's mate
// solve, which the list never runs, and exporting at the seed poses would hand
// out a file whose mated parts sit where they were dropped rather than where
// they are drawn. Any other document kind has no geometry to build at all.
const SOURCE_ONLY: readonly ExportFormat[] = ['yaml']

// Null for a file entry: its bytes are the export, so there is nothing to pick.
export function entryExportFormats(entry: EntryMeta): readonly ExportFormat[] | null {
  if (entry.kind === 'file') return null
  return entry.docKind === 'part' ? PART_FORMATS : SOURCE_ONLY
}

export function downloadFileEntry(stored: WorkspaceEntry): void {
  const bytes = stored.bytes ?? new Uint8Array()
  downloadBlob(new Blob([bytes as BlobPart], { type: stored.mime ?? 'application/octet-stream' }), stored.name)
}

// The source is the stored text as is, never a re-serialised parse: what the
// user downloads is exactly what the workspace holds and would re-import as.
// The row's listed meta decides what may be built, not the stored payload: the
// meta is what the dialog offered its formats from.
export async function downloadDocumentEntry(
  entry: EntryMeta,
  text: string,
  format: ExportFormat,
  tessellation: number,
  fileName: string,
  resolver: FileResolver | null,
): Promise<void> {
  if (!entryExportFormats(entry)?.includes(format)) {
    throw new Error(`${entry.name} cannot be exported as ${format.toUpperCase()}`)
  }
  if (format === 'yaml') {
    downloadBlob(new Blob([text], { type: 'application/yaml' }), fileName)
    return
  }
  const spec = partExportSpec(partSpecFromText(text), entry.id)
  const bytes = await exportPartBytes(spec, { format, bodyId: null, tessellation }, resolver)
  downloadBlob(new Blob([bytes as BlobPart], { type: exportMime(format) }), fileName)
}
