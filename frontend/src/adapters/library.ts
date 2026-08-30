import type {
  DocumentStore, DocSummary, DocumentPayload, SaveInput, ListOptions,
  TrashAdapter, TrashDoc,
} from '@/stores/documentStore'
import { getLocalStore, getLocalTrash } from '@/stores/documentStore'

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

// Browser storage is the starting point and the fallback, and it is resolved
// HERE rather than by whichever module happens to import first. An "unset"
// state would be a hidden import-order dependency: any consumer reached before
// the wiring ran would throw, and which module that is changes with the import
// graph. There is always a library.
//
// getLocalStore/getLocalTrash are lazy singletons, so naming them costs nothing
// until something actually reads a document.
let active: LibraryTarget | null = null

function target(): LibraryTarget {
  if (!active) {
    active = {
      kind: 'browser',
      label: BROWSER_LIBRARY_LABEL,
      documents: getLocalStore(),
      trash: getLocalTrash(),
    }
  }
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
