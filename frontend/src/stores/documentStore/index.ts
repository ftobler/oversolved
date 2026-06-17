import type { DocumentStore } from './types'
import type { Backend } from '@/config/capabilities'
import { backend } from '@/config/capabilities'
import { HttpDocumentStore } from './HttpDocumentStore'
import { IndexedDbDocumentStore } from './IndexedDbDocumentStore'

export type { DocumentStore, DocSummary, DocumentPayload, SaveInput, ListOptions, DocMeta } from './types'
export type { Backend } from '@/config/capabilities'
export { resolveBackend, hasBackend } from '@/config/capabilities'
export { HttpDocumentStore } from './HttpDocumentStore'
export { IndexedDbDocumentStore } from './IndexedDbDocumentStore'
export { exportBundle, importBundle, buildBundleBytes } from './bundle'

// Pure factory (testable without touching the env).
export function createDocumentStore(b: Backend): DocumentStore {
  return b === 'static' ? new IndexedDbDocumentStore() : new HttpDocumentStore()
}

// Boot-time singleton, chosen from the build flag.
let instance: DocumentStore | null = null

export function getDocumentStore(): DocumentStore {
  if (!instance) instance = createDocumentStore(backend)
  return instance
}
