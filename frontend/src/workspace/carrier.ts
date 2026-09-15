import type { EntryMeta, WorkspaceEntry, WorkspaceTree } from './types'

// Live entries only by default; C2's two-level trash needs metadata for
// trashed entries too, so the option widens the seam without changing the
// default contract.
export interface ListOptions {
  includeTrashed?: boolean
}

// The permanent store's seam: entry-level reads and writes over one workspace.
// IdbCarrier is the store; MemoryCarrier is the conformer written from this
// interface rather than ported from IndexedDB, which is what keeps the seam
// honest. A folder and an archive do not implement it -- they move a whole tree
// at a time, in one gesture, and nothing writes an entry into one.
export interface WorkspaceCarrier {
  open(): Promise<WorkspaceTree>
  save(tree: WorkspaceTree): Promise<void>
  list(options?: ListOptions): Promise<EntryMeta[]>
  read(id: string): Promise<WorkspaceEntry>
  write(entry: WorkspaceEntry): Promise<void>
  add(entry: WorkspaceEntry): Promise<void>
  remove(id: string): Promise<void>
  restore(id: string): Promise<void>
  clone(id: string, name?: string): Promise<string>
}
