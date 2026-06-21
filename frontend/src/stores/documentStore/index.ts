import type { DocumentStore } from './types'
import type { TrashAdapter } from '@/adapters/trash'
import { backend } from '@/config/capabilities'
import { HttpDocumentStore } from './HttpDocumentStore'
import { IndexedDbDocumentStore, IndexedDbTrashAdapter } from './IndexedDbDocumentStore'

export type { DocumentStore, DocSummary, DocumentPayload, SaveInput, ListOptions, DocMeta } from './types'
export type { Backend } from '@/config/capabilities'
export { resolveBackend, hasBackend } from '@/config/capabilities'
export { HttpDocumentStore } from './HttpDocumentStore'
export { IndexedDbDocumentStore, IndexedDbTrashAdapter } from './IndexedDbDocumentStore'
export { exportBundle, importBundle, buildBundleBytes } from './bundle'
export { copyDocument, pushDocument, moveDocument, syncAllDocuments } from './transfer'

// The two-domain model (doc-domain-move). Home is ALWAYS the local IndexedDB
// library, on BOTH builds; the server store is the additive CLOUD domain, present
// only on a server build. Login (signed-in) gating is layered on top by the
// consumer -- this seam stays free of AuthContext, it answers only the structural
// question "could this build ever have a cloud domain". Absence is a null slot.
let localInstance: DocumentStore | null = null
let cloudInstance: DocumentStore | null = null

export function getLocalStore(): DocumentStore {
  if (!localInstance) localInstance = new IndexedDbDocumentStore()
  return localInstance
}

export function getCloudStore(): DocumentStore | null {
  if (backend !== 'http') return null  // no server in this build -> no cloud domain, ever
  if (!cloudInstance) cloudInstance = new HttpDocumentStore()
  return cloudInstance
}

// The local Trash is the recover/purge face of the local IndexedDB soft delete.
// It exists on BOTH builds because the local home library always exists.
let localTrashInstance: TrashAdapter | null = null

export function getLocalTrash(): TrashAdapter {
  if (!localTrashInstance) localTrashInstance = new IndexedDbTrashAdapter()
  return localTrashInstance
}
