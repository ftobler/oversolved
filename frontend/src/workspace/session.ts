import type { EntryMeta, ProvenanceRecord, ReferenceEdges, WorkspaceEntry } from './types'
import { IdbCarrier, readWorkspaceMeta, savedEntryRecords } from './idbCarrier'
import { getWorkspaceStore, type WorkspaceStore } from './store'
import { getFileRegistry } from '@/stores/fileRegistry'

// A session binds the app to one open workspace, so editors and the solve relay
// read the workspace they are actually in instead of listing every workspace in
// the library. It is the workspace-scoped replacement for the library-wide
// forwarding store: every method answers for one workspace, and a file lookup
// resolves the workspace entry first and C1's flat registry second (bytes a STEP
// import just staged but the workspace has not adopted yet).
export interface WorkspaceSession {
  workspace: string
  listEntries(opts?: { includeTrashed?: boolean }): Promise<EntryMeta[]>
  // The checkpoint rev per entry, so U2 can derive a per-entry dirty dot by
  // comparing it with the working copy's rev (R3). A pure read.
  savedRevs(): Promise<Map<string, number>>
  readEntry(entry: string): Promise<WorkspaceEntry>
  writeEntry(entry: WorkspaceEntry): Promise<void>
  // The provenance record an entry was imported as. C6 stores rev, hash and
  // origin entry id on it; this reads the stored record only and never resolves
  // the origin (I2).
  originOf(entry: string): Promise<ProvenanceRecord | undefined>
  // Every provenance record the workspace holds, one meta read, for U6's panel.
  provenance(): Promise<ProvenanceRecord[]>
  resolveFile(fileId: string): Promise<Uint8Array | undefined>
  referencesOf(entry: string): Promise<string[]>
  // The whole edge map, so where-used inverts one read instead of one read per
  // entry (C5). Main-thread only and never persisted: it is derived from the
  // manifest the session already reads.
  referenceEdges(): Promise<ReferenceEdges>
}

export function createWorkspaceSession(
  workspace: string,
  store: WorkspaceStore = getWorkspaceStore(),
): WorkspaceSession {
  return {
    workspace,
    listEntries: opts => store.listEntries(workspace, opts),
    savedRevs: async () => {
      // The checkpoint rev map rides on the workspace meta, so the common path
      // never reads the saved payloads. A meta from before the map existed falls
      // back to the rows until the next checkpoint stamps it.
      const meta = await readWorkspaceMeta(workspace)
      if (meta?.savedRevs) return new Map(Object.entries(meta.savedRevs))
      return new Map((await savedEntryRecords(workspace)).map(record => [record.id, record.rev]))
    },
    readEntry: entry => store.readEntry(workspace, entry),
    writeEntry: entry => store.writeEntry(workspace, entry),
    originOf: async entry => {
      const meta = await readWorkspaceMeta(workspace)
      return meta?.provenance.find(record => record.entry === entry)
    },
    provenance: async () => {
      const meta = await readWorkspaceMeta(workspace)
      return (meta?.provenance ?? []).map(record => ({ ...record }))
    },
    async resolveFile(fileId: string): Promise<Uint8Array | undefined> {
      try {
        const entry = await store.readEntry(workspace, fileId)
        if (entry.bytes !== undefined) return new Uint8Array(entry.bytes)
      } catch {
        // Not a live workspace file entry: fall through to the staging registry.
      }
      return getFileRegistry().getBytes(fileId)
    },
    referencesOf: entry => new IdbCarrier(workspace).referencesOf(entry),
    referenceEdges: () => new IdbCarrier(workspace).referencesMap(),
  }
}
