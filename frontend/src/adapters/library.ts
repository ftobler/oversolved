import type {
  DocumentStore, DocSummary, DocumentPayload, SaveInput, ListOptions,
  TrashAdapter, TrashDoc,
} from '@/stores/documentStore'
import { getWorkspaceStore, type WorkspaceStore, type WorkspaceSummary } from '@/workspace/store'
import type { WorkspaceEntry } from '@/workspace/types'
import { parseDocKind } from '@/workspace/kinds'
import { LOCAL_OWNER } from '@/stores/documentStore/IndexedDbDocumentStore'

// Which library the app is currently pointed at, behind a stable object.
//
// Every consumer already reads `backendBundle.documents`, and there are a
// dozen of them (editors, the assembly solver, the part picker, the export
// helper). Making the choice switchable by handing each of them a different
// store would mean threading the choice through all of them, or a context, or
// a subscription -- for a value that changes on a deliberate click and never
// mid-operation. So the bundle holds ONE object forever and that object
// forwards to whichever store is active.
//
// This is deliberately not the two-domain machinery the cloud/local split had
// (that was deleted in d4ebd6a9 for being more complex than it earned). There
// is one active library at a time, not two side by side: the sidebar switches
// between them the way it switches between Documents and Trash.
//
// The delegate pair switches together. A store and its trash are two faces of
// one library -- a delete moves a document from the first to the second -- so
// nothing may ever hold the folder's documents next to browser storage's trash.

export type LibraryKind = 'browser' | 'directory' | 'file'

export interface LibraryTarget {
  kind: LibraryKind
  label: string
  documents: DocumentStore
  trash: TrashAdapter
}

export const BROWSER_LIBRARY_LABEL = 'Browser storage'

// The browser library, re-pointed at the workspace seam in C2. Each document is
// a one-document workspace, so the old DocumentStore shape is presented by an
// adapter over WorkspaceStore: the grid, the editors and the trash keep their
// verbs, while the records underneath live in the workspace stores. This is the
// single compatibility layer; C3 deletes it when workspaces hold many documents
// and routing becomes workspace-scoped.
function toDocSummary(summary: WorkspaceSummary): DocSummary {
  return {
    uuid: summary.workspace,
    name: summary.name,
    created_at: new Date(summary.createdAt).toISOString(),
    updated_at: new Date(summary.updatedAt).toISOString(),
    is_owner: true,
    owner_username: LOCAL_OWNER,
    is_public: false,
    kind: summary.docKind,
    meta: { id: summary.workspace, rev: summary.rev ?? 0, updatedAt: summary.updatedAt, dirty: false },
  }
}

export class WorkspaceDocumentAdapter implements DocumentStore {
  private readonly workspaces: WorkspaceStore

  constructor(workspaces: WorkspaceStore = getWorkspaceStore()) {
    this.workspaces = workspaces
  }

  async list(opts: ListOptions = {}): Promise<DocSummary[]> {
    const sort = opts.sort === 'name' || opts.sort === 'modified_asc' ? opts.sort : 'modified'
    const summaries = await this.workspaces.list({ sort, search: opts.search })
    return summaries.map(toDocSummary)
  }

  async load(id: string): Promise<DocumentPayload> {
    const entry = await this.soleDocument(id)
    return {
      content: entry.text ?? '',
      name: entry.name,
      owner_username: LOCAL_OWNER,
      is_public: false,
      kind: entry.docKind,
    }
  }

  async save(id: string, input: SaveInput): Promise<void> {
    const entry = await this.soleDocument(id)
    // Content without a kind keeps the entry's previous kind: a created part
    // carries its kind as metadata and its body may still be empty. An unknown
    // kind is preserved here so the reader can refuse it by name.
    await this.workspaces.writeEntry(id, {
      id: entry.id,
      kind: 'document',
      name: entry.name,
      docKind: parseDocKind(input.content) ?? entry.docKind,
      text: input.content,
    })
    // A document save is an explicit save at this seam, so it adopts the
    // working copy as the checkpoint. A crash between the two writes is the
    // only way the working copy is left ahead, which is what the recovery
    // prompt exists to surface.
    await this.workspaces.checkpoint(id)
  }

  async remove(id: string): Promise<void> {
    await this.workspaces.trash(id)
  }

  async create(name: string): Promise<{ uuid: string }> {
    // A fresh document is a part until a save writes a different kind; the kind
    // lives on the entry, so an empty body still routes to the part editor.
    const { workspace } = await this.workspaces.create(name, { docKind: 'part' })
    return { uuid: workspace }
  }

