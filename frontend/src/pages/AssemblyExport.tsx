import { forwardRef, useImperativeHandle, useState } from 'react'
import ExportDialog from '@/components/dialogs/ExportDialog'
import type { ExportFormat } from '@/components/dialogs/ExportDialog'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { useNotify } from '@/contexts/ToastContext'
import { exportAssemblyViaWorker } from '@/kernel/worker/solverClient'
import { fileIdsMissingFromWorker } from '@/kernel/worker/workerFiles'
import { getFileRegistry } from '@/stores/fileRegistry'
import { resolveFiles } from '@/stores/fileRegistry/resolve'
import { downloadBlob } from '@/utils/core/downloadBlob'
import { assemblyStlBytes, buildExportParts, collectExportFileIds, exportableInstances, loadPartContents } from '@/utils/assemblyExport'
import type { AssemblyDoc } from '@/types/cad'

export interface AssemblyExportHandle {
  openExport: () => void
}

interface AssemblyExportProps {
  doc: AssemblyDoc | null
  docName: string | null
}

/**
 * The assembly's export dialog. STEP rehydrates every part's B-rep on the OCC
 * worker and compounds the placed solids; STL re-encodes the solved bundle
 * meshes in place. See `utils/assemblyExport.ts` for why the two paths differ.
 */
const AssemblyExport = forwardRef<AssemblyExportHandle, AssemblyExportProps>(
  function AssemblyExport({ doc, docName }, ref) {
    const notify = useNotify()
    const [isOpen, setIsOpen] = useState(false)

    useImperativeHandle(ref, () => ({ openExport: () => setIsOpen(true) }))

    const handleDownload = async (format: ExportFormat, tessellation: number, fileName: string) => {
      if (!doc) return
      if (format === 'yaml') {
        // The dialog hides YAML for assemblies; guard the worker path anyway.
        notify('Export failed: YAML is not supported for assemblies', 'error')
        setIsOpen(false)
        return
      }
      const instances = exportableInstances(doc)
      if (instances.length === 0) {
        notify('Export failed: the assembly has no visible parts', 'error')
        setIsOpen(false)
        return
      }
      try {
        const poses = useAssemblyStore.getState().settledPoses()
        let bytes: Uint8Array | null
        if (format === 'stl') {
          bytes = assemblyStlBytes(useAssemblyStore.getState().bodies, instances)
        } else {
          const parts = buildExportParts(instances, poses, await loadPartContents(instances))
          const fileIds = fileIdsMissingFromWorker(collectExportFileIds(parts))
          const files = fileIds.length ? await resolveFiles(getFileRegistry(), fileIds) : undefined
          bytes = await exportAssemblyViaWorker(parts, { format, tessellation }, files)
        }
        if (!bytes) {
          notify('Export failed: no solid geometry to export', 'error')
          return
        }
        const mime = format === 'step' ? 'application/step' : 'model/stl'
        const name = fileName || `${docName || 'assembly'}.${format}`
        downloadBlob(new Blob([bytes as BlobPart], { type: mime }), name)
      } catch (e) {
        console.error('Assembly export error:', e)
        notify(`Export error: ${e instanceof Error ? e.message : e}`, 'error')
      } finally {
        setIsOpen(false)
      }
    }

    return (
      <ExportDialog
        isOpen={isOpen}
        defaultName={docName || 'assembly'}
        showTessellation={false}
        showYaml={false}
        onDownload={handleDownload}
        onCancel={() => setIsOpen(false)}
      />
    )
  }
)

export default AssemblyExport
