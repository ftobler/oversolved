import * as React from 'react'
import ExportDialog from '@/components/dialogs/ExportDialog'
import ShareDialog from '@/components/dialogs/ShareDialog'
import type { ExportFormat } from '@/components/dialogs/ExportDialog'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useNotify } from '@/contexts/ToastContext'
import { http, HttpError } from '@/utils/core/httpClient'

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
      const endpoint = format === 'step' ? '/api/export/step' : '/api/export/stl'
      const body: Record<string, unknown> = { features: doc.features }
      if (exportTargetBodyId) body.body_id = exportTargetBodyId
      if (format === 'stl') {
        body.deflection = tessellation * 2
        body.angular_deflection = tessellation * 0.6
      }
      try {
        const blob = await http.postBlob(endpoint, body)
        const filename = format === 'step' ? `${exportDefaultName}.step` : `${exportDefaultName}.stl`
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)
      } catch (e) {
        if (e instanceof HttpError) {
          console.error('Export failed:', e.status, e.body)
          notify(`Export failed: ${e.body}`, 'error')
        } else {
          console.error('Export error:', e)
          notify(`Export error: ${e}`, 'error')
        }
      }
      setExportTargetBodyId(null)
      setExportDialogOpen(false)
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
