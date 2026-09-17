import { getWorkspaceStore, type WorkspaceStore } from '@/workspace/store'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { parseDocKind } from '@/workspace/kinds'
import type { EntryKind } from '@/workspace/types'

// The document-shaped face the editors and the solve relay read, bound to the
// one open workspace. This replaces the C2 library adapter: there is no
// "active library" any more and no translation from a workspace id to its sole
// document. `load(id)` resolves an entry id inside the current workspace, and a
// call with no open workspace throws by name instead of listing every workspace
// in the library.
//
// It is the P2 stopgap for the scoped session: C3's session already carries the
// list/read/write half, and this adapter is what keeps the editors' existing
// seam working while P3 moves the assembly path onto the session directly.

export interface WorkspaceDocSummary {
  uuid: string
  name: string
  kind?: string
  updated_at: string
  meta: { rev: number }
}

// Both kinds travel, spelled as the entry spells them, because collapsing them
// into one `kind` is what blinded the interpretation gate: the payload carried
// only the open document classification, so the one caller that has to decide
// whether an entry is a document at all had nothing to decide with and asserted
// `'document'`. `kind` is I5's closed structural union and is what refuses a
// file by name; `docKind` is the open classification that picks the editor.
export interface WorkspaceDocPayload {
  content: string
  name: string
  kind: EntryKind
  docKind?: string
}

export interface WorkspaceDocuments {
  list(opts?: { search?: string; sort?: 'name' | 'modified' | 'modified_asc' }): Promise<WorkspaceDocSummary[]>
  load(id: string): Promise<WorkspaceDocPayload>
  save(id: string, input: { content: string }): Promise<void>
  rename(id: string, name: string): Promise<void>
  clone(id: string, name?: string): Promise<{ uuid: string }>
}

function openWorkspace(): string {
  const session = useWorkspaceSessionStore.getState().session
  if (!session) throw new Error('No workspace is open')
  return session.workspace
}

export class OpenWorkspaceDocumentStore implements WorkspaceDocuments {
  private readonly store: WorkspaceStore

  constructor(store: WorkspaceStore = getWorkspaceStore()) {
    this.store = store
  }

  async list(opts: { search?: string; sort?: 'name' | 'modified' | 'modified_asc' } = {}): Promise<WorkspaceDocSummary[]> {
    const workspace = openWorkspace()
    const entries = await this.store.listEntries(workspace)
    let summaries = entries
      .filter(entry => entry.kind === 'document')
      .map(entry => ({
        uuid: entry.id,
        name: entry.name,
        kind: entry.docKind,
        updated_at: new Date(entry.updatedAt ?? 0).toISOString(),
        meta: { rev: entry.rev ?? 0 },
      }))
    if (opts.search) {
      const needle = opts.search.toLowerCase()
      summaries = summaries.filter(summary => summary.name.toLowerCase().includes(needle))
    }
    summaries.sort((a, b) => {
      if (opts.sort === 'name') return a.name.localeCompare(b.name)
      if (opts.sort === 'modified_asc') return a.updated_at.localeCompare(b.updated_at)
      return b.updated_at.localeCompare(a.updated_at)
    })
    return summaries
  }

  async load(id: string): Promise<WorkspaceDocPayload> {
    const workspace = openWorkspace()
    const entry = await this.store.readEntry(workspace, id)
    // No kind filter here: a file entry addressed by a typed URL must reach the
    // gate and be refused there by name, not be turned away by this adapter with
    // a "not found" that lies about why.
    return { content: entry.text ?? '', name: entry.name, kind: entry.kind, docKind: entry.docKind }
  }

  async save(id: string, input: { content: string }): Promise<void> {
    const workspace = openWorkspace()
    const entry = await this.store.readEntry(workspace, id)
    // One record plus the whole-tree carrier write and checkpoint. The carrier
    // stays in step with the working copy, and a crash between the two writes
    // is the only way the working copy is left ahead (U7's input).
    await this.store.saveEntry(workspace, {
      id: entry.id,
      kind: 'document',
      name: entry.name,
      docKind: parseDocKind(input.content) ?? entry.docKind,
      text: input.content,
    })
  }

  async rename(id: string, name: string): Promise<void> {
    await this.store.renameEntry(openWorkspace(), id, name)
  }

  async clone(id: string, name?: string): Promise<{ uuid: string }> {
    const cloneId = await this.store.cloneEntry(openWorkspace(), id, name)
    return { uuid: cloneId }
  }
}

// Kept as a module singleton so every consumer reads the same forwarding object
// forever, exactly as the old library pair did. This one has no switchable
// delegate: the session store it reads is the delegate, and WorkspacePage
// installs it on open.
export const activeDocumentStore: WorkspaceDocuments = new OpenWorkspaceDocumentStore()
