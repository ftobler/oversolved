import { DirectoryCarrier, type ReconcileReport } from './directoryCarrier'
import { ZipCarrier } from './zipCarrier'
import type { WorkspaceEntry, WorkspaceTree } from './types'
import type { WorkspaceMetaRecord } from './idbCarrier'
import {
  reopenWorkspaceHandle,
  reopenWorkspaceZipHandle,
  restoreWorkspaceHandle,
  restoreWorkspaceZipHandle,
} from './workspaceHandleRegistry'

// The concrete external save target a workspace row names. IDB is always the
// working copy; this is the folder or zip an explicit save writes, and the
// source of the manifest fingerprint the carrier-change check compares.
//
// `resolveCarrierTarget` is where the permission dance lives: `request:false`
// probes (the open path, never prompts) and `request:true` may prompt (the
// user's Reopen click, and a refusal forgets the handle). A null target is not
// an error: the IDB working copy still opens, and the UI offers Reopen.
export interface CarrierTarget {
  kind: 'folder' | 'zip'
  label: string
  openTree(): Promise<WorkspaceTree>
  // One entry's payload, ignoring the trash. Reload materializes the carrier's
  // file bytes through this; an opened tree leaves them lazy.
  readPayload(id: string): Promise<WorkspaceEntry>
  save(tree: WorkspaceTree): Promise<void>
  readManifestFingerprint(): Promise<string | null>
  reconcile?(): Promise<ReconcileReport>
}

export function folderTarget(dir: FileSystemDirectoryHandle): CarrierTarget {
  const carrier = new DirectoryCarrier(dir)
  return {
    kind: 'folder',
    label: dir.name,
    openTree: () => carrier.open(),
    readPayload: id => carrier.readPayload(id),
    save: tree => carrier.save(tree),
    readManifestFingerprint: () => carrier.readManifestFingerprint(),
    reconcile: () => carrier.reconcile(),
  }
}

export function zipTarget(handle: FileSystemFileHandle, bytes: Uint8Array): CarrierTarget {
  const carrier = new ZipCarrier(bytes, handle)
  return {
    kind: 'zip',
    label: handle.name,
    // A zip lives in one file, so every read re-reads it: the bytes captured at
    // resolve time cannot show an external edit.
    openTree: async () => { await carrier.refresh(); return carrier.open() },
    readPayload: async id => { await carrier.refresh(); return carrier.readPayload(id) },
    save: tree => carrier.save(tree),
    readManifestFingerprint: async () => { await carrier.refresh(); return carrier.readManifestFingerprint() },
  }
}

export async function resolveCarrierTarget(
  workspace: string,
  meta: WorkspaceMetaRecord,
  request: boolean,
): Promise<CarrierTarget | null> {
  const kind = meta.carrier?.kind
  if (kind === 'folder') {
    const handle = request
      ? await reopenWorkspaceHandle(workspace)
      : await restoreWorkspaceHandle(workspace)
    return handle ? folderTarget(handle) : null
  }
  if (kind === 'zip') {
    const handle = request
      ? await reopenWorkspaceZipHandle(workspace)
      : await restoreWorkspaceZipHandle(workspace)
    if (!handle) return null
    try {
      const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer())
      return zipTarget(handle, bytes)
    } catch {
      // A truncated or vanished zip is unavailable, not changed: the prompt
      // should offer Reopen, not a reload that cannot succeed.
      return null
    }
  }
  return null
}
