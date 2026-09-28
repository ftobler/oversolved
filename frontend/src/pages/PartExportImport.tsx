import { forwardRef, useState, useImperativeHandle } from 'react'
import { stringify as stringifyYaml } from 'yaml'
import ExportDialog from '@/components/dialogs/ExportDialog'
import type { ExportFormat } from '@/components/dialogs/ExportDialog'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useNotify } from '@/contexts/ToastContext'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { downloadBlob } from '@/utils/core/downloadBlob'
import { EmptyExportError, exportMime, exportPartBytes, partExportSpec } from '@/utils/partExport'

interface PartExportImportProps {
  uuid: string
}

export interface PartExportImportHandle {
  openExport: (bodyId?: string | null, defaultName?: string) => void
}

const PartExportImport = forwardRef<PartExportImportHandle, PartExportImportProps>(
  function PartExportImport({ uuid }, ref) {
    const doc = usePartEditorStore(s => s.doc)
    const notify = useNotify()

    const [exportDialogOpen, setExportDialogOpen] = useState(false)
    const [exportTargetBodyId, setExportTargetBodyId] = useState<string | null>(null)
    const [exportDefaultName, setExportDefaultName] = useState('export')

    useImperativeHandle(ref, () => ({
      openExport: (bodyId, defaultName) => {
        setExportTargetBodyId(bodyId ?? null)
        setExportDefaultName(defaultName ?? 'export')
        setExportDialogOpen(true)
      },
    }))

    const handleExportDownload = async (format: ExportFormat, tessellation: number, fileName: string) => {
      if (!doc?.features) return
      // The YAML source is the document itself, so it needs no kernel round-trip
      // and no geometry: serialise the in-memory doc exactly as `saveDoc` stores
      // it, builtins included, so the file re-imports as the same document. A
      // body selection cannot narrow a feature tree, so it is ignored here.
      if (format === 'yaml') {
        try {
          const blob = new Blob([stringifyYaml(doc)], { type: 'application/yaml' })
          downloadBlob(blob, fileName || `${exportDefaultName}.yaml`)
        } catch (e) {
          console.error('Export error:', e)
          notify(`Export error: ${e instanceof Error ? e.message : e}`, 'error')
        } finally {
          setExportTargetBodyId(null)
          setExportDialogOpen(false)
        }
        return
      }
      // Export runs entirely in the WASM kernel (the same builder that solves the
      // doc). The Worker rebuilds the document, resolves the export shape (single
      // body or a compound of the whole assembly), and serialises it to STEP/STL
      // bytes.
      const spec = partExportSpec(doc as Record<string, unknown>, uuid)
      try {
        const session = useWorkspaceSessionStore.getState().session
        const bytes = await exportPartBytes(spec, {
          format,
          bodyId: exportTargetBodyId,
          tessellation,
        }, session)
        const filename = fileName || `${exportDefaultName}.${format}`
        downloadBlob(new Blob([bytes as BlobPart], { type: exportMime(format) }), filename)
      } catch (e) {
        if (e instanceof EmptyExportError) {
          notify(`Export failed: ${e.message}`, 'error')
          return
        }
        console.error('Export error:', e)
        notify(`Export error: ${e instanceof Error ? e.message : e}`, 'error')
      } finally {
        setExportTargetBodyId(null)
        setExportDialogOpen(false)
      }
    }

    return (
      <ExportDialog
        isOpen={exportDialogOpen}
        defaultName={exportDefaultName}
        onDownload={handleExportDownload}
        onCancel={() => {
          setExportTargetBodyId(null)
          setExportDialogOpen(false)
        }}
      />
    )
  }
)

export default PartExportImport
