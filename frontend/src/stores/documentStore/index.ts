import type { DocumentStore, TrashAdapter } from './types'
import { IndexedDbDocumentStore, IndexedDbTrashAdapter } from './IndexedDbDocumentStore'

export type {
  DocumentStore, DocSummary, DocumentPayload, SaveInput, ListOptions, DocMeta,
  TrashAdapter, TrashDoc,
} from './types'
export { exportBundle, importBundle, buildBundleBytes } from './bundle'
export { buildStepContent, importStepFile, stepImportLimitError } from './stepImport'
export { suggestedCloneName } from './cloneName'

// The one document library: IndexedDB in the browser, scoped to the origin
// serving the app. Lazy singletons rather than module-level `new` so importing a
// type from this barrel does not open a database connection -- tests import the
// types constantly, and several of them install a fresh fake IDB per case.
//
// These are the only two places a concrete store is named. Everything else takes
// a `DocumentStore` / `TrashAdapter`, so pointing the app at a different store
// means editing the two lines below plus the composition root, not the callers.
let localInstance: DocumentStore | null = null

export function getLocalStore(): DocumentStore {
  if (!localInstance) localInstance = new IndexedDbDocumentStore()
  return localInstance
}

// The recover/purge face of the same IndexedDB soft delete `getLocalStore()`
// writes tombstones into. Split from the store because only the Trash view needs
// it (see the TrashAdapter port).
let localTrashInstance: TrashAdapter | null = null

export function getLocalTrash(): TrashAdapter {
  if (!localTrashInstance) localTrashInstance = new IndexedDbTrashAdapter()
  return localTrashInstance
}
