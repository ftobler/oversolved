import type { EntryMeta, WorkspaceEntry, WorkspaceTree } from './types'

// Live entries only by default; C2's two-level trash needs metadata for
// trashed entries too, so the option widens the seam without changing the
// default contract.
export interface ListOptions {
  includeTrashed?: boolean
}

// The seam C2's IdbCarrier and C3's DirectoryCarrier/ZipCarrier implement. It
// is fixed at C0 so those implementations slot in without a signature change.
export interface WorkspaceCarrier {
  open(): Promise<WorkspaceTree>
  save(tree: WorkspaceTree): Promise<void>
  list(options?: ListOptions): Promise<EntryMeta[]>
  read(id: string): Promise<WorkspaceEntry>
  write(entry: WorkspaceEntry): Promise<void>
  add(entry: WorkspaceEntry): Promise<void>
  remove(id: string): Promise<void>
  clone(id: string, name?: string): Promise<string>
}
