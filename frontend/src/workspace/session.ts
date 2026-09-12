import type { EntryMeta, ProvenanceRecord, WorkspaceEntry, WorkspaceTree } from './types'
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
  open(): Promise<WorkspaceTree>
  listEntries(opts?: { includeTrashed?: boolean }): Promise<EntryMeta[]>
  // The checkpoint rev per entry, so U2 can derive a per-entry dirty dot by
  // comparing it with the working copy's rev (R3). A pure read.
  savedRevs(): Promise<Map<string, number>>
  readEntry(entry: string): Promise<WorkspaceEntry>
  writeEntry(entry: WorkspaceEntry): Promise<void>
  // The provenance record an entry was imported as, the C6 seam. C4 only reads
  // the opaque origin string; C6 fills in rev, hash and status.
  originOf(entry: string): Promise<ProvenanceRecord | undefined>
  resolveFile(fileId: string): Promise<Uint8Array | undefined>
  referencesOf(entry: string): Promise<string[]>
}

export function createWorkspaceSession(
  workspace: string,
  store: WorkspaceStore = getWorkspaceStore(),
): WorkspaceSession {
  return {
    workspace,
    open: async () => (await store.open(workspace)).tree,
    listEntries: opts => store.listEntries(workspace, opts),
    savedRevs: async () => new Map((await savedEntryRecords(workspace)).map(record => [record.id, record.rev])),
    readEntry: entry => store.readEntry(workspace, entry),
    writeEntry: entry => store.writeEntry(workspace, entry),
    originOf: async entry => {
      const meta = await readWorkspaceMeta(workspace)
      return meta?.provenance.find(record => record.entry === entry)
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
  }
}
