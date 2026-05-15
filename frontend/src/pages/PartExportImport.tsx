import ExportDialog from '@/components/ExportDialog'
import ShareDialog from '@/components/ShareDialog'
import type { ExportFormat } from '@/components/ExportDialog'

interface PartExportImportProps {
  exportDialogOpen: boolean
  exportDefaultName: string
  handleExportDownload: (format: ExportFormat, tessellation: number) => void
  handleExportCancel: () => void
  shareDocOpen: boolean
  setShareDocOpen: (v: boolean) => void
  uuid: string
  docName: string | null
  ownerUsername: string | null
  permission: string | null
}

export default function PartExportImport({
  exportDialogOpen,
  exportDefaultName,
  handleExportDownload,
  handleExportCancel,
  shareDocOpen,
  setShareDocOpen,
  uuid,
  docName,
  ownerUsername,
  permission,
}: PartExportImportProps) {
  return (
    <>
      <ExportDialog
        isOpen={exportDialogOpen}
        defaultName={exportDefaultName}
        onDownload={handleExportDownload}
        onCancel={handleExportCancel}
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
