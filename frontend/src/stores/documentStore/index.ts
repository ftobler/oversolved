export type {
  DocumentStore, DocSummary, DocumentPayload, SaveInput, ListOptions, DocMeta,
  TrashAdapter, TrashDoc,
} from './types'
export { exportBundle, importBundle, buildBundleBytes } from './bundle'
export { buildStepContent, importStepFile, stepImportLimitError } from './stepImport'
export { suggestedCloneName } from './cloneName'

// The barrel exposes types and pure helpers only. The concrete IndexedDB
// document store it used to name (getLocalStore/getLocalTrash) is no longer
// wired into the app: the browser library is the workspace seam now, and the
// old store survives only as IdbCarrier's ancestor for the contract tests.

