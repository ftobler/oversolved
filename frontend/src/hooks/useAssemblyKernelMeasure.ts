// The assembly's kernel readout: the cells the bundle adapter cannot answer
// analytically (a spline length, a freeform face area, an instance volume, an
// instance clearance).
//
// The anchor solver holds meshes only, so the request goes to the OCC worker
// with the parts and solved poses it must rebuild and place. That makes the
// request self-describing: the key below names the selection, the poses and the
// workspace revision, and `useKernelAsk` drops a reply whose key the selection
// has moved past. Nothing here writes the document or records undo.
import { useMemo } from 'react'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { workspaceStoreRevision } from '@/workspace/storeEvents'
import { fileIdsMissingFromWorker } from '@/kernel/worker/workerFiles'
import { getFileRegistry } from '@/persistence/fileRegistry'
import { resolveFilesSessionFirst } from '@/persistence/fileRegistry/resolve'
import { measureAssemblyViaWorker, type MeasureReply } from '@/kernel/worker/solverClient'
import { partInstances } from '@/utils/assemblyMutations'
import { collectExportFileIds, loadPartContents, buildPlacedPartSpecs } from '@/utils/assemblyExport'
import type { AssemblyDoc, PartInstance, Transform3D } from '@/types/cad'
import type { MeasureAssemblyPick } from '@/kernel/worker/solverProtocol'
import type { AssemblyMeasureAsk } from '@/utils/assemblyMeasurements'
import { formatKernelReadout, type KernelMeasureState } from './useKernelMeasure'
import { useKernelAsk } from './useKernelAsk'

function picksKey(picks: readonly MeasureAssemblyPick[]): string {
  return picks
    .map((pick) => (pick.kind === 'body'
      ? `${pick.handle}/body`
      : `${pick.handle}/${pick.partIndex}/${pick.kind}/${pick.index}`))
    .join(',')
}

/**
 * A pose as a key fragment. Rounded because the key must change when the part
 * moves, not on every floating-point wobble a solve leaves behind.
 */
function poseKey(t: Transform3D | undefined): string {
  if (!t) return '-'
  const round = (v: number) => v.toFixed(6)
  return [t.tx, t.ty, t.tz, t.qx, t.qy, t.qz, t.qw].map(round).join(',')
}

/**
 * Ask the OCC worker for one assembly kernel cell. `ask` is the pure core's
 * question (null when the bundle's analytic facts answered), `doc` the document
 * whose instances the picks name and `drawn` the settled poses the viewport
 * draws.
 */
export function useAssemblyKernelMeasure(
  ask: AssemblyMeasureAsk | null,
  doc: AssemblyDoc | null,
  drawn: Readonly<Record<string, Transform3D>>,
): KernelMeasureState {
  // Only the instances the picks name are rebuilt; a clearance between two
  // parts has no business rebuilding the other fifty.
  const instances = useMemo<PartInstance[]>(() => {
    if (ask === null) return []
    const wanted = new Set(ask.picks.map((pick) => pick.handle))
    return partInstances(doc).filter((instance) => wanted.has(instance.handle))
  }, [ask, doc])

  const resolvable = ask !== null && doc !== null && instances.length === new Set(ask.picks.map(p => p.handle)).size

  const key = !resolvable || ask === null
    ? null
    : [
        ask.op,
        picksKey(ask.picks),
        instances.map((instance) => `${instance.handle}@${poseKey(drawn[instance.handle])}`).join(';'),
        instances.map((instance) => `${instance.doc_id}:${instance.doc_rev}`).join(','),
        String(workspaceStoreRevision()),
      ].join('|')

  const request = ask === null || !resolvable || doc === null
    ? null
    : async (): Promise<MeasureReply | null> => {
        const contents = await loadPartContents(instances)
        // A missing part's content names no geometry to build; refusing reads
        // nothing rather than measuring whichever instances happened to load.
        const parts = buildPlacedPartSpecs(instances, drawn, contents)
        if (parts.length !== instances.length) return null
        const session = useWorkspaceSessionStore.getState().session
        const fileIds = fileIdsMissingFromWorker(collectExportFileIds(parts))
        const files = fileIds.length
          ? await resolveFilesSessionFirst(session, getFileRegistry(), fileIds)
          : undefined
        return measureAssemblyViaWorker(
          parts.map(({ handle, spec, transform }) => ({ handle, spec, transform })),
          ask.op,
          ask.picks,
          files,
        )
      }

  return useKernelAsk(key, request, (reply) => (ask === null ? [] : formatKernelReadout(ask.op, reply, 'mm')))
}