  async rename(id: string, name: string): Promise<void> {
    await this.workspaces.rename(id, name)
  }

  async duplicate(id: string): Promise<{ uuid: string }> {
    const { workspace } = await this.workspaces.duplicate(id)
    return { uuid: workspace }
  }

  async clone(id: string, name?: string): Promise<{ uuid: string }> {
    const { workspace } = await this.workspaces.duplicate(id, name)
    return { uuid: workspace }
  }

  thumbnailUrl(_id: string): string | null {
    return null
  }

  private async soleDocument(workspace: string): Promise<WorkspaceEntry> {
    const opened = await this.workspaces.open(workspace)
    const rows = Object.entries(opened.tree.manifest.entries).filter(([, row]) => row.kind === 'document')
    if (rows.length === 0) throw new Error(`Document not found: ${workspace}`)
    const [entryId, row] = rows[0]
    return { id: entryId, kind: 'document', name: row.name, docKind: row.docKind, text: opened.tree.contents.get(entryId)?.text }
  }
}

class WorkspaceTrashAdapter implements TrashAdapter {
  private readonly workspaces: WorkspaceStore

  constructor(workspaces: WorkspaceStore = getWorkspaceStore()) {
    this.workspaces = workspaces
  }

  async list(): Promise<TrashDoc[]> {
    const summaries = await this.workspaces.list({ includeTrashed: true })
    return summaries
      .filter(summary => summary.trashedAt !== undefined)
      .sort((a, b) => (b.trashedAt ?? '').localeCompare(a.trashedAt ?? ''))  // newest deletion first
      .map(summary => ({
        uuid: summary.workspace,
        name: summary.name,
        deleted_at: summary.trashedAt ?? '',
        created_at: new Date(summary.createdAt).toISOString(),
        owner_id: 0,
        owner_username: LOCAL_OWNER,
      }))
  }

  async recover(uuid: string): Promise<void> {
    await this.workspaces.recover(uuid)
  }

  async purge(uuid: string): Promise<void> {
    await this.workspaces.purge(uuid)
  }
}

// The browser library's two faces, sharing one WorkspaceStore. Browser storage
// is the starting point and the fallback, and it is resolved HERE rather than
// by whichever module happens to import first. An "unset" state would be a
// hidden import-order dependency: any consumer reached before the wiring ran
// would throw, and which module that is changes with the import graph. There is
// always a library.
export function browserLibraryTarget(): LibraryTarget {
  return {
    kind: 'browser',
    label: BROWSER_LIBRARY_LABEL,
    documents: new WorkspaceDocumentAdapter(),
    trash: new WorkspaceTrashAdapter(),
  }
}

let active: LibraryTarget | null = null

function target(): LibraryTarget {
  if (!active) active = browserLibraryTarget()
  return active
}

export function setActiveLibrary(next: LibraryTarget): void {
  active = next
}

export function activeLibrary(): LibraryTarget {
  return target()
}

// The forwarding DocumentStore the bundle exposes. Every method is a
// pass-through: this class must never grow behaviour of its own, or the
// contract the real stores are held to would stop describing what callers see.
class ActiveDocumentStore implements DocumentStore {
  list(opts?: ListOptions): Promise<DocSummary[]> { return target().documents.list(opts) }
  load(id: string): Promise<DocumentPayload> { return target().documents.load(id) }
  save(id: string, input: SaveInput): Promise<void> { return target().documents.save(id, input) }
  remove(id: string): Promise<void> { return target().documents.remove(id) }
  create(name: string, opts?: { is_public?: boolean }): Promise<{ uuid: string }> {
    return target().documents.create(name, opts)
  }
  rename(id: string, name: string): Promise<void> { return target().documents.rename(id, name) }
  duplicate(id: string): Promise<{ uuid: string }> { return target().documents.duplicate(id) }
  clone(id: string, name?: string): Promise<{ uuid: string }> {
    return target().documents.clone(id, name)
  }
  thumbnailUrl(id: string): string | null { return target().documents.thumbnailUrl(id) }
}

class ActiveTrashAdapter implements TrashAdapter {
  list(): Promise<TrashDoc[]> { return target().trash.list() }
  recover(uuid: string): Promise<void> { return target().trash.recover(uuid) }
  purge(uuid: string): Promise<void> { return target().trash.purge(uuid) }
}

export const activeDocumentStore: DocumentStore = new ActiveDocumentStore()
export const activeTrashAdapter: TrashAdapter = new ActiveTrashAdapter()
