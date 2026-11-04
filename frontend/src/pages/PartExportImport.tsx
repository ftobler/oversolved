import { forwardRef, useState, useImperativeHandle } from 'react'
import { stringify as stringifyYaml } from 'yaml'
import ExportDialog from '@/components/dialogs/ExportDialog'
import type { ExportRequest } from '@/components/dialogs/ExportDialog'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { useNotify } from '@/contexts/ToastContext'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { downloadBlob } from '@/utils/core/downloadBlob'
import { swapExtension } from '@/utils/core/exportFileName'
import { LENGTH_UNIT_NAME, lengthUnitOf } from '@/utils/lengthUnit'
import { EmptyExportError, exportMime, exportPartBytes, partExportSpec, type PartExportOptions } from '@/utils/partExport'
import { planExport, zipExportFiles, type ExportPart, type ExportScope } from '@/utils/exportSelection'
import { isWholeBodySelectionId } from '@/utils/query/selectionId'
import { useEditorState } from '@/hooks/useEditorState'
import { applySetLengthUnit } from '@/utils/yamlMutations'
import type { LengthUnit, PartDoc } from '@/types/cad'

interface PartExportImportProps {
  uuid: string
  // The unit is a document field, so the export dialog hands the pick here and
  // the page records it as the usual `set_length_unit` mutation.
  onSetLengthUnit: (unit: LengthUnit) => void
}

export interface PartExportImportHandle {
  openExport: (bodyId?: string | null, defaultName?: string) => void
}

