import * as React from 'react'
import ExportDialog from '@/components/dialogs/ExportDialog'
import ShareDialog from '@/components/dialogs/ShareDialog'
import type { ExportFormat } from '@/components/dialogs/ExportDialog'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useNotify } from '@/contexts/ToastContext'
import { exportViaWorker } from '@/kernel/worker/solverClient'
import { BUILTIN_FEATURE_IDS } from '@/hooks/useDocumentState'

interface PartExportImportProps {
  uuid: string
  docName: string | null
  ownerUsername: string | null
  permission: string | null
}

export interface PartExportImportHandle {
  openExport: (bodyId?: string | null, defaultName?: string) => void
  openShare: () => void
}

const PartExportImport = React.forwardRef<PartExportImportHandle, PartExportImportProps>(
  function PartExportImport({ uuid, docName, ownerUsername, permission }, ref) {
    const doc = usePartEditorStore(s => s.doc)
    const notify = useNotify()

    const [exportDialogOpen, setExportDialogOpen] = React.useState(false)
    const [exportTargetBodyId, setExportTargetBodyId] = React.useState<string | null>(null)
    const [exportDefaultName, setExportDefaultName] = React.useState('export')
    const [shareDocOpen, setShareDocOpen] = React.useState(false)

    React.useImperativeHandle(ref, () => ({
      openExport: (bodyId, defaultName) => {
        setExportTargetBodyId(bodyId ?? null)
        setExportDefaultName(defaultName ?? 'export')
        setExportDialogOpen(true)
      },
      openShare: () => setShareDocOpen(true),
    }))

    const handleExportDownload = async (format: ExportFormat, tessellation: number) => {
      if (!doc?.features) return
      // Export runs entirely in the WASM kernel (the same builder that solves the
      // doc), so it works offline / zero-backend with no network round-trip. The
      // Worker rebuilds the document, resolves the export shape (single body or a
      // compound of the whole assembly), and serialises it to STEP/STL bytes.
      const features = doc.features.filter(f => !BUILTIN_FEATURE_IDS.has(f.id))
      const spec = { ...doc, ...(uuid ? { id: uuid } : {}), features }
      try {
        const bytes = await exportViaWorker(spec, {
          format,
          bodyId: exportTargetBodyId,
          tessellation,
        })
        if (!bytes) {
          notify('Export failed: no solid geometry to export', 'error')
          return
        }
        const mime = format === 'step' ? 'application/step' : 'model/stl'
        const filename = `${exportDefaultName}.${format}`
        const blob = new Blob([bytes as BlobPart], { type: mime })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)
      } catch (e) {
        console.error('Export error:', e)
        notify(`Export error: ${e instanceof Error ? e.message : e}`, 'error')
      } finally {
        setExportTargetBodyId(null)
        setExportDialogOpen(false)
      }
    }

    return (
      <>
        <ExportDialog
          isOpen={exportDialogOpen}
          defaultName={exportDefaultName}
          onDownload={handleExportDownload}
          onCancel={() => {
            setExportTargetBodyId(null)
            setExportDialogOpen(false)
          }}
        />
        <ShareDialog
          isOpen={shareDocOpen}
          documentUuid={uuid}
          documentName={docName || 'Untitled'}
          ownerUsername={ownerUsername || ''}
          isOwner={permission === 'owner'}
          onClose={() => setShareDocOpen(false)}
        />
      </>
    )
  }
)

export default PartExportImport
