import { forwardRef, useImperativeHandle, useState } from 'react'
import ExportDialog from '@/components/dialogs/ExportDialog'
import type { ExportRequest } from '@/components/dialogs/ExportDialog'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { useNotify } from '@/contexts/ToastContext'
import { exportAssemblyViaWorker } from '@/kernel/worker/solverClient'
import { fileIdsMissingFromWorker } from '@/kernel/worker/workerFiles'
import { getFileRegistry } from '@/stores/fileRegistry'
import { resolveFilesSessionFirst } from '@/stores/fileRegistry/resolve'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { downloadBlob } from '@/utils/core/downloadBlob'
import { swapExtension } from '@/utils/core/exportFileName'
import { assemblyStlBytes, buildExportParts, collectExportFileIds, exportableInstances, loadPartContents } from '@/utils/assemblyExport'
import { planExport, zipExportFiles, type ExportPart } from '@/utils/exportSelection'
import type { AssemblyDoc, PartInstance, Transform3D } from '@/types/cad'

// The editor holds the solved poses and meshes, so it offers geometry only; the
// source is what the workspace list's export hands out.
const GEOMETRY_FORMATS = ['step', 'stl'] as const

export interface AssemblyExportHandle {
  openExport: () => void
}

interface AssemblyExportProps {
  doc: AssemblyDoc | null
  docName: string | null
  // Part doc id -> display name, so the parts list names an instance the way the
  // tree does rather than by its raw doc id.
  docNames?: Record<string, string>
}

/**
 * The assembly's export dialog. STEP rehydrates every part's B-rep on the OCC
 * worker and compounds the placed solids; STL re-encodes the solved bundle
 * meshes in place. See `utils/assemblyExport.ts` for why the two paths differ.
 *
 * The parts list lets the user narrow the export to ticked parts, as one file
 * (Everything / Selected) or one file each inside a zip (Each part separately).
 */
const AssemblyExport = forwardRef<AssemblyExportHandle, AssemblyExportProps>(
  function AssemblyExport({ doc, docName, docNames = {} }, ref) {
    const notify = useNotify()
    const [isOpen, setIsOpen] = useState(false)

    useImperativeHandle(ref, () => ({ openExport: () => setIsOpen(true) }))

    const instances = doc ? exportableInstances(doc) : []
    const exportParts: ExportPart[] = instances.map(inst => ({
      id: inst.handle,
      name: docNames[inst.doc_id] || inst.doc_id,
    }))

    const handleDownload = async (request: ExportRequest) => {
      const { format, fileName, selection } = request
      if (!doc) return
      if (format === 'yaml') {
        // The dialog hides YAML for assemblies; guard the worker path anyway.
        notify('Export failed: YAML is not supported for assemblies', 'error')
        setIsOpen(false)
        return
      }
      if (instances.length === 0) {
        notify('Export failed: the assembly has no visible parts', 'error')
        setIsOpen(false)
        return
      }
      const plan = planExport(exportParts, selection, format, fileName)
      if (plan.length === 0) {
        notify('Export failed: no parts selected', 'error')
        setIsOpen(false)
        return
      }
      try {
        const poses = useAssemblyStore.getState().settledPoses()
        const bytesFor = (ids: string[]): Promise<Uint8Array | null> =>
          buildBytes(format, subsetInstances(instances, ids), poses)

        if (selection.mode === 'separate') {
          // Separate mode is one archive, always: a single ticked part still
          // arrives as a one-entry zip rather than a bare file.
          const files = await Promise.all(plan.map(async entry => {
            const bytes = await bytesFor(entry.partIds)
            if (!bytes) throw new EmptyAssemblyError()
            return { name: entry.name, bytes }
          }))
          const zip = await zipExportFiles(files)
          downloadBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), swapExtension(fileName, 'zip'))
        } else {
          // Everything and selected collapse into one file.
          const bytes = await bytesFor(plan[0].partIds)
          if (!bytes) throw new EmptyAssemblyError()
          downloadBlob(new Blob([bytes as BlobPart], { type: exportMime(format) }), plan[0].name)
        }
      } catch (e) {
        if (e instanceof EmptyAssemblyError) {
          notify('Export failed: no solid geometry to export', 'error')
          return
        }
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
        formats={GEOMETRY_FORMATS}
        parts={exportParts.length > 0 ? exportParts : undefined}
        onDownload={handleDownload}
        onCancel={() => setIsOpen(false)}
      />
    )
  }
)

// A no-geometry result is a normal outcome (empty doc, invisible part), not a
// crash; its own type lets the caller word it as such.
class EmptyAssemblyError extends Error {}

function subsetInstances(instances: PartInstance[], ids: string[]): PartInstance[] {
  const wanted = new Set(ids)
  return instances.filter(inst => wanted.has(inst.handle))
}

function exportMime(format: 'step' | 'stl'): string {
  return format === 'step' ? 'application/step' : 'model/stl'
}

/**
 * Serialise a subset of the placed instances. STL re-encodes the solved bundle
 * meshes; STEP rebuilds each part's B-rep on the worker and compounds it.
 */
async function buildBytes(
  format: 'step' | 'stl',
  instances: PartInstance[],
  poses: Record<string, Transform3D>,
): Promise<Uint8Array | null> {
  if (format === 'stl') {
    return assemblyStlBytes(useAssemblyStore.getState().bodies, instances)
  }
  const parts = buildExportParts(instances, poses, await loadPartContents(instances))
  const session = useWorkspaceSessionStore.getState().session
  const fileIds = fileIdsMissingFromWorker(collectExportFileIds(parts))
  const files = fileIds.length ? await resolveFilesSessionFirst(session, getFileRegistry(), fileIds) : undefined
  return exportAssemblyViaWorker(parts, { format }, files)
}

export default AssemblyExport