const PartExportImport = forwardRef<PartExportImportHandle, PartExportImportProps>(
  function PartExportImport({ uuid, onSetLengthUnit }, ref) {
    const doc = usePartEditorStore(s => s.doc)
    const lengthUnit = lengthUnitOf(doc?.length_unit)
    const notify = useNotify()

    const [exportDialogOpen, setExportDialogOpen] = useState(false)
    const [exportDefaultName, setExportDefaultName] = useState('export')
    // Snapshot taken when the dialog opens: the modal covers the parts list and
    // viewport where the user makes the selection, so the dialog must not read
    // the live selection back.
    const [exportParts, setExportParts] = useState<readonly ExportPart[]>([])
    const [exportSelectedIds, setExportSelectedIds] = useState<readonly string[]>([])
    const [exportDefaultScope, setExportDefaultScope] = useState<ExportScope>('all')

    useImperativeHandle(ref, () => ({
      openExport: (bodyId, defaultName) => {
        // The header export is disabled while an edit is open because the
        // document is half authored; the body context menu reaches this same
        // dialog, so it takes the same gate instead of reading the draft.
        if (useEditorState.getState().editingFeatureId !== null) {
          notify('Finish the edit to export')
          return
        }
        const name = defaultName ?? 'export'
        const bodies = usePartEditorStore.getState().bodies
        const labels = usePartEditorStore.getState().partLabels
        const parts: ExportPart[] = Object.keys(bodies).map((id, index) => ({
          id,
          name: labels[id]?.trim() || `part ${index + 1}`,
        }))
        // A body context-menu export can name a body the current solve has not
        // published yet. Keep it as the one available part rather than losing
        // the explicit target.
        if (bodyId && !parts.some(part => part.id === bodyId)) {
          parts.unshift({ id: bodyId, name })
        }
        setExportParts(parts)
        setExportSelectedIds(bodyId ? [bodyId] : selectedBodyIds(useSketchEditorStore.getState().normalSelection, parts))
        setExportDefaultScope(bodyId ? 'selected' : 'all')
        setExportDefaultName(name)
        setExportDialogOpen(true)
      },
    }))

    const handleExportDownload = async ({ format, tessellation, fileName, selection, documentUnit: requestedUnit }: ExportRequest) => {
      if (!doc?.features) return
      // The dialog's pick wins; a caller that does not offer the control passes
      // nothing and the document's own unit is used.
      const unit = requestedUnit ?? lengthUnit
      // A cancel or a failed export must not reinterpret the document behind
      // the dialog, so the pick persists only with the bytes. The download can
      // take seconds, so re-read the live unit: a document swap or an undo
      // during the export must not be overwritten by this stale pick.
      const recordUnit = () => {
        if (unit === lengthUnit) return
        const live = usePartEditorStore.getState().doc
        if (!live?.features || lengthUnitOf(live.length_unit) !== lengthUnit) {
          // The unit moved during the download (an undo, a document swap), so
          // applying this stale pick would overwrite a newer decision.
          notify('Document unit unchanged: the document changed during the export')
          return
        }
        onSetLengthUnit(unit)
        notify(`Document unit set to ${LENGTH_UNIT_NAME[unit]}`, 'success')
      }
      // The YAML source is the document itself, so it needs no kernel round-trip
      // and no geometry: serialise the in-memory doc exactly as `saveDoc` stores
      // it, builtins included, so the file re-imports as the same document.
      if (format === 'yaml') {
        try {
          const blob = new Blob([stringifyYaml(doc)], { type: 'application/yaml' })
          downloadBlob(blob, fileName || `${exportDefaultName}.yaml`)
        } catch (e) {
          console.error('Export error:', e)
          notify(`Export error: ${e instanceof Error ? e.message : e}`, 'error')
        } finally {
          setExportDialogOpen(false)
        }
        return
      }
      // Export runs entirely in the WASM kernel (the same builder that solves the
      // doc). The Worker rebuilds the document, resolves the export shape (the
      // chosen bodies, or the compound of the whole part), and serialises it to
      // STEP/STL bytes. The build spec carries the picked unit, so the bytes are
      // right even though the document is only updated once the download lands.
      const spec = partExportSpec(withLengthUnit(doc, unit) as Record<string, unknown>, uuid)
      const plan = exportParts.length > 0
        ? planExport(exportParts, selection, format, fileName)
        : [{ name: fileName, partIds: [] }]
      if (plan.length === 0) {
        notify('Export failed: no parts selected', 'error')
        setExportDialogOpen(false)
        return
      }
      try {
        const session = useWorkspaceSessionStore.getState().session
        // Consolidated All Parts keeps the pre-existing whole-document path:
        // the parts list mirrors the current rollback/preview solve, while a
        // document export covers the authored document. The explicit id path
        // is reserved for a narrower selected set and for per-part zip entries.
        const wholeDocument = selection.scope === 'all' && selection.bundle !== 'zip'
        const bytesFor = (partIds: readonly string[]) =>
          exportPartBytes(spec, exportOptions(format, tessellation, partIds, wholeDocument), session)

        if (selection.bundle === 'zip' && exportParts.length > 0) {
          // A zip needs one body id per entry, so it follows the parts list
          // above rather than the whole-document path.
          const files = await Promise.all(plan.map(async entry => ({
            name: entry.name,
            bytes: await bytesFor(entry.partIds),
          })))
          const zip = await zipExportFiles(files)
          downloadBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), swapExtension(fileName, 'zip'))
        } else {
          const bytes = await bytesFor(plan[0].partIds)
          downloadBlob(new Blob([bytes as BlobPart], { type: exportMime(format) }), plan[0].name)
        }
        recordUnit()
      } catch (e) {
        if (e instanceof EmptyExportError) {
          notify(`Export failed: ${e.message}`, 'error')
          return
        }
        console.error('Export error:', e)
        notify(`Export error: ${e instanceof Error ? e.message : e}`, 'error')
      } finally {
        setExportDialogOpen(false)
      }
    }

    return (
      <ExportDialog
        isOpen={exportDialogOpen}
        defaultName={exportDefaultName}
        parts={exportParts.length > 0 ? exportParts : undefined}
        selectedPartIds={exportSelectedIds}
        defaultScope={exportDefaultScope}
        documentUnit={lengthUnit}
        onDownload={handleExportDownload}
        onCancel={() => setExportDialogOpen(false)}
      />
    )
  }
)

/** The body ids the document had selected, in the parts list's order. Face and
 *  edge picks name geometry inside a body, not the body itself, so only a plain
 *  `@<bodyId>` entry counts. */
function selectedBodyIds(
  selection: ReadonlySet<string>,
  parts: readonly ExportPart[],
): string[] {
  const selected = new Set<string>()
  for (const id of selection) {
    if (isWholeBodySelectionId(id)) selected.add(id.slice(1))
  }
  return parts.filter(part => selected.has(part.id)).map(part => part.id)
}

function exportOptions(
  format: 'step' | 'stl',
  tessellation: PartExportOptions['tessellation'],
  partIds: readonly string[],
  wholeDocument: boolean,
): PartExportOptions {
  if (wholeDocument || partIds.length === 0) return { format, bodyId: null, tessellation }
  if (partIds.length === 1) return { format, bodyId: partIds[0], tessellation }
  return { format, bodyId: null, bodyIds: [...partIds], tessellation }
}

/** The export spec's unit, on a clone so the live document keeps meaning what
 *  it meant until the download succeeds. */
function withLengthUnit(doc: PartDoc, unit: LengthUnit): PartDoc {
  const spec: PartDoc = { ...doc }
  applySetLengthUnit(spec, unit)
  return spec
}

export default PartExportImport
