import type { EntryMeta, WorkspaceEntry, WorkspaceTree } from './types'
import { IdbCarrier } from './idbCarrier'
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
  readEntry(entry: string): Promise<WorkspaceEntry>
  writeEntry(entry: WorkspaceEntry): Promise<void>
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
    readEntry: entry => store.readEntry(workspace, entry),
    writeEntry: entry => store.writeEntry(workspace, entry),
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
